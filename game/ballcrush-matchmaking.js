// ============================================================
// game/ballcrush-matchmaking.js
// Ball Crush matchmaking queue (Socket.IO)
// ============================================================

'use strict';

const admin = require('firebase-admin');

const matchmakingQueue = new Map(); // uid → queue entry

// ── Match logic ───────────────────────────────────────────────────────────────

function tryMatch(io) {
  if (matchmakingQueue.size < 2) return;

  const sorted = [...matchmakingQueue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  const p1 = sorted[0];
  const p2 = sorted[1];

  matchmakingQueue.delete(p1.uid);
  matchmakingQueue.delete(p2.uid);

  console.log(`✅ [Ball Crush MM] Matched: ${p1.username} vs ${p2.username}`);

  const lobbyId = `ballcrush_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  createLobbyInFirebase(lobbyId, p1, p2)
    .then(() => {
      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);

      if (s1) s1.emit('matchFound', { lobbyId, opponentDisplayName: p2.displayName });
      if (s2) s2.emit('matchFound', { lobbyId, opponentDisplayName: p1.displayName });

      console.log(`📨 [Ball Crush MM] matchFound sent — lobbyId=${lobbyId}`);

      // Re-queue survivor if one socket dropped between match and emit
      if (s1 && !s2) { matchmakingQueue.set(p1.uid, { ...p1, joinedAt: Date.now() }); tryMatch(io); }
      if (s2 && !s1) { matchmakingQueue.set(p2.uid, { ...p2, joinedAt: Date.now() }); tryMatch(io); }
    })
    .catch((err) => {
      console.error('❌ [Ball Crush MM] Lobby creation failed — re-queuing both:', err);
      matchmakingQueue.set(p1.uid, p1);
      matchmakingQueue.set(p2.uid, p2);
    });
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

// Stale entry cleanup (disconnected or timed-out players)
function startMatchmakingCleanup(io) {
  setInterval(() => {
    const now = Date.now();
    for (const [uid, entry] of matchmakingQueue.entries()) {
      const sock      = io.sockets.sockets.get(entry.socketId);
      const isGone    = !sock || !sock.connected;
      const isExpired = now - entry.joinedAt > 3 * 60_000;

      if (isGone || isExpired) {
        console.log(`🧹 [Ball Crush MM] Removing stale entry for ${uid}`);
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
