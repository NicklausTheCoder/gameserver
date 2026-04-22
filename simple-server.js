// ============================================================
// simple-server.js  –  Game Server
// Handles:
//   1. Checkers (existing logic – unchanged)
//   2. Ball Crush (full server-side game loop + matchmaking)
//   3. Payment routes (Stripe, PayNow, PayPal – unchanged)
// ============================================================

require('dotenv').config();
console.log('Gateway mode:', process.env.PAYMENT_GATEWAY);

// ── Firebase ──────────────────────────────────────────────────────────────────
const admin = require('firebase-admin');
const serviceAccount = require('./firebase.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://wintapgames-31286-default-rtdb.firebaseio.com',
});

// ── Express / Socket.IO ───────────────────────────────────────────────────────
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), message: 'Server is running' });
});

// ============================================================
// SECTION 1 – CHECKERS (unchanged)
// ============================================================

const checkersRooms = new Map();

function isValidMove(board, fromRow, fromCol, toRow, toCol, playerColor) {
  const piece = board[fromRow][fromCol];
  if (!piece || !piece.includes(playerColor)) return { valid: false, capturedPiece: null };

  const isKing = piece.includes('king');
  const isRed = piece.includes('red');
  const rowDiff = toRow - fromRow;
  const colDiff = Math.abs(toCol - fromCol);

  if (Math.abs(rowDiff) !== colDiff) return { valid: false, capturedPiece: null };
  if (!isKing) {
    if (isRed && rowDiff >= 0) return { valid: false, capturedPiece: null };
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
  if (piece === 'red' && toRow === 0) { newBoard[toRow][toCol] = 'king_red'; promoted = true; }
  else if (piece === 'black' && toRow === 7) { newBoard[toRow][toCol] = 'king_black'; promoted = true; }

  return { newBoard, capturedPiece, promoted };
}

// ============================================================
// SECTION 2 – BALL CRUSH MATCHMAKING
// ============================================================
//
// In-memory queue — uid → entry object.
// Node.js is single-threaded so tryMatch() is inherently atomic.
// No Firebase transactions, no distributed locks, no race conditions.

const matchmakingQueue = new Map();

function tryMatch() {
  if (matchmakingQueue.size < 2) return;

  const sorted = [...matchmakingQueue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  const p1 = sorted[0];
  const p2 = sorted[1];

  // Remove both BEFORE any async work — atomic in Node's event loop
  matchmakingQueue.delete(p1.uid);
  matchmakingQueue.delete(p2.uid);

  console.log(`✅ [Matchmaking] Matched: ${p1.username} vs ${p2.username}`);

  const lobbyId = `ballcrush_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  createBallCrushLobbyInFirebase(lobbyId, p1, p2)
    .then(() => {
      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);

      if (s1) s1.emit('matchFound', { lobbyId, opponentDisplayName: p2.displayName });
      if (s2) s2.emit('matchFound', { lobbyId, opponentDisplayName: p1.displayName });

      console.log(`📨 [Matchmaking] matchFound sent — lobbyId=${lobbyId}`);

      // If one socket dropped between queue join and match, re-queue the survivor
      if (s1 && !s2) {
        console.log(`⚠️  [Matchmaking] ${p2.uid} gone — re-queuing ${p1.uid}`);
        matchmakingQueue.set(p1.uid, { ...p1, joinedAt: Date.now() });
        tryMatch();
      }
      if (s2 && !s1) {
        console.log(`⚠️  [Matchmaking] ${p1.uid} gone — re-queuing ${p2.uid}`);
        matchmakingQueue.set(p2.uid, { ...p2, joinedAt: Date.now() });
        tryMatch();
      }
    })
    .catch((err) => {
      console.error('❌ [Matchmaking] Lobby creation failed — re-queuing both:', err);
      matchmakingQueue.set(p1.uid, p1);
      matchmakingQueue.set(p2.uid, p2);
    });
}

async function createBallCrushLobbyInFirebase(lobbyId, p1, p2) {
  const db = admin.database();

  await db.ref(`lobbies/${lobbyId}`).set({
    id: lobbyId,
    gameId: 'ball-crush',
    status: 'waiting',
    players: {
      [p1.uid]: {
        uid: p1.uid, username: p1.username, displayName: p1.displayName,
        avatar: p1.avatar, health: 5, position: { x: 180, y: 550 },
        isReady: false, score: 0,
      },
      [p2.uid]: {
        uid: p2.uid, username: p2.username, displayName: p2.displayName,
        avatar: p2.avatar, health: 5, position: { x: 180, y: 50 },
        isReady: false, score: 0,
      },
    },
    playerIds: [p1.uid, p2.uid],
    createdAt: Date.now(),
    maxPlayers: 2,
  });

  await Promise.all([
    db.ref(`online/${p1.uid}`).update({ inQueue: false, inGame: true, lastSeen: Date.now() }),
    db.ref(`online/${p2.uid}`).update({ inQueue: false, inGame: true, lastSeen: Date.now() }),
    db.ref(`matches/${p1.uid}`).remove(),
    db.ref(`matches/${p2.uid}`).remove(),
  ]);

  console.log(`🏰 [Matchmaking] Lobby written to Firebase: ${lobbyId}`);
}

// Stale-entry cleanup — catches sockets that dropped without a clean disconnect
setInterval(() => {
  const now = Date.now();
  for (const [uid, entry] of matchmakingQueue.entries()) {
    const sock = io.sockets.sockets.get(entry.socketId);
    const isGone = !sock || !sock.connected;
    const isExpired = now - entry.joinedAt > 3 * 60_000;

    if (isGone || isExpired) {
      console.log(`🧹 [Matchmaking] Removing stale entry for ${uid} (gone=${isGone} expired=${isExpired})`);
      matchmakingQueue.delete(uid);
      if (!isGone && isExpired) sock.emit('matchmakingTimeout');
    }
  }
}, 15_000);

// ============================================================
// SECTION 3 – BALL CRUSH GAME ROOM
// ============================================================

const BC = {
  WIDTH: 360,
  HEIGHT: 640,
  BALL_RADIUS: 18,
  PADDLE_HALF_W: 50,
  PADDLE_HALF_H: 10,
  BOTTOM_PADDLE_Y: 550,
  TOP_PADDLE_Y: 50,
  INITIAL_SPEED: 9,
  SPEED_BUMP_EVERY: 5,
  SPEED_BUMP_MULT: 1.20,
  MAX_SPEED: 20,
  MAX_HEALTH: 5,
  TICK_MS: 33,
  MAX_SUBSTEPS: 8,
};

class BallCrushRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = [];
    this.active = false;
    this.intervalId = null;
    this.paddleX = { bottom: BC.WIDTH / 2, top: BC.WIDTH / 2 };
    this.health = { bottom: BC.MAX_HEALTH, top: BC.MAX_HEALTH };
    this.score = { bottom: 0, top: 0 };
    this.hitCount = 0;
    this.pauseTicksLeft = 0;
    this._pendingServe = null;
    this.hitCooldown = 0;       // NEW — ticks before same paddle can be hit again
    this.processingPoint = false; // NEW — prevents double-fire during async onPoint
    this.resetBall('bottom');
  }


  static get RESET_PAUSE_TICKS() { return 45; }

  resetBall(serveToward) {
    this.ball = { x: BC.WIDTH / 2, y: BC.HEIGHT / 2 };
    this.ballVel = { x: 0, y: 0 };
    this._pendingServe = serveToward;
    this.pauseTicksLeft = BallCrushRoom.RESET_PAUSE_TICKS;
    this.hitCooldown = 0;  // NEW — clear cooldown on each new serve

    this.players.forEach(({ socketId }) => {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('ballReset', { ball: { x: BC.WIDTH / 2, y: BC.HEIGHT / 2 } });
    });
  }

  _launchBall() {
    if (!this._pendingServe) return;
    const angle = (Math.random() * 60 - 30) * (Math.PI / 180);
    const dir = this._pendingServe === 'bottom' ? 1 : -1;
    this.ballVel = {
      x: Math.sin(angle) * BC.INITIAL_SPEED,
      y: Math.cos(angle) * BC.INITIAL_SPEED * dir,
    };
    this._pendingServe = null;
  }

  currentSpeed() {
    return Math.sqrt(this.ballVel.x ** 2 + this.ballVel.y ** 2);
  }

  async endGame(winnerRole) {
    this.active = false;
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }

    const winner = this.players.find(p => p.role === winnerRole);
    io.to(this.roomId).emit('gameOver', {
      winnerRole,
      winnerUsername: winner ? winner.username : 'Unknown',
      winnerUid: winner ? winner.uid : '',
    });

    console.log(`🏆 [BallCrush] ${this.roomId} game over — winner: ${winnerRole}`);

    if (winner?.uid) {
      try {
        const db = admin.database();
        const prize = 1.50;

        const winningsRef = db.ref(`winningsBalance/${winner.uid}`);
        const snap = await winningsRef.once('value');
        const current = snap.exists() ? (snap.val().balance || 0) : 0;

        await winningsRef.update({
          balance: current + prize,
          lastUpdated: new Date().toISOString(),
        });

        await db.ref(`winnings/${winner.uid}/${this.roomId}`).set({
          amount: prize,
          game: 'ball-crush',
          lobbyId: this.roomId,
          awardedAt: new Date().toISOString(),
        });

        // Also update the lobby status in Firebase
        await db.ref(`lobbies/${this.roomId}`).update({
          status: 'finished',
          finishedAt: Date.now(),
          winner: winner.uid,
        });

        console.log(`💰 [BallCrush] Awarded $${prize} to ${winner.username} (${winner.uid})`);
      } catch (err) {
        console.error('❌ [BallCrush] Failed to award prize:', err);
      }
    }

    setTimeout(() => ballCrushRooms.delete(this.roomId), 30_000);
  }

  ballOverlapsPaddle(ballX, ballY, paddleX, paddleY) {
    const dx = Math.abs(ballX - paddleX);
    const dy = Math.abs(ballY - paddleY);
    return (
      dx <= BC.PADDLE_HALF_W + BC.BALL_RADIUS &&
      dy <= BC.PADDLE_HALF_H + BC.BALL_RADIUS
    );
  }

  tick() {
    if (this.pauseTicksLeft > 0) {
      this.pauseTicksLeft--;
      if (this.pauseTicksLeft === 0) this._launchBall();
      return;
    }

    // Don't run physics while onPoint() is awaiting async work
    if (this.processingPoint) return;

    // Count down the per-paddle hit cooldown
    if (this.hitCooldown > 0) this.hitCooldown--;

    const vel = this.ballVel;
    const dist = Math.sqrt(vel.x ** 2 + vel.y ** 2);

    // FIX: step size is now HALF the ball radius (was full radius).
    // At BALL_RADIUS=18, old max step = 18px. New max step = 9px.
    // This doubles sub-steps at any given speed, preventing the ball
    // jumping clean through a paddle in a single sub-step.
    const stepSize = BC.BALL_RADIUS * 0.5;
    const steps = Math.min(BC.MAX_SUBSTEPS, Math.ceil(dist / stepSize));
    const dx = vel.x / steps;
    const dy = vel.y / steps;

    for (let s = 0; s < steps; s++) {
      this.ball.x += dx;
      this.ball.y += dy;

      // Wall bounces
      if (this.ball.x - BC.BALL_RADIUS <= 0) {
        this.ball.x = BC.BALL_RADIUS;
        vel.x = Math.abs(vel.x);
      } else if (this.ball.x + BC.BALL_RADIUS >= BC.WIDTH) {
        this.ball.x = BC.WIDTH - BC.BALL_RADIUS;
        vel.x = -Math.abs(vel.x);
      }

      // Bottom paddle — only when moving down AND cooldown expired
      if (
        vel.y > 0 &&
        this.hitCooldown === 0 &&
        this.ballOverlapsPaddle(this.ball.x, this.ball.y, this.paddleX.bottom, BC.BOTTOM_PADDLE_Y)
      ) {
        this.ball.y = BC.BOTTOM_PADDLE_Y - BC.PADDLE_HALF_H - BC.BALL_RADIUS;
        this.hitCooldown = 2; // immune for 2 ticks (~66ms) — prevents ghost double-bounce
        this.onPaddleHit('bottom');
        return;
      }

      // Top paddle — only when moving up AND cooldown expired
      if (
        vel.y < 0 &&
        this.hitCooldown === 0 &&
        this.ballOverlapsPaddle(this.ball.x, this.ball.y, this.paddleX.top, BC.TOP_PADDLE_Y)
      ) {
        this.ball.y = BC.TOP_PADDLE_Y + BC.PADDLE_HALF_H + BC.BALL_RADIUS;
        this.hitCooldown = 2;
        this.onPaddleHit('top');
        return;
      }

      if (this.ball.y + BC.BALL_RADIUS >= BC.HEIGHT) { this.onPoint('top'); return; }
      if (this.ball.y - BC.BALL_RADIUS <= 0) { this.onPoint('bottom'); return; }
    }
  }


  onPaddleHit(role) {
    this.hitCount++;
    this.score[role]++;

    this.ballVel.y = role === 'bottom'
      ? -Math.abs(this.ballVel.y)
      : Math.abs(this.ballVel.y);

    const offset = Math.max(-0.9, Math.min(0.9,
      (this.ball.x - this.paddleX[role]) / BC.PADDLE_HALF_W
    ));
    const speed = this.currentSpeed();
    this.ballVel.x = offset * speed * 0.75;

    const newSpeed = this.currentSpeed();
    if (newSpeed > 0) {
      this.ballVel.x = (this.ballVel.x / newSpeed) * speed;
      this.ballVel.y = (this.ballVel.y / newSpeed) * speed;
    }

    if (this.hitCount % BC.SPEED_BUMP_EVERY === 0) {
      if (this.currentSpeed() < BC.MAX_SPEED) {
        this.ballVel.x *= BC.SPEED_BUMP_MULT;
        this.ballVel.y *= BC.SPEED_BUMP_MULT;
        io.to(this.roomId).emit('speedBump', { multiplier: BC.SPEED_BUMP_MULT });
        console.log(`⚡ [BallCrush] ${this.roomId} speed bump | speed=${this.currentSpeed().toFixed(2)}`);
      }
    }

    io.to(this.roomId).emit('paddleHit', { role, score: this.score[role] });
    console.log(`🏓 [BallCrush] ${this.roomId} | ${role} hit #${this.hitCount}`);
  }

  async onPoint(scorer) {
    // Guard prevents a second tick firing onPoint again before
    // the first one's async Firebase work completes (~5-50ms).
    if (this.processingPoint) return;
    this.processingPoint = true;

    const loser = scorer === 'bottom' ? 'top' : 'bottom';
    this.health[loser] = Math.max(0, this.health[loser] - 1);

    console.log(`⚽ [BallCrush] ${this.roomId} | ${scorer} scored | health bottom=${this.health.bottom} top=${this.health.top}`);

    io.to(this.roomId).emit('point', {
      scorer,
      health: { bottom: this.health.bottom, top: this.health.top },
    });

    if (this.health[loser] === 0) {
      await this.endGame(scorer);
      this.processingPoint = false;
      return;
    }

    this.resetBall(loser);
    this.processingPoint = false;
  }
  broadcastState() {
    const { ball, paddleX, health, score } = this;

    this.players.forEach(({ socketId, role }) => {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) return;

      if (role === 'bottom') {
        socket.emit('gameState', {
          ball: { x: ball.x, y: ball.y },
          paddles: { my: paddleX.bottom, opponent: paddleX.top },
          health: { my: health.bottom, opponent: health.top },
          score: { my: score.bottom, opponent: score.top },
        });
      } else {
        socket.emit('gameState', {
          ball: { x: ball.x, y: BC.HEIGHT - ball.y },
          paddles: { my: paddleX.top, opponent: paddleX.bottom },
          health: { my: health.top, opponent: health.bottom },
          score: { my: score.top, opponent: score.bottom },
        });
      }
    });
  }

  start() {
    if (this.active) return;
    this.active = true;
    console.log(`▶️  [BallCrush] ${this.roomId} game loop starting`);

    this.intervalId = setInterval(() => {
      if (!this.active) { clearInterval(this.intervalId); return; }
      this.tick();
      this.broadcastState();
    }, BC.TICK_MS);
  }

  stop() {
    this.active = false;
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }
}

const ballCrushRooms = new Map();

const PING_INTERVAL_MS = 5000;
const PING_WARNING_MS = 200;
const pendingPings = new Map();

setInterval(() => {
  for (const [, room] of ballCrushRooms) {
    if (!room.active) continue;
    for (const { socketId } of room.players) {
      const s = io.sockets.sockets.get(socketId);
      if (!s) continue;
      pendingPings.set(socketId, { sentAt: Date.now(), roomId: room.roomId });
      s.emit('ping_check');
    }
  }
}, PING_INTERVAL_MS);

function getBallCrushRoom(roomId) {
  if (!ballCrushRooms.has(roomId)) {
    ballCrushRooms.set(roomId, new BallCrushRoom(roomId));
  }
  return ballCrushRooms.get(roomId);
}

// ============================================================
// SECTION 4 – SOCKET.IO EVENT HANDLERS
// ============================================================

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // ── Ping / latency ──────────────────────────────────────────────────────
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

  // ── MATCHMAKING ─────────────────────────────────────────────────────────

  socket.on('joinMatchmaking', (data) => {
    const { uid, username, displayName, avatar } = data || {};
    if (!uid) {
      console.warn('⚠️  [Matchmaking] joinMatchmaking received with no uid — ignoring');
      return;
    }

    console.log(`🎮 [Matchmaking] ${username} (${uid}) joining queue via socket ${socket.id}`);

    // Idempotent — if already queued, update socketId (handles reconnects)
    matchmakingQueue.set(uid, {
      socketId: socket.id,
      uid,
      username,
      displayName: displayName || username,
      avatar: avatar || 'default',
      joinedAt: Date.now(),
    });

    socket.emit('matchmakingJoined', { position: matchmakingQueue.size });
    console.log(`📋 [Matchmaking] Queue size: ${matchmakingQueue.size}`);

    tryMatch();
  });

  socket.on('leaveMatchmaking', (data) => {
    const { uid } = data || {};
    if (uid && matchmakingQueue.delete(uid)) {
      console.log(`🚪 [Matchmaking] ${uid} left queue. Size: ${matchmakingQueue.size}`);
    }
    socket.emit('matchmakingLeft');
  });

  // ── CHECKERS ────────────────────────────────────────────────────────────

  socket.on('joinGame', (data) => {
    const { roomId, color, isHost } = data;
    console.log('📡 [Checkers] joinGame:', { roomId, color, isHost });

    if (!checkersRooms.has(roomId)) {
      checkersRooms.set(roomId, {
        players: [], board: null, currentPlayer: 'red', moves: [],
      });
    }

    const room = checkersRooms.get(roomId);
    room.players.push({ socketId: socket.id, color, isHost });
    socket.join(roomId);
    socket.emit('gameJoined', { success: true, gameId: roomId });

    if (room.board) {
      socket.emit('gameStateSync', { board: room.board, currentPlayer: room.currentPlayer });
    }
    socket.to(roomId).emit('playerJoined', { playerId: socket.id, color });
  });

  socket.on('syncGameState', (data) => {
    const { roomId, board, currentPlayer } = data;
    const room = checkersRooms.get(roomId);
    if (room) {
      room.board = board;
      room.currentPlayer = currentPlayer;
      console.log(`📡 [Checkers] State saved for ${roomId}, turn: ${currentPlayer}`);
    }
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
      toRow: move.toRow, toCol: move.toCol,
      capturedPiece: result.capturedPiece,
      promoted: result.promoted,
      playerColor: move.playerColor,
      newBoard: room.board,
      currentPlayer: room.currentPlayer,
    };

    let red = 0, black = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const p = room.board[r][c];
        if (p?.includes('red')) red++;
        if (p?.includes('black')) black++;
      }

    if (red === 0) { io.to(roomId).emit('gameOver', { winner: 'black', message: 'Black wins!' }); }
    else if (black === 0) { io.to(roomId).emit('gameOver', { winner: 'red', message: 'Red wins!' }); }
    else {
      io.to(roomId).emit('opponentMove', moveData);
      socket.emit('moveConfirmed', moveData);
    }
  });

  socket.on('requestGameState', (data) => {
    const room = checkersRooms.get(data.roomId);
    if (room?.board) socket.emit('gameStateSync', { board: room.board, currentPlayer: room.currentPlayer });
  });

  // ── BALL CRUSH GAME ─────────────────────────────────────────────────────

  socket.on('joinRoom', (data) => {
    const { roomId, username, uid, role } = data;
    console.log(`📡 [BallCrush] joinRoom: roomId=${roomId} username=${username} role=${role}`);

    const room = getBallCrushRoom(roomId);

    if (room.players.find(p => p.socketId === socket.id)) {
      console.warn(`⚠️  [BallCrush] ${socket.id} already in ${roomId}`);
      return;
    }

    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    room.players.push({ socketId: socket.id, uid, username, role });
    socket.join(roomId);
    socket.emit('roomJoined', { role });
    console.log(`✅ [BallCrush] ${username} (${role}) joined ${roomId} [${room.players.length}/2]`);

    if (room.players.length === 2) {
      const [p1, p2] = room.players;
      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);
      if (s1) s1.emit('gameStart', { opponentName: p2.username });
      if (s2) s2.emit('gameStart', { opponentName: p1.username });

      console.log(`🎮 [BallCrush] ${roomId} — starting: ${p1.username}(${p1.role}) vs ${p2.username}(${p2.role})`);
      setTimeout(() => room.start(), 1500);
    }
  });

  socket.on('paddleMove', (data) => {
    const { x } = data;
    if (x === undefined) return;

    for (const [, room] of ballCrushRooms) {
      const player = room.players.find(p => p.socketId === socket.id);
      if (player) {
        room.paddleX[player.role] = Math.max(35, Math.min(BC.WIDTH - 35, x));
        return;
      }
    }
  });

  // ── DISCONNECT ──────────────────────────────────────────────────────────

  socket.on('disconnect', async () => {
    console.log('🔌 Client disconnected:', socket.id);

    // Matchmaking queue cleanup
    for (const [uid, entry] of matchmakingQueue.entries()) {
      if (entry.socketId === socket.id) {
        matchmakingQueue.delete(uid);
        console.log(`🔌 [Matchmaking] ${uid} disconnected — removed from queue. Size: ${matchmakingQueue.size}`);
        break;
      }
    }

    // Checkers cleanup
    for (const [roomId, room] of checkersRooms.entries()) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        socket.to(roomId).emit('opponentDisconnected');
        if (room.players.length === 0) { checkersRooms.delete(roomId); }
        break;
      }
    }

    // Ball Crush game room cleanup
    for (const [roomId, room] of ballCrushRooms.entries()) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        const disconnectedPlayer = room.players[idx];
        console.log(`⚠️  [BallCrush] ${disconnectedPlayer.username} disconnected from ${roomId}`);

        if (room.active) {
          const survivorIdx = idx === 0 ? 1 : 0;
          const survivor = room.players[survivorIdx];
          if (survivor) await room.endGame(survivor.role);
        } else {
          socket.to(roomId).emit('opponentDisconnected');
        }

        room.stop();
        ballCrushRooms.delete(roomId);
        break;
      }
    }
  });
});

// ============================================================
// SECTION 5 – PAYMENT ROUTES (unchanged)
// ============================================================

const Stripe = require('stripe');
const paypal = require('@paypal/checkout-server-sdk');
const { Paynow } = require('paynow');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

function getPaynow() {
  if (!process.env.PAYNOW_INTEGRATION_ID || !process.env.PAYNOW_INTEGRATION_KEY)
    throw new Error('PAYNOW credentials not set');
  const pn = new Paynow(process.env.PAYNOW_INTEGRATION_ID, process.env.PAYNOW_INTEGRATION_KEY);
  const backendUrl = process.env.SERVER_URL || 'https://game-server-xvdu.onrender.com';
  const frontendUrl = process.env.REACT_APP_FRONTEND_URL || 'https://wintapgames.com';
  pn.resultUrl = `${backendUrl}/api/paynow/callback`;
  pn.returnUrl = `${frontendUrl}/wallet?status=returned`;
  return pn;
}

function getPayPalClient() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)
    throw new Error('PayPal credentials not set');
  const env = process.env.PAYPAL_MODE === 'live'
    ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
  return new paypal.core.PayPalHttpClient(env);
}

async function finalizePayment(userId, {
  amount, plan, billingCycle, paymentMethod, transactionId,
  stripeCustomerId, stripePaymentMethodId, cardLast4, cardBrand, cardExpiry,
}) {
  const timestamp = Date.now();
  const db = admin.database();

  if (plan === 'wallet_deposit') {
    const walletRef = db.ref(`wallets/${userId}`);
    const walletSnap = await walletRef.once('value');
    const wallet = walletSnap.val() || {
      balance: 0, totalDeposited: 0, totalWithdrawn: 0,
      totalWon: 0, totalLost: 0, totalBonus: 0, currency: 'USD', isActive: true,
    };
    const newBalance = (wallet.balance || 0) + amount;
    const newTotalDeposited = (wallet.totalDeposited || 0) + amount;
    await walletRef.update({ balance: newBalance, totalDeposited: newTotalDeposited, lastUpdated: new Date().toISOString(), isActive: true });
    const txRef = db.ref(`transactions/${userId}`).push();
    await txRef.set({
      type: 'deposit', amount, balance: newBalance,
      description: `Deposit of $${amount} via ${paymentMethod} (Ref: ${transactionId})`,
      status: 'completed', timestamp: new Date().toISOString(), currency: 'USD',
      paymentReference: transactionId, paymentMethod,
    });
    await db.ref(`payments/${transactionId}`).update({ status: 'completed', verifiedAt: new Date().toISOString() });
    await db.ref(`payment_polls/${transactionId}`).update({ status: 'completed' });
    console.log(`✅ Wallet deposit finalized: user=${userId} amount=$${amount} newBalance=$${newBalance}`);
    return;
  }

  const updateData = {
    plan, billingCycle, paymentStatus: 'active',
    lastPaymentDate: timestamp, updatedAt: timestamp, failedPaymentAttempts: 0,
  };
  if (stripeCustomerId) updateData.stripeCustomerId = stripeCustomerId;
  if (stripePaymentMethodId) updateData.stripePaymentMethodId = stripePaymentMethodId;
  if (cardLast4) updateData.cardLast4 = cardLast4;
  if (cardBrand) updateData.cardBrand = cardBrand;
  if (cardExpiry) updateData.cardExpiry = cardExpiry;

  await db.ref(`users/${userId}`).update(updateData);
  await db.ref(`invoices/${userId}/${timestamp}`).set({
    invoiceNumber: `INV-${timestamp}`, date: timestamp,
    amount, plan, billingCycle, status: 'paid', paymentMethod, transactionId,
    dueDate: timestamp + (billingCycle === 'monthly' ? 30 : 365) * 24 * 60 * 60 * 1000,
  });
  console.log(`✅ Subscription finalized: user=${userId} plan=${plan} amount=$${amount}`);
}

async function getOrCreateStripeCustomer(stripe, userId, email) {
  const snap = await admin.database().ref(`users/${userId}`).once('value');
  const existing = (snap.val() || {}).stripeCustomerId;
  if (existing) return existing;
  const customer = await stripe.customers.create({ email, metadata: { userId } });
  await admin.database().ref(`users/${userId}`).update({ stripeCustomerId: customer.id, updatedAt: Date.now() });
  console.log(`✅ Stripe customer created: ${customer.id}`);
  return customer.id;
}

async function attachAndDefaultPM(stripe, customerId, paymentMethodId) {
  try { await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }); }
  catch (e) { if (e.code !== 'resource_already_exists') throw e; }
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
}

async function getCardDetails(stripe, paymentMethodId) {
  try {
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (!pm.card) return {};
    return {
      cardLast4: pm.card.last4, cardBrand: pm.card.brand,
      cardExpiry: String(pm.card.exp_month).padStart(2, '0') + '/' + String(pm.card.exp_year).slice(-2),
    };
  } catch (_) { return {}; }
}

function registerPaymentRoutes(app) {
  app.post('/api/stripe/create-payment-intent', async (req, res) => {
    try {
      const { amount, plan, billingCycle, email, userId } = req.body;
      if (amount === undefined || !plan || !email || !userId)
        return res.json({ success: false, error: 'Missing required fields' });

      const stripe = getStripe();
      const customerId = await getOrCreateStripeCustomer(stripe, userId, email);

      if (Number(amount) === 0) {
        const si = await stripe.setupIntents.create({
          customer: customerId, payment_method_types: ['card'],
          metadata: { userId, plan, billingCycle },
        });
        return res.json({ success: true, clientSecret: si.client_secret, isSetupIntent: true });
      }

      const pi = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), currency: 'usd', customer: customerId,
        receipt_email: email, metadata: { plan, billingCycle, userId },
        automatic_payment_methods: { enabled: true },
      });
      res.json({ success: true, clientSecret: pi.client_secret, isSetupIntent: false });
    } catch (err) { console.error('create-intent error:', err.message); res.json({ success: false, error: err.message }); }
  });

  app.post('/api/stripe/save-card', async (req, res) => {
    try {
      const { setupIntentId, paymentMethodId, userId } = req.body;
      if (!paymentMethodId || !userId) return res.json({ success: false, error: 'Missing required fields' });

      const stripe = getStripe();
      let customerId = null;
      if (setupIntentId) { const si = await stripe.setupIntents.retrieve(setupIntentId); customerId = si.customer || null; }
      if (!customerId) { const snap = await admin.database().ref(`users/${userId}`).once('value'); customerId = (snap.val() || {}).stripeCustomerId || null; }
      if (!customerId) return res.json({ success: false, error: 'No Stripe customer found.' });

      await attachAndDefaultPM(stripe, customerId, paymentMethodId);
      const cardDetails = await getCardDetails(stripe, paymentMethodId);
      await admin.database().ref(`users/${userId}`).update({ stripeCustomerId: customerId, stripePaymentMethodId: paymentMethodId, ...cardDetails, updatedAt: Date.now() });
      res.json({ success: true });
    } catch (err) { console.error('save-card error:', err.message); res.json({ success: false, error: err.message }); }
  });

  app.post('/api/stripe/confirm-payment', async (req, res) => {
    try {
      const { paymentIntentId, plan, billingCycle, userId } = req.body;
      if (!paymentIntentId || !userId) return res.json({ success: false, error: 'Missing required fields' });

      const stripe = getStripe();
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (intent.status !== 'succeeded') return res.json({ success: false, error: `Payment status: ${intent.status}` });

      const snap = await admin.database().ref(`users/${userId}`).once('value');
      let customerId = (snap.val() || {}).stripeCustomerId || intent.customer || null;
      if (!customerId) { const c = await stripe.customers.create({ email: intent.receipt_email, metadata: { userId } }); customerId = c.id; }

      await attachAndDefaultPM(stripe, customerId, intent.payment_method);
      const cardDetails = await getCardDetails(stripe, intent.payment_method);

      await finalizePayment(userId, {
        amount: intent.amount / 100, plan: plan || intent.metadata.plan,
        billingCycle: billingCycle || intent.metadata.billingCycle,
        paymentMethod: 'stripe_card', transactionId: paymentIntentId,
        stripeCustomerId: customerId, stripePaymentMethodId: intent.payment_method,
        ...cardDetails,
      });
      res.json({ success: true });
    } catch (err) { console.error('confirm-payment error:', err.message); res.json({ success: false, error: err.message }); }
  });

  app.post('/api/stripe/charge-saved-card', async (req, res) => {
    try {
      const { amount, plan, billingCycle, userId, email, paymentMethodId } = req.body;
      if (!paymentMethodId || !userId || amount === undefined)
        return res.json({ success: false, error: 'Missing required fields' });

      const stripe = getStripe();
      const snap = await admin.database().ref(`users/${userId}`).once('value');
      const userData = snap.val();
      if (!userData) return res.json({ success: false, error: 'User not found' });

      const customerId = userData.stripeCustomerId;
      if (!customerId) return res.json({ success: false, error: 'No Stripe customer on file.' });

      await attachAndDefaultPM(stripe, customerId, paymentMethodId);

      const pi = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), currency: 'usd', customer: customerId,
        payment_method: paymentMethodId, receipt_email: email,
        off_session: true, confirm: true,
        metadata: { plan, billingCycle, userId, source: 'saved_card' },
      });

      if (pi.status !== 'succeeded') return res.json({ success: false, error: `Unexpected status: ${pi.status}` });

      await finalizePayment(userId, { amount, plan, billingCycle, paymentMethod: 'stripe_card_saved', transactionId: pi.id, stripeCustomerId: customerId, stripePaymentMethodId: paymentMethodId });
      res.json({ success: true, transactionId: pi.id });
    } catch (err) {
      const friendly = {
        authentication_required: 'Card requires authentication.',
        card_declined: 'Card declined.',
        insufficient_funds: 'Insufficient funds.',
        expired_card: 'Card has expired.',
        incorrect_cvc: 'Incorrect CVC.',
        processing_error: 'Processing error. Please try again.',
      };
      res.json({ success: false, error: friendly[err.code] || err.message });
    }
  });

  app.post('/api/stripe/webhook',
    require('express').raw({ type: 'application/json' }),
    async (req, res) => {
      const sig = req.headers['stripe-signature'];
      let event;
      try { event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
      catch (err) { return res.status(400).send('Webhook signature error'); }

      if (event.type === 'payment_intent.succeeded') {
        const intent = event.data.object;
        const { userId, plan, billingCycle } = intent.metadata;
        if (userId) await finalizePayment(userId, { amount: intent.amount / 100, plan, billingCycle, paymentMethod: 'stripe_card', transactionId: intent.id });
      }
      if (event.type === 'payment_intent.payment_failed') {
        const { userId } = event.data.object.metadata || {};
        if (userId) {
          const snap = await admin.database().ref(`users/${userId}`).once('value');
          const attempts = ((snap.val() || {}).failedPaymentAttempts || 0) + 1;
          await admin.database().ref(`users/${userId}`).update({ failedPaymentAttempts: attempts });
          if (attempts >= 3) {
            await admin.database().ref(`users/${userId}`).update({ plan: 'free', paymentStatus: 'failed', downgradedAt: Date.now() });
          }
        }
      }
      res.sendStatus(200);
    }
  );

  app.post('/api/paynow/create', async (req, res) => {
    try {
      const { amount, email, phone, plan, billingCycle, userId, method } = req.body;
      if (!amount || !userId) return res.json({ success: false, error: 'amount and userId are required' });

      const isTest = (process.env.PAYMENT_GATEWAY || 'test') === 'test';
      const pn = getPaynow();
      const reference = `${plan === 'wallet_deposit' ? 'wallet' : 'zimchat'}_${userId}_${Date.now()}`;
      const payEmail = isTest ? (process.env.PAYMENT_GATEWAY_TEST_EMAIL || 'wintapgames@gmail.com') : (email || 'theorg.thone.com');

      const payment = pn.createPayment(reference, payEmail);
      payment.add(plan === 'wallet_deposit' ? 'Wallet Deposit' : `ZimChat ${plan} Plan (${billingCycle})`, parseFloat(amount));

      let response;
      if (isTest) response = await pn.send(payment);
      else if (method === 'ecocash') { if (!phone) return res.json({ success: false, error: 'Phone required' }); response = await pn.sendMobile(payment, phone, 'ecocash'); }
      else if (method === 'innbucks') { if (!phone) return res.json({ success: false, error: 'Phone required' }); response = await pn.sendMobile(payment, phone, 'innbucks'); }
      else response = await pn.send(payment);

      if (!response.success) return res.json({ success: false, error: response.errors?.join(', ') || 'PayNow failed' });

      await admin.database().ref(`pendingPayments/${reference}`).set({ userId, plan, billingCycle: billingCycle || 'once', amount: parseFloat(amount), pollUrl: response.pollUrl, reference, isTest, createdAt: Date.now(), processed: false });
      await admin.database().ref(`payments/${reference}`).set({ userId, amount: parseFloat(amount), status: 'pending', processingStarted: false, processedBy: null, createdAt: new Date().toISOString() });
      await admin.database().ref(`payment_polls/${reference}`).set({ pollUrl: response.pollUrl, status: 'pending', createdAt: new Date().toISOString() });

      if (response.redirectUrl) return res.json({ success: true, redirectUrl: response.redirectUrl, pollUrl: response.pollUrl, reference, isTest });
      res.json({ success: true, pollUrl: response.pollUrl, reference, isTest, instructions: `Payment prompt of $${amount} sent to ${phone}.` });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/paynow/callback', async (req, res) => {
    try {
      const pn = getPaynow();
      if (!pn.verifyPayment(req.body)) return res.status(400).send('Invalid signature');

      const { reference, status, paynowreference, amount } = req.body;
      if (status && ['paid', 'awaiting delivery'].includes(status.toLowerCase())) {
        const snap = await admin.database().ref(`pendingPayments/${reference}`).once('value');
        const pending = snap.val();
        if (pending?.userId && !pending.processed) {
          await admin.database().ref(`pendingPayments/${reference}`).update({ processed: true });
          await finalizePayment(pending.userId, { amount: pending.amount || parseFloat(amount), plan: pending.plan, billingCycle: pending.billingCycle, paymentMethod: 'paynow', transactionId: paynowreference || reference });
          await admin.database().ref(`pendingPayments/${reference}`).remove();
        }
      }
      res.sendStatus(200);
    } catch (err) { res.sendStatus(500); }
  });

  app.get('/api/paynow/poll', async (req, res) => {
    try {
      const { pollUrl, userId, plan, billingCycle, amount, reference } = req.query;
      if (!pollUrl) return res.json({ success: false, error: 'pollUrl required' });

      const pn = getPaynow();
      const status = await pn.pollTransaction(pollUrl);
      const isPaid = typeof status.paid === 'function' ? status.paid() : status.status === 'paid';

      if (isPaid && userId) {
        const pendingSnap = await admin.database().ref(`pendingPayments/${reference}`).once('value');
        const pending = pendingSnap.val();
        const paymentSnap = await admin.database().ref(`payments/${reference}`).once('value');
        const payment = paymentSnap.val();
        const alreadyDone = payment?.status === 'completed' || pending?.processed === true;

        if (!alreadyDone) {
          await admin.database().ref(`payments/${reference}`).update({ processingStarted: true, processingStartedAt: new Date().toISOString() });
          await finalizePayment(userId, { amount: parseFloat(amount) || pending?.amount || 0, plan: plan || pending?.plan || 'wallet_deposit', billingCycle: billingCycle || pending?.billingCycle || 'once', paymentMethod: 'paynow', transactionId: reference || pollUrl });
          if (pending) await admin.database().ref(`pendingPayments/${reference}`).update({ processed: true });
        }
      }
      res.json({ success: true, paid: isPaid, status: status.status || 'pending' });
    } catch (err) { res.json({ success: false, error: err.message, paid: false }); }
  });

  app.post('/api/paypal/create-order', async (req, res) => {
    try {
      const { amount, plan, billingCycle, email, userId } = req.body;
      const client = getPayPalClient();
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer('return=representation');
      request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: `zimchat_${userId}_${Date.now()}`, description: `ZimChat ${plan} Plan (${billingCycle})`, amount: { currency_code: 'USD', value: Number(amount).toFixed(2) }, custom_id: JSON.stringify({ userId, plan, billingCycle }) }],
        application_context: { brand_name: 'ZimChat', user_action: 'PAY_NOW' },
      });
      const order = await client.execute(request);
      res.json({ success: true, orderId: order.result.id });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/paypal/capture-order', async (req, res) => {
    try {
      const { orderId, plan, billingCycle, userId } = req.body;
      const client = getPayPalClient();
      const request = new paypal.orders.OrdersCaptureRequest(orderId);
      request.requestBody({});
      const capture = await client.execute(request);
      const result = capture.result;
      if (result.status !== 'COMPLETED') return res.json({ success: false, error: `PayPal status: ${result.status}` });

      const pu = result.purchase_units[0];
      const amount = parseFloat(pu.payments.captures[0].amount.value);
      const transactionId = pu.payments.captures[0].id;
      let resolvedUserId = userId;
      if (!resolvedUserId && pu.custom_id) { try { resolvedUserId = JSON.parse(pu.custom_id).userId; } catch (_) { } }

      await finalizePayment(resolvedUserId, { amount, plan, billingCycle, paymentMethod: 'paypal', transactionId });
      res.json({ success: true, transactionId });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/cancel-subscription', async (req, res) => {
    try {
      const { userId } = req.body;
      const snap = await admin.database().ref(`users/${userId}`).once('value');
      const user = snap.val();
      if (!user) return res.json({ success: false, error: 'User not found' });
      await admin.database().ref(`users/${userId}`).update({ cancelAtPeriodEnd: true, cancelledAt: Date.now(), subscriptionStatus: 'cancelling' });
      const daysInCycle = user.billingCycle === 'monthly' ? 30 : 365;
      res.json({ success: true, endDate: (user.lastPaymentDate || user.createdAt) + (daysInCycle * 24 * 60 * 60 * 1000) });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/reactivate-subscription', async (req, res) => {
    try {
      const { userId } = req.body;
      await admin.database().ref(`users/${userId}`).update({ cancelAtPeriodEnd: false, subscriptionStatus: 'active' });
      res.json({ success: true });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.get('/api/debug/user-stripe/:userId', async (req, res) => {
    const snap = await admin.database().ref(`users/${req.params.userId}`).once('value');
    const u = snap.val();
    if (!u) return res.json({ error: 'User not found' });
    res.json({
      userId: req.params.userId,
      stripeCustomerId: u.stripeCustomerId || '❌ MISSING',
      stripePaymentMethodId: u.stripePaymentMethodId || '❌ MISSING',
      cardLast4: u.cardLast4 || '❌ MISSING',
      cardBrand: u.cardBrand || '❌ MISSING',
      cardExpiry: u.cardExpiry || '❌ MISSING',
      plan: u.plan,
      paymentStatus: u.paymentStatus,
    });
  });

  app.post('/api/admin/backfill-stripe-customers', async (req, res) => {
    const stripe = getStripe();
    const usersSnap = await admin.database().ref('users').once('value');
    const users = usersSnap.val() || {};
    const results = { fixed: [], skipped: [], errors: [] };

    for (const [userId, u] of Object.entries(users)) {
      if (u.stripeCustomerId) { results.skipped.push(userId); continue; }
      if (u.stripePaymentMethodId) {
        try {
          const pm = await stripe.paymentMethods.retrieve(u.stripePaymentMethodId);
          if (pm.customer) {
            await admin.database().ref(`users/${userId}`).update({ stripeCustomerId: pm.customer, updatedAt: Date.now() });
            results.fixed.push({ userId, customerId: pm.customer });
          } else { results.errors.push({ userId, reason: 'PM has no customer in Stripe' }); }
        } catch (e) { results.errors.push({ userId, reason: e.message }); }
      } else { results.skipped.push(userId); }
    }
    res.json({ success: true, ...results });
  });
}

module.exports = { registerPaymentRoutes, finalizePayment, getStripe };
registerPaymentRoutes(app);

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎮 Game server running on port ${PORT}`);
  console.log(`   Checkers:     joinGame / makeMove`);
  console.log(`   Ball Crush:   joinRoom / paddleMove`);
  console.log(`   Matchmaking:  joinMatchmaking / leaveMatchmaking`);
});