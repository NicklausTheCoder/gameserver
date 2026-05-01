// ============================================================
// game/checkers.js
// Checkers game room logic + socket handlers
// ============================================================

'use strict';

const admin = require('firebase-admin');

// ── In-memory state ───────────────────────────────────────────────────────────
const checkersGameRooms = new Map(); // roomId → CheckersGameRoom
const checkersRooms     = new Map(); // legacy rooms (old joinGame/makeMove clients)

// ── Board helpers ─────────────────────────────────────────────────────────────

function initCheckersBoard() {
  const board = Array(8).fill(null).map(() => Array(8).fill(null));
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 1) {
        if (row < 3)      board[row][col] = 'black';
        else if (row > 4) board[row][col] = 'red';
      }
    }
  }
  return board;
}

function isValidMove(board, fromRow, fromCol, toRow, toCol, playerColor) {
  const piece = board[fromRow][fromCol];
  if (!piece || !piece.includes(playerColor)) return { valid: false, capturedPiece: null };

  const isKing = piece.includes('king');
  const isRed  = piece.includes('red');
  const rowDiff = toRow - fromRow;
  const colDiff = Math.abs(toCol - fromCol);
  const isCapture = Math.abs(rowDiff) > 1;

  if (Math.abs(rowDiff) !== colDiff)              return { valid: false, capturedPiece: null };
  if (!isKing && !isCapture) {
    // Regular (non-capture) moves must go in the correct forward direction
    if (isRed  && rowDiff >= 0) return { valid: false, capturedPiece: null };
    if (!isRed && rowDiff <= 0) return { valid: false, capturedPiece: null };
  }
  if (board[toRow][toCol] !== null) return { valid: false, capturedPiece: null };

  let capturedPiece = null;
  if (Math.abs(rowDiff) > 1) {
    const rowStep = rowDiff > 0 ? 1 : -1;
    const colStep = toCol > fromCol ? 1 : -1;
    let captureCount = 0;
    let r = fromRow + rowStep;
    let c = fromCol + colStep;
    while (r !== toRow || c !== toCol) {
      const p = board[r][c];
      if (p) {
        if (p.includes(isRed ? 'black' : 'red')) { captureCount++; capturedPiece = { row: r, col: c }; }
        else return { valid: false, capturedPiece: null };
      }
      r += rowStep; c += colStep;
    }
    if (captureCount !== 1) return { valid: false, capturedPiece: null };
  }
  return { valid: true, capturedPiece };
}

function applyMove(board, fromRow, fromCol, toRow, toCol) {
  const newBoard = JSON.parse(JSON.stringify(board));
  const piece = newBoard[fromRow][fromCol];
  const rowDiff = toRow - fromRow;

  newBoard[toRow][toCol] = piece;
  newBoard[fromRow][fromCol] = null;

  let capturedPiece = null;
  if (Math.abs(rowDiff) > 1) {
    const rowStep = rowDiff > 0 ? 1 : -1;
    const colStep = toCol > fromCol ? 1 : -1;
    let r = fromRow + rowStep;
    let c = fromCol + colStep;
    while (r !== toRow || c !== toCol) {
      if (newBoard[r][c]) { capturedPiece = { row: r, col: c }; newBoard[r][c] = null; }
      r += rowStep; c += colStep;
    }
  }

  let promoted = false;
  if (piece === 'red'   && toRow === 0) { newBoard[toRow][toCol] = 'king_red';   promoted = true; }
  if (piece === 'black' && toRow === 7) { newBoard[toRow][toCol] = 'king_black'; promoted = true; }

  return { newBoard, capturedPiece, promoted };
}

function checkCheckersWin(board) {
  let red = 0, black = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.includes('red'))   red++;
      if (p && p.includes('black')) black++;
    }
  if (red   === 0) return 'black';
  if (black === 0) return 'red';
  return null;
}

// ── Game room class ───────────────────────────────────────────────────────────

class CheckersGameRoom {
  constructor(roomId) {
    this.roomId       = roomId;
    this.players      = []; // [{ socketId, uid, username, color }]
    this.board        = initCheckersBoard();
    this.currentColor = 'red'; // red always goes first
    this.active       = false;
    this.createdAt    = Date.now();
    this.drawOfferedBy = null; // uid of player who offered a draw
  }

  addPlayer(socketId, uid, username, color) {
    // Handle reconnect
    const existing = this.players.find(p => p.uid === uid);
    if (existing) {
      existing.socketId = socketId;
      console.log(`♟️ [Checkers] ${username} reconnected to ${this.roomId}`);
      return 'reconnected';
    }
    if (this.players.length >= 2) return 'full';
    this.players.push({ socketId, uid, username, color });
    console.log(`♟️ [Checkers] ${username} (${color}) joined ${this.roomId} [${this.players.length}/2]`);
    if (this.players.length === 2) this.active = true;
    return 'joined';
  }

  handleMove(socketId, move) {
    const player = this.players.find(p => p.socketId === socketId);
    if (!player)       return { ok: false, reason: 'Player not found' };
    if (!this.active)  return { ok: false, reason: 'Game not active' };
    if (player.color !== this.currentColor) return { ok: false, reason: 'Not your turn' };

    const validation = isValidMove(
      this.board,
      move.fromRow, move.fromCol,
      move.toRow,   move.toCol,
      player.color
    );
    if (!validation.valid) return { ok: false, reason: 'Invalid move' };

    const result = applyMove(this.board, move.fromRow, move.fromCol, move.toRow, move.toCol);
    this.board        = result.newBoard;
    this.currentColor = this.currentColor === 'red' ? 'black' : 'red';

    const winColor = checkCheckersWin(this.board);
    const winner   = winColor ? this.players.find(p => p.color === winColor) : null;

    return {
      ok: true,
      capturedPiece:   result.capturedPiece,
      promoted:        result.promoted,
      newCurrentColor: this.currentColor,
      winner:          winner || null,
      board:           this.board,  // ← always return authoritative board
    };
  }

  getOpponent(socketId)  { return this.players.find(p => p.socketId !== socketId) || null; }
  getPlayerByUid(uid)    { return this.players.find(p => p.uid === uid) || null; }

  async endAndPersist(winnerUid, reason) {
    this.active = false;
    try {
      const db = admin.database();

      await db.ref(`games/checkers/${this.roomId}`).update({
        winner: winnerUid, finishedAt: Date.now(),
        winReason: reason || 'normal', board: this.board, currentPlayer: this.currentColor,
      });

      await db.ref(`lobbies/${this.roomId}`).update({
        status: 'finished', winner: winnerUid, finishedAt: Date.now(),
      });

      if (winnerUid && reason !== 'resign') {
        const winningsRef = db.ref(`winningsBalance/${winnerUid}`);
        const snap        = await winningsRef.once('value');
        const current     = snap.exists() ? (snap.val().balance || 0) : 0;
        await winningsRef.update({ balance: current + 1.50, lastUpdated: new Date().toISOString() });
        await db.ref(`winnings/${winnerUid}/${this.roomId}`).set({
          amount: 1.50, game: 'checkers', lobbyId: this.roomId, awardedAt: new Date().toISOString(),
        });
        console.log(`💰 [Checkers] $1.50 awarded to ${winnerUid}`);
      }

      console.log(`🏆 [Checkers] ${this.roomId} ended — winner: ${winnerUid} (${reason})`);
    } catch (err) {
      console.error('❌ [Checkers] Failed to persist game end:', err);
    }

    setTimeout(() => checkersGameRooms.delete(this.roomId), 30_000);
  }
}

// Stale room cleanup
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of checkersGameRooms.entries()) {
    if (!room.active && (now - room.createdAt) > 60 * 60 * 1000) {
      console.log(`🧹 [Checkers] Removing stale game room: ${roomId}`);
      checkersGameRooms.delete(roomId);
    }
  }
}, 5 * 60_000);

// ── Socket handlers ───────────────────────────────────────────────────────────

function registerCheckersHandlers(io, socket) {

  // ── New checkers:* events ─────────────────────────────────────────────────

  socket.on('checkers:joinRoom', (data) => {
    const { roomId, uid, username, color } = data || {};
    if (!roomId || !uid) return;

    console.log(`♟️ [Checkers] joinRoom: ${username} (${color}) → ${roomId}`);

    if (!checkersGameRooms.has(roomId)) {
      checkersGameRooms.set(roomId, new CheckersGameRoom(roomId));
    }
    const room   = checkersGameRooms.get(roomId);
    const result = room.addPlayer(socket.id, uid, username, color);

    socket.join(roomId);

    if (result === 'full') {
      socket.emit('checkers:error', { message: 'Room is full' });
      return;
    }

    if (result === 'reconnected') {
      socket.emit('checkers:boardSync', { board: room.board, currentColor: room.currentColor });
      socket.to(roomId).emit('checkers:opponentReconnected');
      return;
    }

    socket.emit('checkers:roomJoined', { color, roomId });

    if (room.players.length === 2) {
      const [p1, p2] = room.players;
      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);
      if (s1) s1.emit('checkers:gameStart', { opponentName: p2.username, yourColor: p1.color });
      if (s2) s2.emit('checkers:gameStart', { opponentName: p1.username, yourColor: p2.color });
      console.log(`🎮 [Checkers] ${roomId} — ${p1.username}(red) vs ${p2.username}(black)`);

      // ── FIX: Send authoritative board to BOTH players so they start in sync ──
      io.to(roomId).emit('checkers:boardSync', {
        board:        room.board,
        currentColor: room.currentColor,
      });
      console.log(`🔄 [Checkers] ${roomId} — boardSync sent to both players`);
    }
  });

  socket.on('checkers:makeMove', (data) => {
    const { roomId, move } = data || {};
    if (!roomId || !move) return;

    const room = checkersGameRooms.get(roomId);
    if (!room) { socket.emit('checkers:moveRejected', { reason: 'Room not found' }); return; }

    const result = room.handleMove(socket.id, move);
    if (!result.ok) {
      // ── FIX: Send board on rejection so desynced client can resync ──
      socket.emit('checkers:moveRejected', { reason: result.reason, board: room.board });
      console.log(`❌ [Checkers] Move rejected: ${result.reason}`);
      return;
    }

    // ── FIX: Include authoritative board in confirmation to prevent desync ──
    socket.emit('checkers:moveConfirmed', {
      newCurrentColor: result.newCurrentColor,
      board:           result.board,
    });

    socket.to(roomId).emit('checkers:opponentMove', {
      fromRow: move.fromRow, fromCol: move.fromCol,
      toRow:   move.toRow,   toCol:   move.toCol,
      capturedPiece:   result.capturedPiece || null,
      piece:           move.piece,
      timestamp:       move.timestamp,
      playerUid:       move.playerUid,
      isKingPromotion: result.promoted || move.isKingPromotion || false,
      board:           result.board,         // ← authoritative board for opponent to resync
      newCurrentColor: result.newCurrentColor,
    });

    console.log(`♟️ [Checkers] ${roomId} [${move.fromRow},${move.fromCol}]→[${move.toRow},${move.toCol}] | next: ${result.newCurrentColor}`);

    if (result.winner) {
      io.to(roomId).emit('checkers:gameOver', { winnerUid: result.winner.uid, reason: 'normal' });
      room.endAndPersist(result.winner.uid, 'normal');
    }
  });

  socket.on('checkers:declareWin', (data) => {
    const { roomId, winnerUid } = data || {};
    if (!roomId || !winnerUid) return;
    const room = checkersGameRooms.get(roomId);
    if (!room || !room.active) return;
    const winColor = checkCheckersWin(room.board);
    if (!winColor) return;
    const winner = room.getPlayerByUid(winnerUid);
    if (!winner) return;
    console.log(`🏆 [Checkers] ${roomId} win declared — ${winnerUid}`);
    io.to(roomId).emit('checkers:gameOver', { winnerUid, reason: 'normal' });
    room.endAndPersist(winnerUid, 'normal');
  });

  socket.on('checkers:resign', (data) => {
    const { roomId, uid } = data || {};
    if (!roomId || !uid) return;
    const room = checkersGameRooms.get(roomId);
    if (!room || !room.active) return;
    const opponent = room.players.find(p => p.uid !== uid);
    if (!opponent) return;
    console.log(`🏳️ [Checkers] ${uid} resigned in ${roomId}`);
    io.to(roomId).emit('checkers:gameOver', { winnerUid: opponent.uid, reason: 'resign' });
    room.endAndPersist(opponent.uid, 'resign');
  });

  socket.on('checkers:inactivity', (data) => {
    const { roomId, uid } = data || {};
    if (!roomId || !uid) return;
    const room = checkersGameRooms.get(roomId);
    if (!room || !room.active) return;
    const opponent = room.players.find(p => p.uid !== uid);
    if (!opponent) return;
    console.log(`⏰ [Checkers] ${uid} timed out in ${roomId}`);
    io.to(roomId).emit('checkers:gameOver', { winnerUid: opponent.uid, reason: 'inactivity' });
    room.endAndPersist(opponent.uid, 'inactivity');
  });

  socket.on('checkers:offerDraw', (data) => {
    const { roomId, uid } = data || {};
    if (!roomId || !uid) return;
    const room = checkersGameRooms.get(roomId);
    if (!room || !room.active) return;
    room.drawOfferedBy = uid;
    // Forward the offer to the opponent
    const opponent = room.players.find(p => p.uid !== uid);
    if (!opponent) return;
    const oppSocket = io.sockets.sockets.get(opponent.socketId);
    if (oppSocket) oppSocket.emit('checkers:drawOffer');
    console.log(`🤝 [Checkers] ${uid} offered draw in ${roomId}`);
  });

  socket.on('checkers:respondDraw', (data) => {
    const { roomId, uid, accept } = data || {};
    if (!roomId || !uid) return;
    const room = checkersGameRooms.get(roomId);
    if (!room || !room.active) return;

    if (!accept) {
      room.drawOfferedBy = null;
      // Tell the offerer their draw was declined
      const offerer = room.players.find(p => p.uid !== uid);
      if (offerer) {
        const offSocket = io.sockets.sockets.get(offerer.socketId);
        if (offSocket) offSocket.emit('checkers:drawDeclined');
      }
      console.log(`❌ [Checkers] Draw declined in ${roomId}`);
      return;
    }

    // Accepted — end as draw
    room.drawOfferedBy = null;
    room.active = false;
    io.to(roomId).emit('checkers:draw');
    console.log(`🤝 [Checkers] Draw agreed in ${roomId}`);

    // Persist draw — no winnings awarded
    try {
      const db = admin.database();
      db.ref(`games/checkers/${roomId}`).update({ winner: 'draw', finishedAt: Date.now(), winReason: 'draw' });
      db.ref(`lobbies/${roomId}`).update({ status: 'finished', winner: 'draw', finishedAt: Date.now() });
    } catch (err) {
      console.error('❌ [Checkers] Failed to persist draw:', err);
    }
    setTimeout(() => checkersGameRooms.delete(roomId), 30_000);
  });

  socket.on('checkers:report', async (data) => {
    const { roomId, reporterUid, reportedUid, reason } = data || {};
    if (!roomId || !reporterUid || !reason) return;
    console.log(`🚩 [Checkers] Report in ${roomId}: ${reporterUid} reported ${reportedUid} — "${reason}"`);
    try {
      const db = admin.database();
      const reportKey = `${Date.now()}_${reporterUid.slice(0,6)}`;
      await db.ref(`reports/checkers/${roomId}/${reportKey}`).set({
        reporterUid,
        reportedUid:  reportedUid || null,
        reason,
        roomId,
        timestamp:    new Date().toISOString(),
      });
      // Ack back to reporter
      socket.emit('checkers:reportAck');
    } catch (err) {
      console.error('❌ [Checkers] Failed to store report:', err);
    }
  });

  // ── Legacy joinGame / makeMove (kept for old clients) ─────────────────────

  socket.on('joinGame', (data) => {
    const { roomId, color, isHost } = data;
    console.log('📡 [Checkers-Legacy] joinGame:', { roomId, color, isHost });

    if (!checkersRooms.has(roomId)) {
      checkersRooms.set(roomId, { players: [], board: null, currentPlayer: 'red', moves: [] });
    }
    const room = checkersRooms.get(roomId);
    room.players.push({ socketId: socket.id, color, isHost });
    socket.join(roomId);
    socket.emit('gameJoined', { success: true, gameId: roomId });
    if (room.board) socket.emit('gameStateSync', { board: room.board, currentPlayer: room.currentPlayer });
    socket.to(roomId).emit('playerJoined', { playerId: socket.id, color });
  });

  socket.on('syncGameState', (data) => {
    const { roomId, board, currentPlayer } = data;
    const room = checkersRooms.get(roomId);
    if (room) { room.board = board; room.currentPlayer = currentPlayer; }
  });

  socket.on('makeMove', (data) => {
    const { roomId, move } = data;
    const room = checkersRooms.get(roomId);

    if (!room || !room.board) { socket.emit('moveRejected', { message: 'Game not found' }); return; }

    const validation = isValidMove(room.board, move.fromRow, move.fromCol, move.toRow, move.toCol, move.playerColor);
    if (!validation.valid) { socket.emit('moveRejected', { message: 'Invalid move' }); return; }
    if (room.currentPlayer !== move.playerColor) { socket.emit('moveRejected', { message: 'Not your turn' }); return; }

    const result = applyMove(room.board, move.fromRow, move.fromCol, move.toRow, move.toCol);
    room.board = result.newBoard;
    room.currentPlayer = room.currentPlayer === 'red' ? 'black' : 'red';
    room.moves.push(move);

    const moveData = {
      fromRow: move.fromRow, fromCol: move.fromCol,
      toRow:   move.toRow,   toCol:   move.toCol,
      capturedPiece: result.capturedPiece, promoted: result.promoted,
      playerColor: move.playerColor, newBoard: room.board, currentPlayer: room.currentPlayer,
    };

    let red = 0, black = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const p = room.board[r][c];
        if (p && p.includes('red'))   red++;
        if (p && p.includes('black')) black++;
      }

    if (red   === 0) io.to(roomId).emit('gameOver', { winner: 'black', message: 'Black wins!' });
    else if (black === 0) io.to(roomId).emit('gameOver', { winner: 'red',   message: 'Red wins!' });
    else { io.to(roomId).emit('opponentMove', moveData); socket.emit('moveConfirmed', moveData); }
  });

  socket.on('requestGameState', (data) => {
    const room = checkersRooms.get(data.roomId);
    if (room && room.board) socket.emit('gameStateSync', { board: room.board, currentPlayer: room.currentPlayer });
  });
}

// ── Disconnect handler (called from main server) ──────────────────────────────

function handleCheckersDisconnect(io, socket) {
  // New game rooms
  for (const [roomId, room] of checkersGameRooms.entries()) {
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (idx !== -1) {
      const disconnectedPlayer = room.players[idx];
      console.log(`⚠️  [Checkers] ${disconnectedPlayer.username} disconnected from ${roomId}`);

      if (room.active) {
        const opponent = room.players.find(p => p.socketId !== socket.id);
        if (opponent) {
          setTimeout(async () => {
            const currentRoom = checkersGameRooms.get(roomId);
            if (!currentRoom || !currentRoom.active) return;
            const stillGone = !io.sockets.sockets.get(disconnectedPlayer.socketId);
            if (stillGone) {
              console.log(`🏆 [Checkers] Awarding win to ${opponent.uid} after disconnect`);
              io.to(roomId).emit('checkers:opponentDisconnected');
              io.to(roomId).emit('checkers:gameOver', { winnerUid: opponent.uid, reason: 'disconnect' });
              currentRoom.endAndPersist(opponent.uid, 'disconnect');
            }
          }, 10_000);
        }
      }
      break;
    }
  }

  // Legacy rooms
  for (const [roomId, room] of checkersRooms.entries()) {
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (idx !== -1) {
      room.players.splice(idx, 1);
      socket.to(roomId).emit('opponentDisconnected');
      if (room.players.length === 0) checkersRooms.delete(roomId);
      break;
    }
  }
}

module.exports = {
  checkersGameRooms,
  checkersRooms,
  registerCheckersHandlers,
  handleCheckersDisconnect,
};