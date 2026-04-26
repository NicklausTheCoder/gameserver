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

  if (Math.abs(rowDiff) !== colDiff)              return { valid: false, capturedPiece: null };
  if (!isKing) {
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
        await winningsRef.update({ balance: current + 2.00, lastUpdated: new Date().toISOString() });
        await db.ref(`winnings/${winnerUid}/${this.roomId}`).set({
          amount: 2.00, game: 'checkers', lobbyId: this.roomId, awardedAt: new Date().toISOString(),
        });
        console.log(`💰 [Checkers] $2.00 awarded to ${winnerUid}`);
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
    }
  });

  socket.on('checkers:makeMove', (data) => {
    const { roomId, move } = data || {};
    if (!roomId || !move) return;

    const room = checkersGameRooms.get(roomId);
    if (!room) { socket.emit('checkers:moveRejected', { reason: 'Room not found' }); return; }

    const result = room.handleMove(socket.id, move);
    if (!result.ok) {
      socket.emit('checkers:moveRejected', { reason: result.reason });
      console.log(`❌ [Checkers] Move rejected: ${result.reason}`);
      return;
    }

    socket.emit('checkers:moveConfirmed', { newCurrentColor: result.newCurrentColor });
    socket.to(roomId).emit('checkers:opponentMove', {
      fromRow: move.fromRow, fromCol: move.fromCol,
      toRow:   move.toRow,   toCol:   move.toCol,
      capturedPiece:   result.capturedPiece || null,
      piece:           move.piece,
      timestamp:       move.timestamp,
      playerUid:       move.playerUid,
      isKingPromotion: result.promoted || move.isKingPromotion || false,
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
        if (p?.includes('red'))   red++;
        if (p?.includes('black')) black++;
      }

    if (red   === 0) io.to(roomId).emit('gameOver', { winner: 'black', message: 'Black wins!' });
    else if (black === 0) io.to(roomId).emit('gameOver', { winner: 'red',   message: 'Red wins!' });
    else { io.to(roomId).emit('opponentMove', moveData); socket.emit('moveConfirmed', moveData); }
  });

  socket.on('requestGameState', (data) => {
    const room = checkersRooms.get(data.roomId);
    if (room?.board) socket.emit('gameStateSync', { board: room.board, currentPlayer: room.currentPlayer });
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
            // If socket still shows as gone after grace period, award the win
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