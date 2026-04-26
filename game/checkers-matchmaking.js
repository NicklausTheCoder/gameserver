// ============================================================
// game/checkers-matchmaking.js
// Checkers matchmaking queue (Socket.IO)
// ============================================================

'use strict';

const admin = require('firebase-admin');

const checkersQueue = new Map(); // uid → queue entry

// ── Match logic ───────────────────────────────────────────────────────────────

function tryCheckersMatch(io) {
  if (checkersQueue.size < 2) return;

  const sorted = [...checkersQueue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  const p1 = sorted[0];
  const p2 = sorted[1];

  checkersQueue.delete(p1.uid);
  checkersQueue.delete(p2.uid);

  console.log(`✅ [Checkers MM] Matched: ${p1.username} vs ${p2.username}`);

  const lobbyId = `checkers_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  createCheckersLobbyInFirebase(lobbyId, p1, p2)
    .then(() => {
      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);

      if (s1) s1.emit('checkersMatchFound', { lobbyId, opponentDisplayName: p2.displayName });
      if (s2) s2.emit('checkersMatchFound', { lobbyId, opponentDisplayName: p1.displayName });

      console.log(`📨 [Checkers MM] matchFound sent — lobbyId=${lobbyId}`);

      if (s1 && !s2) { checkersQueue.set(p1.uid, { ...p1, joinedAt: Date.now() }); tryCheckersMatch(io); }
      if (s2 && !s1) { checkersQueue.set(p2.uid, { ...p2, joinedAt: Date.now() }); tryCheckersMatch(io); }
    })
    .catch((err) => {
      console.error('❌ [Checkers MM] Lobby creation failed — re-queuing both:', err);
      checkersQueue.set(p1.uid, p1);
      checkersQueue.set(p2.uid, p2);
    });
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

// Stale entry cleanup
function startCheckersQueueCleanup(io) {
  setInterval(() => {
    const now = Date.now();
    for (const [uid, entry] of checkersQueue.entries()) {
      const sock      = io.sockets.sockets.get(entry.socketId);
      const isGone    = !sock || !sock.connected;
      const isExpired = now - entry.joinedAt > 3 * 60_000;

      if (isGone || isExpired) {
        console.log(`🧹 [Checkers MM] Removing stale queue entry for ${uid}`);
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
