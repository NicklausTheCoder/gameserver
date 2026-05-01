// ============================================================
// game/checkers-matchmaking.js
// Checkers matchmaking queue (Socket.IO)
// ============================================================

'use strict';

const admin = require('firebase-admin');

const checkersQueue = new Map(); // uid → queue entry
let   isMatching    = false;     // mutex — prevents concurrent match attempts

// ── Match logic ───────────────────────────────────────────────────────────────

async function tryCheckersMatch(io) {
  // ── LOCK: only one match attempt at a time ──────────────────────────────────
  // Node.js is single-threaded so the synchronous part (read + delete) is
  // atomic, but the async Firebase write is not. The lock ensures a second
  // caller waits until the first is fully done before trying again.
  if (isMatching) return;
  if (checkersQueue.size < 2) return;

  isMatching = true;

  try {
    // Pick the two longest-waiting players
    const sorted = [...checkersQueue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const p1 = sorted[0];
    const p2 = sorted[1];

    // ── Remove BEFORE the async call so no other invocation can pick them ──
    checkersQueue.delete(p1.uid);
    checkersQueue.delete(p2.uid);

    // Verify both sockets are still alive BEFORE creating the lobby
    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);

    if (!s1 || !s1.connected) {
      console.log(`⚠️  [Checkers MM] ${p1.username} disconnected before match — re-queuing ${p2.username}`);
      if (s2 && s2.connected) checkersQueue.set(p2.uid, { ...p2, joinedAt: Date.now() });
      return; // release lock in finally, then retry below
    }
    if (!s2 || !s2.connected) {
      console.log(`⚠️  [Checkers MM] ${p2.username} disconnected before match — re-queuing ${p1.username}`);
      if (s1 && s1.connected) checkersQueue.set(p1.uid, { ...p1, joinedAt: Date.now() });
      return;
    }

    console.log(`✅ [Checkers MM] Matched: ${p1.username} vs ${p2.username}`);

    const lobbyId = `checkers_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // ── Create lobby — if this fails, re-queue both ─────────────────────────
    try {
      await createCheckersLobbyInFirebase(lobbyId, p1, p2);
    } catch (err) {
      console.error('❌ [Checkers MM] Lobby creation failed — re-queuing both:', err);
      // Only re-queue if their sockets are still alive
      if (s1.connected) checkersQueue.set(p1.uid, { ...p1, joinedAt: Date.now() });
      if (s2.connected) checkersQueue.set(p2.uid, { ...p2, joinedAt: Date.now() });
      return;
    }

    // ── Notify both players ──────────────────────────────────────────────────
    // Re-check sockets — they could have dropped during the Firebase write
    const still1 = io.sockets.sockets.get(p1.socketId);
    const still2 = io.sockets.sockets.get(p2.socketId);

    if (still1 && still1.connected) {
      still1.emit('checkersMatchFound', { lobbyId, opponentDisplayName: p2.displayName });
    } else {
      console.log(`⚠️  [Checkers MM] ${p1.username} dropped after lobby created — lobby ${lobbyId} may be orphaned`);
    }
    if (still2 && still2.connected) {
      still2.emit('checkersMatchFound', { lobbyId, opponentDisplayName: p1.displayName });
    } else {
      console.log(`⚠️  [Checkers MM] ${p2.username} dropped after lobby created — lobby ${lobbyId} may be orphaned`);
    }

    console.log(`📨 [Checkers MM] matchFound sent — lobbyId=${lobbyId}`);

  } finally {
    // ── Always release the lock, then attempt another match if queue allows ──
    isMatching = false;
    if (checkersQueue.size >= 2) {
      // Defer so the call stack unwinds before we try again — prevents stack overflow
      setImmediate(() => tryCheckersMatch(io));
    }
  }
}

async function createCheckersLobbyInFirebase(lobbyId, p1, p2) {
  const db = admin.database();

  await db.ref(`lobbies/${lobbyId}`).set({
    id: lobbyId, gameId: 'checkers', status: 'waiting',
    players: {
      [p1.uid]: { uid: p1.uid, username: p1.username, displayName: p1.displayName, avatar: p1.avatar, isReady: false, color: 'red'   },
      [p2.uid]: { uid: p2.uid, username: p2.username, displayName: p2.displayName, avatar: p2.avatar, isReady: false, color: 'black' },
    },
    playerIds: [p1.uid, p2.uid], createdAt: Date.now(), maxPlayers: 2,
  });

  await Promise.all([
    db.ref(`online/${p1.uid}`).update({ inQueue: false, inGame: true, lastSeen: Date.now() }),
    db.ref(`online/${p2.uid}`).update({ inQueue: false, inGame: true, lastSeen: Date.now() }),
    db.ref(`matches/${p1.uid}`).remove(),
    db.ref(`matches/${p2.uid}`).remove(),
  ]);

  console.log(`🏁 [Checkers MM] Lobby created: ${lobbyId}`);
}

// ── Stale entry cleanup ───────────────────────────────────────────────────────

function startCheckersQueueCleanup(io) {
  setInterval(() => {
    const now = Date.now();
    for (const [uid, entry] of checkersQueue.entries()) {
      const sock      = io.sockets.sockets.get(entry.socketId);
      const isGone    = !sock || !sock.connected;
      const isExpired = now - entry.joinedAt > 3 * 60_000;

      if (isGone || isExpired) {
        console.log(`🧹 [Checkers MM] Removing stale queue entry for ${uid} (gone=${isGone} expired=${isExpired})`);
        checkersQueue.delete(uid);
        if (!isGone && isExpired) sock.emit('checkersMatchmakingTimeout');
      }
    }
  }, 15_000);
}

// ── Socket handlers ───────────────────────────────────────────────────────────

function registerCheckersMatchmakingHandlers(io, socket) {

  socket.on('joinCheckersMatchmaking', (data) => {
    const { uid, username, displayName, avatar } = data || {};
    if (!uid) return;

    // If already in queue (e.g. duplicate join), update socket id
    const existing = checkersQueue.get(uid);
    if (existing) {
      existing.socketId = socket.id;
      console.log(`♟️ [Checkers MM] ${username} already in queue — updated socket`);
      socket.emit('checkersMatchmakingJoined', { position: checkersQueue.size });
      return;
    }

    console.log(`♟️ [Checkers MM] ${username} (${uid}) joining queue via ${socket.id}`);

    checkersQueue.set(uid, {
      socketId:    socket.id,
      uid,
      username,
      displayName: displayName || username,
      avatar:      avatar      || 'default',
      joinedAt:    Date.now(),
    });

    socket.emit('checkersMatchmakingJoined', { position: checkersQueue.size });
    console.log(`📋 [Checkers MM] Queue size: ${checkersQueue.size}`);

    tryCheckersMatch(io);
  });

  socket.on('leaveCheckersMatchmaking', (data) => {
    const { uid } = data || {};
    if (uid && checkersQueue.delete(uid)) {
      console.log(`🚪 [Checkers MM] ${uid} left queue. Size: ${checkersQueue.size}`);
    }
    socket.emit('checkersMatchmakingLeft');
  });
}

// ── Disconnect handler (called from main server) ──────────────────────────────

function handleCheckersQueueDisconnect(socket) {
  for (const [uid, entry] of checkersQueue.entries()) {
    if (entry.socketId === socket.id) {
      checkersQueue.delete(uid);
      console.log(`🔌 [Checkers MM] ${uid} disconnected — removed from queue. Size: ${checkersQueue.size}`);
      break;
    }
  }
}

module.exports = {
  checkersQueue,
  registerCheckersMatchmakingHandlers,
  handleCheckersQueueDisconnect,
  startCheckersQueueCleanup,
};