// ============================================================
// utils/ping.js
// Latency / ping tracking for all game rooms
// ============================================================

'use strict';

const PING_INTERVAL_MS = 5000;
const PING_WARNING_MS  = 200;

const pendingPings = new Map(); // socketId → { sentAt, roomId }

function startPingLoop(io, ballCrushRooms, checkersGameRooms) {
  setInterval(() => {
    // Ball Crush rooms
    for (const [, room] of ballCrushRooms) {
      if (!room.active) continue;
      for (const { socketId } of room.players) {
        const s = io.sockets.sockets.get(socketId);
        if (!s) continue;
        pendingPings.set(socketId, { sentAt: Date.now(), roomId: room.roomId });
        s.emit('ping_check');
      }
    }

    // Checkers game rooms
    for (const [, room] of checkersGameRooms) {
      if (!room.active) continue;
      for (const { socketId } of room.players) {
        const s = io.sockets.sockets.get(socketId);
        if (!s) continue;
        pendingPings.set(socketId, { sentAt: Date.now(), roomId: room.roomId });
        s.emit('ping_check');
      }
    }
  }, PING_INTERVAL_MS);
}

function registerPingHandler(io, socket) {
  socket.on('pong_check', () => {
    const entry = pendingPings.get(socket.id);
    if (!entry) return;
    const rtt = Date.now() - entry.sentAt;
    pendingPings.delete(socket.id);
    if (rtt > PING_WARNING_MS) {
      console.warn(`⚠️  [Ping] ${socket.id} RTT=${rtt}ms (room=${entry.roomId})`);
      io.to(entry.roomId).emit('pingWarning', { socketId: socket.id, rtt });
    }
  });
}

module.exports = { startPingLoop, registerPingHandler };
