// ============================================================
// utils/ping.js
// Latency / ping tracking for all game rooms
// ============================================================

'use strict';

const PING_INTERVAL_MS   = 8000;  // ping every 8s (was 5s — less aggressive)
const PING_WARNING_MS    = 300;   // show warning indicator above this
const PING_KICK_MS       = 600;   // kick threshold (was 400 — too tight for Render)
const PING_KICK_STRIKES  = 5;     // consecutive bad pings before kick (was 3)
const PING_TIMEOUT_MS    = 10000; // no pong in 10s = strike (was 8s)
const PING_GRACE_MS      = 15000; // don't kick during first 15s of game (cold start)

const pendingPings   = new Map(); // socketId → { sentAt, roomId, game, startTime }
const pingStrikes    = new Map(); // socketId → consecutive bad ping count
const pingTimeouts   = new Map(); // socketId → timeout handle

function startPingLoop(io, ballCrushRooms, checkersGameRooms) {
  setInterval(() => {
    const now = Date.now();

    // ── Ball Crush rooms ─────────────────────────────────────────────────────
    for (const [, room] of ballCrushRooms) {
      if (!room.active) continue;
      for (const { socketId } of room.players) {
        const s = io.sockets.sockets.get(socketId);
        if (!s) continue;
        if (pingTimeouts.has(socketId)) clearTimeout(pingTimeouts.get(socketId));
        pendingPings.set(socketId, { sentAt: now, roomId: room.roomId, game: 'ballcrush', startTime: room.startTime || now });
        s.emit('ping_check');
        const t = setTimeout(() => {
          if (pendingPings.has(socketId)) {
            pendingPings.delete(socketId);
            console.warn(`⏱️  [Ping] ${socketId} no pong in ${PING_TIMEOUT_MS}ms`);
            handleHighPing(io, socketId, PING_TIMEOUT_MS, ballCrushRooms, checkersGameRooms);
          }
        }, PING_TIMEOUT_MS);
        pingTimeouts.set(socketId, t);
      }
    }

    // ── Checkers rooms ───────────────────────────────────────────────────────
    for (const [, room] of checkersGameRooms) {
      if (!room.active) continue;
      for (const { socketId } of room.players) {
        const s = io.sockets.sockets.get(socketId);
        if (!s) continue;
        if (pingTimeouts.has(socketId)) clearTimeout(pingTimeouts.get(socketId));
        pendingPings.set(socketId, { sentAt: now, roomId: room.roomId, game: 'checkers', startTime: room.createdAt || now });
        s.emit('ping_check');
        const t = setTimeout(() => {
          if (pendingPings.has(socketId)) {
            pendingPings.delete(socketId);
            console.warn(`⏱️  [Ping] ${socketId} no pong in ${PING_TIMEOUT_MS}ms`);
            handleHighPing(io, socketId, PING_TIMEOUT_MS, ballCrushRooms, checkersGameRooms);
          }
        }, PING_TIMEOUT_MS);
        pingTimeouts.set(socketId, t);
      }
    }
  }, PING_INTERVAL_MS);
}

// ── Pong handler ──────────────────────────────────────────────────────────────

function registerPingHandler(io, socket, ballCrushRooms, checkersGameRooms) {
  socket.on('pong_check', () => {
    const entry = pendingPings.get(socket.id);
    if (!entry) return;

    if (pingTimeouts.has(socket.id)) {
      clearTimeout(pingTimeouts.get(socket.id));
      pingTimeouts.delete(socket.id);
    }

    const rtt = Date.now() - entry.sentAt;
    pendingPings.delete(socket.id);

    // Always send RTT back so clients can show ping indicator
    // Send as 'pingUpdate' for good pings, 'pingWarning' only when bad
    if (rtt > PING_WARNING_MS) {
      io.to(entry.roomId).emit('pingWarning', { socketId: socket.id, rtt });
    } else {
      // Just tell the socket itself its own good ping (no need to broadcast)
      socket.emit('pingUpdate', { rtt });
    }

    if (rtt > PING_KICK_MS) {
      handleHighPing(io, socket.id, rtt, ballCrushRooms, checkersGameRooms);
    } else {
      // Good ping — reset strikes
      if (pingStrikes.has(socket.id)) {
        console.log(`✅ [Ping] ${socket.id} recovered (RTT=${rtt}ms) — strikes reset`);
        pingStrikes.delete(socket.id);
      }
    }
  });
}

// ── High ping logic ───────────────────────────────────────────────────────────

function handleHighPing(io, socketId, rtt, ballCrushRooms, checkersGameRooms) {
  const { room, game } = findRoom(socketId, ballCrushRooms, checkersGameRooms);
  if (!room) return;

  // ── Grace period: don't kick during first PING_GRACE_MS of a game ────────
  // This prevents cold-start Render latency from causing false kicks.
  const roomAge = Date.now() - (room.startTime || room.createdAt || Date.now());
  if (roomAge < PING_GRACE_MS) {
    console.log(`⏳ [Ping] ${socketId} RTT=${rtt}ms but in grace period (${Math.round(roomAge/1000)}s < ${PING_GRACE_MS/1000}s) — ignoring`);
    return;
  }

  const strikes = (pingStrikes.get(socketId) || 0) + 1;
  pingStrikes.set(socketId, strikes);

  console.warn(`⚠️  [Ping] ${socketId} RTT=${rtt}ms — strike ${strikes}/${PING_KICK_STRIKES}`);

  const lagSocket  = io.sockets.sockets.get(socketId);
  const remaining  = PING_KICK_STRIKES - strikes;

  if (lagSocket) {
    lagSocket.emit('pingKickWarning', {
      rtt, strikes, maxStrikes: PING_KICK_STRIKES, remaining,
      message: remaining > 0
        ? `High ping (${rtt}ms). ${remaining} warning${remaining === 1 ? '' : 's'} before disconnect.`
        : `Disconnecting due to sustained high ping (${rtt}ms).`,
    });
  }

  if (strikes >= PING_KICK_STRIKES) {
    pingStrikes.delete(socketId);
    kickForHighPing(io, socketId, rtt, room, game);
  }
}

// ── Force disconnect + award win ─────────────────────────────────────────────

async function kickForHighPing(io, socketId, rtt, room, game) {
  if (!room.active) return;

  const kicked   = room.players.find(p => p.socketId === socketId);
  const survivor = room.players.find(p => p.socketId !== socketId);

  if (!kicked || !survivor) return;

  console.log(`🔌 [Ping] Kicking ${kicked.username} (RTT=${rtt}ms) — awarding win to ${survivor.username}`);

  const kickedSocket = io.sockets.sockets.get(socketId);
  if (kickedSocket) {
    kickedSocket.emit('kickedForPing', {
      rtt,
      message: `You were disconnected due to sustained high ping (${rtt}ms). Your opponent has been awarded the win.`,
    });
  }

  io.to(room.roomId).emit('opponentKickedForPing', { kickedUsername: kicked.username, rtt });

  if (game === 'ballcrush') {
    await room.endGame(survivor.role);
  } else if (game === 'checkers') {
    io.to(room.roomId).emit('checkers:gameOver', { winnerUid: survivor.uid, reason: 'disconnect' });
    await room.endAndPersist(survivor.uid, 'pingkick');
  }

  if (kickedSocket) kickedSocket.disconnect(true);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findRoom(socketId, ballCrushRooms, checkersGameRooms) {
  for (const [, room] of ballCrushRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { room, game: 'ballcrush' };
  }
  for (const [, room] of checkersGameRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { room, game: 'checkers' };
  }
  return { room: null, game: null };
}

function cleanupSocket(socketId) {
  pendingPings.delete(socketId);
  pingStrikes.delete(socketId);
  if (pingTimeouts.has(socketId)) {
    clearTimeout(pingTimeouts.get(socketId));
    pingTimeouts.delete(socketId);
  }
}

module.exports = { startPingLoop, registerPingHandler, cleanupSocket };