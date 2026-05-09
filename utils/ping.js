// ============================================================
// utils/ping.js
// Latency / ping tracking for all game rooms
// ============================================================

'use strict';

const PING_INTERVAL_MS   = 5000;  // ping every 5s
const PING_WARNING_MS    = 250;   // warn above this
const PING_KICK_MS       = 400;   // kick threshold
const PING_KICK_STRIKES  = 3;     // consecutive bad pings before kick
const PING_TIMEOUT_MS    = 8000;  // if no pong in 8s, treat as infinite ping

const pendingPings   = new Map(); // socketId → { sentAt, roomId }
const pingStrikes    = new Map(); // socketId → consecutive bad ping count
const pingTimeouts   = new Map(); // socketId → timeout handle (for no-pong detection)

function startPingLoop(io, ballCrushRooms, checkersGameRooms) {
  setInterval(() => {
    const now = Date.now();

    // ── Ball Crush rooms ─────────────────────────────────────────────────────
    for (const [, room] of ballCrushRooms) {
      if (!room.active) continue;
      for (const { socketId } of room.players) {
        const s = io.sockets.sockets.get(socketId);
        if (!s) continue;

        // Cancel any existing timeout for this socket
        if (pingTimeouts.has(socketId)) {
          clearTimeout(pingTimeouts.get(socketId));
        }

        pendingPings.set(socketId, { sentAt: now, roomId: room.roomId, game: 'ballcrush' });
        s.emit('ping_check');

        // If no pong within PING_TIMEOUT_MS, treat as infinite ping
        const t = setTimeout(() => {
          if (pendingPings.has(socketId)) {
            pendingPings.delete(socketId);
            console.warn(`⏱️  [Ping] ${socketId} no pong in ${PING_TIMEOUT_MS}ms — counting as strike`);
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

        if (pingTimeouts.has(socketId)) {
          clearTimeout(pingTimeouts.get(socketId));
        }

        pendingPings.set(socketId, { sentAt: now, roomId: room.roomId, game: 'checkers' });
        s.emit('ping_check');

        const t = setTimeout(() => {
          if (pendingPings.has(socketId)) {
            pendingPings.delete(socketId);
            console.warn(`⏱️  [Ping] ${socketId} no pong — counting as strike`);
            handleHighPing(io, socketId, PING_TIMEOUT_MS, ballCrushRooms, checkersGameRooms);
          }
        }, PING_TIMEOUT_MS);
        pingTimeouts.set(socketId, t);
      }
    }
  }, PING_INTERVAL_MS);
}

// ── Core handler called when a pong arrives ───────────────────────────────────

function registerPingHandler(io, socket, ballCrushRooms, checkersGameRooms) {
  socket.on('pong_check', () => {
    const entry = pendingPings.get(socket.id);
    if (!entry) return;

    // Cancel the no-pong timeout
    if (pingTimeouts.has(socket.id)) {
      clearTimeout(pingTimeouts.get(socket.id));
      pingTimeouts.delete(socket.id);
    }

    const rtt = Date.now() - entry.sentAt;
    pendingPings.delete(socket.id);

    // Always broadcast RTT so clients can show ping indicator
    io.to(entry.roomId).emit('pingWarning', { socketId: socket.id, rtt });

    if (rtt > PING_KICK_MS) {
      handleHighPing(io, socket.id, rtt, ballCrushRooms, checkersGameRooms);
    } else {
      // Good ping — reset strike counter
      if (pingStrikes.has(socket.id)) {
        console.log(`✅ [Ping] ${socket.id} recovered (RTT=${rtt}ms) — strikes reset`);
        pingStrikes.delete(socket.id);
      }
    }
  });
}

// ── High ping logic ───────────────────────────────────────────────────────────

function handleHighPing(io, socketId, rtt, ballCrushRooms, checkersGameRooms) {
  const strikes = (pingStrikes.get(socketId) || 0) + 1;
  pingStrikes.set(socketId, strikes);

  console.warn(`⚠️  [Ping] ${socketId} RTT=${rtt}ms — strike ${strikes}/${PING_KICK_STRIKES}`);

  // Find which room this socket is in
  const { room, game } = findRoom(socketId, ballCrushRooms, checkersGameRooms);
  if (!room) return;

  // Warn the lagging player how many strikes they have left
  const lagSocket = io.sockets.sockets.get(socketId);
  const remaining = PING_KICK_STRIKES - strikes;

  if (lagSocket) {
    lagSocket.emit('pingKickWarning', {
      rtt,
      strikes,
      maxStrikes: PING_KICK_STRIKES,
      remaining,
      message: remaining > 0
        ? `High ping (${rtt}ms). ${remaining} warning${remaining === 1 ? '' : 's'} before disconnect.`
        : `Disconnecting due to high ping (${rtt}ms).`,
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

  const kickedPlayer   = room.players.find(p => p.socketId === socketId);
  const survivorPlayer = room.players.find(p => p.socketId !== socketId);

  if (!kickedPlayer || !survivorPlayer) return;

  console.log(`🔌 [Ping] Kicking ${kickedPlayer.username} (RTT=${rtt}ms) from ${room.roomId} — awarding win to ${survivorPlayer.username}`);

  // Tell the kicked player why
  const kickedSocket = io.sockets.sockets.get(socketId);
  if (kickedSocket) {
    kickedSocket.emit('kickedForPing', {
      rtt,
      message: `You were disconnected due to sustained high ping (${rtt}ms). Your opponent has been awarded the win.`,
    });
  }

  // Tell the room (both players) what happened — survivor sees win screen
  io.to(room.roomId).emit('opponentKickedForPing', {
    kickedUsername: kickedPlayer.username,
    rtt,
  });

  // Award win through the existing endGame / endAndPersist path
  if (game === 'ballcrush') {
    await room.endGame(survivorPlayer.role);
  } else if (game === 'checkers') {
    io.to(room.roomId).emit('checkers:gameOver', {
      winnerUid: survivorPlayer.uid,
      reason:    'disconnect',
    });
    await room.endAndPersist(survivorPlayer.uid, 'pingkick');
  }

  // Force-disconnect the socket
  if (kickedSocket) {
    kickedSocket.disconnect(true);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findRoom(socketId, ballCrushRooms, checkersGameRooms) {
  for (const [, room] of ballCrushRooms) {
    if (room.players.some(p => p.socketId === socketId)) {
      return { room, game: 'ballcrush' };
    }
  }
  for (const [, room] of checkersGameRooms) {
    if (room.players.some(p => p.socketId === socketId)) {
      return { room, game: 'checkers' };
    }
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

module.exports = {
  startPingLoop,
  registerPingHandler,
  cleanupSocket,
};