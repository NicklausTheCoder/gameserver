// ============================================================
// game/ballcrush-matchmaking.js
// Ball Crush matchmaking queue (Socket.IO)
// ============================================================

'use strict';

const admin = require('firebase-admin');

const matchmakingQueue = new Map(); // uid → queue entry
let   isMatching       = false;     // mutex — prevents concurrent match attempts

// ── Match logic ───────────────────────────────────────────────────────────────

async function tryMatch(io) {
  // ── LOCK ────────────────────────────────────────────────────────────────────
  // Node.js is single-threaded so the synchronous read+delete is atomic,
  // but the async Firebase write is not. The lock ensures a second caller
  // waits until the first fully resolves before attempting another match.
  if (isMatching) return;
  if (matchmakingQueue.size < 2) return;

  isMatching = true;

  try {
    const sorted = [...matchmakingQueue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const p1 = sorted[0];
    const p2 = sorted[1];

    // ── Remove BEFORE async call so no other invocation can pick them ─────────
    matchmakingQueue.delete(p1.uid);
    matchmakingQueue.delete(p2.uid);

    // ── Verify both sockets still alive BEFORE creating the lobby ─────────────
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);

    if (!s1 || !s1.connected) {
      console.log(`⚠️  [Ball Crush MM] ${p1.username} disconnected before match — re-queuing ${p2.username}`);
      if (s2 && s2.connected) matchmakingQueue.set(p2.uid, { ...p2, joinedAt: Date.now() });
      return;
    }
    if (!s2 || !s2.connected) {
      console.log(`⚠️  [Ball Crush MM] ${p2.username} disconnected before match — re-queuing ${p1.username}`);
      if (s1 && s1.connected) matchmakingQueue.set(p1.uid, { ...p1, joinedAt: Date.now() });
      return;
    }

    console.log(`✅ [Ball Crush MM] Matched: ${p1.username} vs ${p2.username}`);

    const lobbyId = `ballcrush_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // ── Create lobby — re-queue both if this fails ─────────────────────────────
    try {
      await createLobbyInFirebase(lobbyId, p1, p2);
    } catch (err) {
      console.error('❌ [Ball Crush MM] Lobby creation failed — re-queuing both:', err);
      if (s1.connected) matchmakingQueue.set(p1.uid, { ...p1, joinedAt: Date.now() });
      if (s2.connected) matchmakingQueue.set(p2.uid, { ...p2, joinedAt: Date.now() });
      return;
    }

    // ── Notify both — re-check sockets after the async Firebase write ──────────
    const still1 = io.sockets.sockets.get(p1.socketId);
    const still2 = io.sockets.sockets.get(p2.socketId);

    if (still1 && still1.connected) {
      still1.emit('matchFound', { lobbyId, opponentDisplayName: p2.displayName });
    } else {
      console.log(`⚠️  [Ball Crush MM] ${p1.username} dropped after lobby created — ${lobbyId} may be orphaned`);
    }
    if (still2 && still2.connected) {
      still2.emit('matchFound', { lobbyId, opponentDisplayName: p1.displayName });
    } else {
      console.log(`⚠️  [Ball Crush MM] ${p2.username} dropped after lobby created — ${lobbyId} may be orphaned`);
    }

    console.log(`📨 [Ball Crush MM] matchFound sent — lobbyId=${lobbyId}`);

  } finally {
    // ── Always release lock, then attempt another match if queue allows ────────
    isMatching = false;
    if (matchmakingQueue.size >= 2) {
      setImmediate(() => tryMatch(io));
    }
  }
}

async function createLobbyInFirebase(lobbyId, p1, p2) {
  const db = admin.database();

  await db.ref(`lobbies/${lobbyId}`).set({
    id: lobbyId, gameId: 'ball-crush', status: 'waiting',
    players: {
      [p1.uid]: { uid: p1.uid, username: p1.username, displayName: p1.displayName, avatar: p1.avatar, health: 5, position: { x: 180, y: 550 }, isReady: false, score: 0 },
      [p2.uid]: { uid: p2.uid, username: p2.username, displayName: p2.displayName, avatar: p2.avatar, health: 5, position: { x: 180, y: 50  }, isReady: false, score: 0 },
    },
    playerIds: [p1.uid, p2.uid], createdAt: Date.now(), maxPlayers: 2,
  });

  await Promise.all([
    db.ref(`online/${p1.uid}`).update({ inQueue: false, inGame: true, lastSeen: Date.now() }),
    db.ref(`online/${p2.uid}`).update({ inQueue: false, inGame: true, lastSeen: Date.now() }),
    db.ref(`matches/${p1.uid}`).remove(),
    db.ref(`matches/${p2.uid}`).remove(),
  ]);

  console.log(`🏰 [Ball Crush MM] Lobby written to Firebase: ${lobbyId}`);
}

// ── Stale entry cleanup ───────────────────────────────────────────────────────

function startMatchmakingCleanup(io) {
  setInterval(() => {
    const now = Date.now();
    for (const [uid, entry] of matchmakingQueue.entries()) {
      const sock      = io.sockets.sockets.get(entry.socketId);
      const isGone    = !sock || !sock.connected;
      const isExpired = now - entry.joinedAt > 3 * 60_000;

      if (isGone || isExpired) {
        console.log(`🧹 [Ball Crush MM] Removing stale entry for ${uid} (gone=${isGone} expired=${isExpired})`);
        matchmakingQueue.delete(uid);
        if (!isGone && isExpired) sock.emit('matchmakingTimeout');
      }
    }
  }, 15_000);
}

// ── Socket handlers ───────────────────────────────────────────────────────────

function registerBallCrushMatchmakingHandlers(io, socket) {

  socket.on('joinMatchmaking', (data) => {
    const { uid, username, displayName, avatar } = data || {};
    if (!uid) { console.warn('⚠️  [Ball Crush MM] joinMatchmaking with no uid — ignoring'); return; }

    // ── Duplicate join guard ──────────────────────────────────────────────────
    // If same uid joins again (reconnect / double-tap), just update socket id
    const existing = matchmakingQueue.get(uid);
    if (existing) {
      existing.socketId = socket.id;
      console.log(`♻️  [Ball Crush MM] ${username} already in queue — updated socket`);
      socket.emit('matchmakingJoined', { position: matchmakingQueue.size });
      return;
    }

    console.log(`🎮 [Ball Crush MM] ${username} (${uid}) joining queue via ${socket.id}`);

    matchmakingQueue.set(uid, {
      socketId:    socket.id,
      uid,
      username,
      displayName: displayName || username,
      avatar:      avatar      || 'default',
      joinedAt:    Date.now(),
    });

    socket.emit('matchmakingJoined', { position: matchmakingQueue.size });
    console.log(`📋 [Ball Crush MM] Queue size: ${matchmakingQueue.size}`);

    tryMatch(io);
  });

  socket.on('leaveMatchmaking', (data) => {
    const { uid } = data || {};
    if (uid && matchmakingQueue.delete(uid)) {
      console.log(`🚪 [Ball Crush MM] ${uid} left queue. Size: ${matchmakingQueue.size}`);
    }
    socket.emit('matchmakingLeft');
  });
}

// ── Disconnect handler ────────────────────────────────────────────────────────

function handleBallCrushMatchmakingDisconnect(socket) {
  for (const [uid, entry] of matchmakingQueue.entries()) {
    if (entry.socketId === socket.id) {
      matchmakingQueue.delete(uid);
      console.log(`🔌 [Ball Crush MM] ${uid} disconnected — removed from queue. Size: ${matchmakingQueue.size}`);
      break;
    }
  }
}

module.exports = {
  matchmakingQueue,
  registerBallCrushMatchmakingHandlers,
  handleBallCrushMatchmakingDisconnect,
  startMatchmakingCleanup,
};
