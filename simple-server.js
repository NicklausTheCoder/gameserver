// ============================================================
// simple-server.js  –  Game Server
// Handles:
//   1. Checkers (existing logic – unchanged)
//   2. Ball Crush (new – full server-side game loop)
//   3. Payment routes (Stripe, PayNow, PayPal – unchanged)
// ============================================================

require('dotenv').config(); // MUST be first line
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

const checkersRooms = new Map(); // roomId → room object

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
// SECTION 2 – BALL CRUSH
// ============================================================
//
// Architecture
// ────────────
//  • Each Ball Crush match lives in a BallCrushRoom object.
//  • The server owns the ball entirely (position, velocity, physics).
//  • Clients own only their own paddle X position (sent via paddleMove).
//  • The server broadcasts gameState at ~30 Hz to both players.
//  • The server decides scores, health, speed bumps, and game-over.
//
// Coordinate system (server-side)
// ────────────────────────────────
//  360 × 640 canvas. Y increases downward.
//  bottom player paddle → y = 550  (high Y)
//  top    player paddle → y = 50   (low Y)
//  Server stores everything in this "bottom perspective".
//  broadcastState() flips Y for the top player so both clients
//  always see their own paddle near y = 550.
//
// Collision approach — sweep + depenetration
// ───────────────────────────────────────────
//  BUG FIXED #1 — Tunneling:
//    At high speeds the ball can jump clean through a thin paddle
//    in one tick. We solve this by sweeping along the ball's path
//    in small sub-steps (up to MAX_SUBSTEPS per tick) so no step
//    ever moves the ball more than BALL_RADIUS pixels.
//
//  BUG FIXED #2 — Ghost / double bounces:
//    After a reflection we push the ball to sit flush against the
//    paddle surface (depenetration). This guarantees the ball is
//    outside the hitbox before the next tick, so it can never
//    re-trigger the same paddle on the very next frame.
//
// ─────────────────────────────────────────────────────────────

const BC = {
  WIDTH:           360,
  HEIGHT:          640,
  BALL_RADIUS:     18,
  PADDLE_HALF_W:   50,   // half-width  of paddle hitbox  (total = 100 px)
  PADDLE_HALF_H:   10,   // half-height of paddle hitbox  (total =  20 px)
  BOTTOM_PADDLE_Y: 550,
  TOP_PADDLE_Y:    50,
  INITIAL_SPEED:   5,
  SPEED_BUMP_EVERY: 5,   // every N paddle hits → speed increase
  SPEED_BUMP_MULT:  1.15,
  MAX_SPEED:        14,
  MAX_HEALTH:       5,
  TICK_MS:          33,  // ~30 Hz game loop
  MAX_SUBSTEPS:     8,   // sub-step cap — prevents infinite loops
};

class BallCrushRoom {
  constructor(roomId) {
    this.roomId         = roomId;
    this.players        = [];
    this.active         = false;
    this.intervalId     = null;
    this.paddleX        = { bottom: BC.WIDTH / 2, top: BC.WIDTH / 2 };
    this.health         = { bottom: BC.MAX_HEALTH, top: BC.MAX_HEALTH };
    this.score          = { bottom: 0, top: 0 };
    this.hitCount       = 0;
    this.pauseTicksLeft = 0;    // physics freeze countdown after each point
    this._pendingServe  = null; // direction to serve when pause expires
    this.resetBall('bottom');
  }

  // ── How many ticks (~33ms each) to freeze after a point ─────────────────
  // 45 ticks ≈ 1.5 s — clients snap to centre, flash animation clears.
  static get RESET_PAUSE_TICKS() { return 45; }

  // ── Ball reset ───────────────────────────────────────────────────────────
  // Freezes ball at centre and queues the serve direction.
  // The actual velocity is applied after RESET_PAUSE_TICKS ticks.
  // Also emits 'ballReset' so clients SNAP the ball (no lerp) to centre.
  resetBall(serveToward) {
    this.ball           = { x: BC.WIDTH / 2, y: BC.HEIGHT / 2 };
    this.ballVel        = { x: 0, y: 0 };
    this._pendingServe  = serveToward;
    this.pauseTicksLeft = BallCrushRoom.RESET_PAUSE_TICKS;

    // Tell every client to snap the ball to centre right now
    this.players.forEach(({ socketId }) => {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('ballReset', { ball: { x: BC.WIDTH / 2, y: BC.HEIGHT / 2 } });
    });
  }

  // ── Apply queued serve velocity once the pause expires ──────────────────
  _launchBall() {
    if (!this._pendingServe) return;
    const angle = (Math.random() * 60 - 30) * (Math.PI / 180); // ±30°
    const dir   = this._pendingServe === 'bottom' ? 1 : -1;
    this.ballVel = {
      x: Math.sin(angle) * BC.INITIAL_SPEED,
      y: Math.cos(angle) * BC.INITIAL_SPEED * dir,
    };
    this._pendingServe = null;
  }

  // ── Current ball speed (magnitude) ─────────────────────────────────────
  currentSpeed() {
    return Math.sqrt(this.ballVel.x ** 2 + this.ballVel.y ** 2);
  }

  // ── AABB overlap between ball centre and a paddle ──────────────────────
  //    Returns true if the ball overlaps the paddle rectangle.
  ballOverlapsPaddle(ballX, ballY, paddleX, paddleY) {
    const dx = Math.abs(ballX - paddleX);
    const dy = Math.abs(ballY - paddleY);
    return (
      dx <= BC.PADDLE_HALF_W + BC.BALL_RADIUS &&
      dy <= BC.PADDLE_HALF_H + BC.BALL_RADIUS
    );
  }

  // ── One physics tick — uses sub-stepping to prevent tunneling ──────────
  tick() {
    // ── Post-point pause ─────────────────────────────────────────────────
    // While pauseTicksLeft > 0 the ball stays frozen at centre.
    // On the tick the pause expires we launch the ball with a fresh angle.
    if (this.pauseTicksLeft > 0) {
      this.pauseTicksLeft--;
      if (this.pauseTicksLeft === 0) this._launchBall();
      return; // skip all physics this tick
    }

    const vel       = this.ballVel;
    const stepSize  = BC.BALL_RADIUS;            // max pixels per sub-step
    const dist      = Math.sqrt(vel.x ** 2 + vel.y ** 2);
    const steps     = Math.min(BC.MAX_SUBSTEPS, Math.ceil(dist / stepSize));
    const dx        = vel.x / steps;
    const dy        = vel.y / steps;

    for (let s = 0; s < steps; s++) {
      // Advance ball one sub-step
      this.ball.x += dx;
      this.ball.y += dy;

      // ── Left / right wall bounce ─────────────────────────────────────
      if (this.ball.x - BC.BALL_RADIUS <= 0) {
        this.ball.x = BC.BALL_RADIUS;
        vel.x = Math.abs(vel.x);
      } else if (this.ball.x + BC.BALL_RADIUS >= BC.WIDTH) {
        this.ball.x = BC.WIDTH - BC.BALL_RADIUS;
        vel.x = -Math.abs(vel.x);
      }

      // ── Bottom paddle — only check when ball is moving downward ──────
      //    vel.y > 0 means moving toward bottom paddle (high Y).
      if (vel.y > 0 && this.ballOverlapsPaddle(this.ball.x, this.ball.y, this.paddleX.bottom, BC.BOTTOM_PADDLE_Y)) {
        // Depenetrate: push ball to sit on top of paddle surface
        this.ball.y = BC.BOTTOM_PADDLE_Y - BC.PADDLE_HALF_H - BC.BALL_RADIUS;
        this.onPaddleHit('bottom');
        return; // done with this tick — ball direction has changed
      }

      // ── Top paddle — only check when ball is moving upward ───────────
      //    vel.y < 0 means moving toward top paddle (low Y).
      if (vel.y < 0 && this.ballOverlapsPaddle(this.ball.x, this.ball.y, this.paddleX.top, BC.TOP_PADDLE_Y)) {
        // Depenetrate: push ball to sit below paddle surface
        this.ball.y = BC.TOP_PADDLE_Y + BC.PADDLE_HALF_H + BC.BALL_RADIUS;
        this.onPaddleHit('top');
        return;
      }

      // ── Ball exits bottom edge → top player scores ───────────────────
      if (this.ball.y + BC.BALL_RADIUS >= BC.HEIGHT) {
        this.onPoint('top');
        return;
      }

      // ── Ball exits top edge → bottom player scores ───────────────────
      if (this.ball.y - BC.BALL_RADIUS <= 0) {
        this.onPoint('bottom');
        return;
      }
    }
  }

  // ── Paddle hit handler ──────────────────────────────────────────────────
  //    Called AFTER the ball has already been depenetrated (repositioned
  //    outside the hitbox), so this can never double-fire.
  onPaddleHit(role) {
    this.hitCount++;
    this.score[role]++;

    const ball = this.ball;

    // Reflect Y away from the paddle
    this.ballVel.y = role === 'bottom'
      ? -Math.abs(this.ballVel.y)  // send upward
      :  Math.abs(this.ballVel.y); // send downward

    // Angle based on where the ball hit relative to paddle centre.
    // offset is –1 (far left) to +1 (far right).
    // We clamp it so the ball can never go perfectly horizontal.
    const offset = Math.max(-0.9, Math.min(0.9,
      (ball.x - this.paddleX[role]) / BC.PADDLE_HALF_W
    ));
    const speed = this.currentSpeed();
    this.ballVel.x = offset * speed * 0.75;

    // Re-normalise so speed stays consistent after angle change
    const newSpeed = this.currentSpeed();
    if (newSpeed > 0) {
      this.ballVel.x = (this.ballVel.x / newSpeed) * speed;
      this.ballVel.y = (this.ballVel.y / newSpeed) * speed;
    }

    // Speed bump every BC.SPEED_BUMP_EVERY hits
    if (this.hitCount % BC.SPEED_BUMP_EVERY === 0) {
      const current = this.currentSpeed();
      if (current < BC.MAX_SPEED) {
        this.ballVel.x *= BC.SPEED_BUMP_MULT;
        this.ballVel.y *= BC.SPEED_BUMP_MULT;
        io.to(this.roomId).emit('speedBump', { multiplier: BC.SPEED_BUMP_MULT });
        console.log(`⚡ [BallCrush] ${this.roomId} speed bump ×${BC.SPEED_BUMP_MULT} | speed=${this.currentSpeed().toFixed(2)}`);
      }
    }

    io.to(this.roomId).emit('paddleHit', { role, score: this.score[role] });
    console.log(`🏓 [BallCrush] ${this.roomId} | ${role} hit #${this.hitCount} | score=${this.score[role]}`);
  }

  // ── Point scored ────────────────────────────────────────────────────────
  onPoint(scorer) {
    const loser = scorer === 'bottom' ? 'top' : 'bottom';
    this.health[loser] = Math.max(0, this.health[loser] - 1);

    console.log(`⚽ [BallCrush] ${this.roomId} | ${scorer} scored | health bottom=${this.health.bottom} top=${this.health.top}`);

    io.to(this.roomId).emit('point', {
      scorer,
      health: { bottom: this.health.bottom, top: this.health.top },
    });

    if (this.health[loser] === 0) {
      this.endGame(scorer);
      return;
    }

    // Reset ball, serve toward whoever just lost the point
    this.resetBall(loser);
  }

  // ── Game over ───────────────────────────────────────────────────────────
  endGame(winnerRole) {
    this.active = false;
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }

    const winner = this.players.find(p => p.role === winnerRole);
    io.to(this.roomId).emit('gameOver', {
      winnerRole,
      winnerUsername: winner ? winner.username : 'Unknown',
    });

    console.log(`🏆 [BallCrush] ${this.roomId} game over — winner: ${winnerRole}`);

    // Clean up after 30 s so disconnected clients still get the event
    setTimeout(() => ballCrushRooms.delete(this.roomId), 30_000);
  }

  // ── Broadcast state to both players with perspective flip ───────────────
  //
  //  Server always stores everything in "bottom player perspective":
  //    bottom paddle near y=550, top paddle near y=50, ball y increases downward.
  //
  //  The "top" player needs a flipped view:
  //    • ball.y      → HEIGHT - ball.y
  //    • paddles.my  → their own (top) paddle x
  //    • paddles.opp → bottom paddle x
  //
  broadcastState() {
    const { ball, paddleX, health, score } = this;

    this.players.forEach(({ socketId, role }) => {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) return;

      if (role === 'bottom') {
        socket.emit('gameState', {
          ball: { x: ball.x, y: ball.y },
          paddles: { my: paddleX.bottom, opponent: paddleX.top },
          health:  { my: health.bottom,  opponent: health.top  },
          score:   { my: score.bottom,   opponent: score.top   },
        });
      } else {
        // Flip Y for top player so their paddle always appears near y=550
        socket.emit('gameState', {
          ball: { x: ball.x, y: BC.HEIGHT - ball.y },
          paddles: { my: paddleX.top,    opponent: paddleX.bottom },
          health:  { my: health.top,     opponent: health.bottom  },
          score:   { my: score.top,      opponent: score.bottom   },
        });
      }
    });
  }

  // ── Start game loop ─────────────────────────────────────────────────────
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

  // ── Stop game loop (e.g. on disconnect) ─────────────────────────────────
  stop() {
    this.active = false;
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }
}

const ballCrushRooms = new Map(); // roomId → BallCrushRoom

// ── Helper: get or create a Ball Crush room ───────────────────────────────
function getBallCrushRoom(roomId) {
  if (!ballCrushRooms.has(roomId)) {
    ballCrushRooms.set(roomId, new BallCrushRoom(roomId));
  }
  return ballCrushRooms.get(roomId);
}

// ============================================================
// SECTION 3 – SOCKET.IO EVENT HANDLERS
// ============================================================

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // ──────────────────────────────────────────────────────────────────────
  // CHECKERS events
  // ──────────────────────────────────────────────────────────────────────

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
    if (!validation.valid)             { socket.emit('moveRejected', { message: 'Invalid move' });   return; }
    if (room.currentPlayer !== move.playerColor) { socket.emit('moveRejected', { message: 'Not your turn' }); return; }

    const result = applyMove(room.board, move.fromRow, move.fromCol, move.toRow, move.toCol);
    room.board = result.newBoard;
    room.currentPlayer = room.currentPlayer === 'red' ? 'black' : 'red';
    room.moves.push(move);

    console.log(`♟️  [Checkers] ${roomId}: ${move.playerColor} [${move.fromRow},${move.fromCol}]→[${move.toRow},${move.toCol}]`);

    const moveData = {
      fromRow: move.fromRow, fromCol: move.fromCol,
      toRow:   move.toRow,   toCol:   move.toCol,
      capturedPiece: result.capturedPiece,
      promoted:      result.promoted,
      playerColor:   move.playerColor,
      newBoard:      room.board,
      currentPlayer: room.currentPlayer,
    };

    let red = 0, black = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const p = room.board[r][c];
        if (p?.includes('red'))   red++;
        if (p?.includes('black')) black++;
      }

    if (red === 0)   { io.to(roomId).emit('gameOver', { winner: 'black', message: 'Black wins!' }); }
    else if (black === 0) { io.to(roomId).emit('gameOver', { winner: 'red',   message: 'Red wins!'   }); }
    else {
      io.to(roomId).emit('opponentMove', moveData);
      socket.emit('moveConfirmed', moveData);
    }
  });

  socket.on('requestGameState', (data) => {
    const room = checkersRooms.get(data.roomId);
    if (room?.board) socket.emit('gameStateSync', { board: room.board, currentPlayer: room.currentPlayer });
  });

  // ──────────────────────────────────────────────────────────────────────
  // BALL CRUSH events
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Client emits:  joinRoom  { roomId, username, uid, role:'bottom'|'top' }
   * Server emits:  roomJoined  { role }           → back to joining socket only
   *                gameStart   { opponentName }   → to both sockets when room is full
   */
  socket.on('joinRoom', (data) => {
    const { roomId, username, uid, role } = data;
    console.log(`📡 [BallCrush] joinRoom: roomId=${roomId} username=${username} role=${role}`);

    const room = getBallCrushRoom(roomId);

    // Prevent the same socket joining twice (reconnect guard)
    if (room.players.find(p => p.socketId === socket.id)) {
      console.warn(`⚠️  [BallCrush] ${socket.id} already in ${roomId}`);
      return;
    }

    // Prevent more than 2 players
    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    room.players.push({ socketId: socket.id, uid, username, role });
    socket.join(roomId);
    socket.emit('roomJoined', { role });
    console.log(`✅ [BallCrush] ${username} (${role}) joined ${roomId} [${room.players.length}/2]`);

    // Both players present → start
    if (room.players.length === 2) {
      const [p1, p2] = room.players;

      // Tell each player who their opponent is
      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);
      if (s1) s1.emit('gameStart', { opponentName: p2.username });
      if (s2) s2.emit('gameStart', { opponentName: p1.username });

      console.log(`🎮 [BallCrush] ${roomId} — starting: ${p1.username}(${p1.role}) vs ${p2.username}(${p2.role})`);

      // Small delay so clients finish rendering before physics starts
      setTimeout(() => room.start(), 1500);
    }
  });

  /**
   * Client emits:  paddleMove  { x }
   * Server stores the x value for this socket's role and uses it in the next tick.
   */
  socket.on('paddleMove', (data) => {
    const { x } = data;
    if (x === undefined) return;

    // Find which Ball Crush room this socket belongs to
    for (const [, room] of ballCrushRooms) {
      const player = room.players.find(p => p.socketId === socket.id);
      if (player) {
        // Clamp to valid paddle range
        room.paddleX[player.role] = Math.max(35, Math.min(BC.WIDTH - 35, x));
        return;
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Disconnect — clean up both game types
  // ──────────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);

    // Checkers cleanup
    for (const [roomId, room] of checkersRooms.entries()) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        socket.to(roomId).emit('opponentDisconnected');
        if (room.players.length === 0) { checkersRooms.delete(roomId); console.log(`🗑️  [Checkers] Room ${roomId} deleted`); }
        break;
      }
    }

    // Ball Crush cleanup
    for (const [roomId, room] of ballCrushRooms.entries()) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        const disconnectedPlayer = room.players[idx];
        console.log(`⚠️  [BallCrush] ${disconnectedPlayer.username} disconnected from ${roomId}`);

        room.stop();
        socket.to(roomId).emit('opponentDisconnected');

        ballCrushRooms.delete(roomId);
        console.log(`🗑️  [BallCrush] Room ${roomId} deleted`);
        break;
      }
    }
  });
});

// ============================================================
// SECTION 4 – PAYMENT ROUTES (unchanged from original)
// ============================================================

const Stripe  = require('stripe');
const paypal  = require('@paypal/checkout-server-sdk');
const { Paynow } = require('paynow');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

function getPaynow() {
  if (!process.env.PAYNOW_INTEGRATION_ID || !process.env.PAYNOW_INTEGRATION_KEY)
    throw new Error('PAYNOW credentials not set');
  const pn = new Paynow(process.env.PAYNOW_INTEGRATION_ID, process.env.PAYNOW_INTEGRATION_KEY);
  const backendUrl  = process.env.SERVER_URL || 'https://game-server-xvdu.onrender.com';
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
    const walletRef  = db.ref(`wallets/${userId}`);
    const walletSnap = await walletRef.once('value');
    const wallet = walletSnap.val() || {
      balance: 0, totalDeposited: 0, totalWithdrawn: 0,
      totalWon: 0, totalLost: 0, totalBonus: 0, currency: 'USD', isActive: true,
    };
    const newBalance       = (wallet.balance       || 0) + amount;
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
  if (stripeCustomerId)       updateData.stripeCustomerId       = stripeCustomerId;
  if (stripePaymentMethodId)  updateData.stripePaymentMethodId  = stripePaymentMethodId;
  if (cardLast4)  updateData.cardLast4  = cardLast4;
  if (cardBrand)  updateData.cardBrand  = cardBrand;
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
  const snap     = await admin.database().ref(`users/${userId}`).once('value');
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

      const stripe     = getStripe();
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
      if (!customerId)   { const snap = await admin.database().ref(`users/${userId}`).once('value'); customerId = (snap.val() || {}).stripeCustomerId || null; }
      if (!customerId)   return res.json({ success: false, error: 'No Stripe customer found. Please refresh and retry.' });

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

      const stripe   = getStripe();
      const snap     = await admin.database().ref(`users/${userId}`).once('value');
      const userData = snap.val();
      if (!userData) return res.json({ success: false, error: 'User not found' });

      const customerId = userData.stripeCustomerId;
      if (!customerId) return res.json({ success: false, error: 'No Stripe customer on file. Please re-add your card.' });

      await attachAndDefaultPM(stripe, customerId, paymentMethodId);

      const pi = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), currency: 'usd', customer: customerId,
        payment_method: paymentMethodId, receipt_email: email,
        off_session: true, confirm: true,
        metadata: { plan, billingCycle, userId, source: 'saved_card' },
      });

      if (pi.status !== 'succeeded') return res.json({ success: false, error: `Unexpected payment status: ${pi.status}` });

      await finalizePayment(userId, { amount, plan, billingCycle, paymentMethod: 'stripe_card_saved', transactionId: pi.id, stripeCustomerId: customerId, stripePaymentMethodId: paymentMethodId });
      res.json({ success: true, transactionId: pi.id });
    } catch (err) {
      console.error('charge-saved-card error:', err.message);
      const friendly = {
        authentication_required: 'Card requires authentication. Please re-enter your card details.',
        card_declined: 'Card declined. Please try a different payment method.',
        insufficient_funds: 'Insufficient funds on card.',
        expired_card: 'Card has expired. Please update your payment method.',
        incorrect_cvc: 'Incorrect CVC. Please re-enter your card details.',
        processing_error: 'Processing error. Please try again shortly.',
      };
      res.json({ success: false, error: friendly[err.code] || err.message });
    }
  });

  app.post('/api/stripe/webhook',
    require('express').raw({ type: 'application/json' }),
    async (req, res) => {
      const sig           = req.headers['stripe-signature'];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      let event;
      try { event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret); }
      catch (err) { console.error('Stripe webhook sig error:', err.message); return res.status(400).send('Webhook signature error'); }

      if (event.type === 'payment_intent.succeeded') {
        const intent = event.data.object;
        const { userId, plan, billingCycle } = intent.metadata;
        if (userId) await finalizePayment(userId, { amount: intent.amount / 100, plan, billingCycle, paymentMethod: 'stripe_card', transactionId: intent.id });
      }
      if (event.type === 'payment_intent.payment_failed') {
        const intent = event.data.object;
        const { userId } = intent.metadata || {};
        if (userId) {
          const snap = await admin.database().ref(`users/${userId}`).once('value');
          const attempts = ((snap.val() || {}).failedPaymentAttempts || 0) + 1;
          await admin.database().ref(`users/${userId}`).update({ failedPaymentAttempts: attempts });
          if (attempts >= 3) {
            await admin.database().ref(`users/${userId}`).update({ plan: 'free', paymentStatus: 'failed', downgradedAt: Date.now() });
            console.log(`⚠️  User ${userId} downgraded after 3 failed payments`);
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

      const isTest   = (process.env.PAYMENT_GATEWAY || 'test') === 'test';
      const pn       = getPaynow();
      const reference = `${plan === 'wallet_deposit' ? 'wallet' : 'zimchat'}_${userId}_${Date.now()}`;
      const payEmail  = isTest ? (process.env.PAYMENT_GATEWAY_TEST_EMAIL || 'wintapgames@gmail.com') : (email || 'customer@example.com');

      const payment = pn.createPayment(reference, payEmail);
      const label   = plan === 'wallet_deposit' ? 'Wallet Deposit' : `ZimChat ${plan} Plan (${billingCycle})`;
      payment.add(label, parseFloat(amount));

      let response;
      if (isTest)                  response = await pn.send(payment);
      else if (method === 'ecocash')  { if (!phone) return res.json({ success: false, error: 'Phone number required for EcoCash' });   response = await pn.sendMobile(payment, phone, 'ecocash'); }
      else if (method === 'innbucks') { if (!phone) return res.json({ success: false, error: 'Phone number required for InnBucks' });  response = await pn.sendMobile(payment, phone, 'innbucks'); }
      else                         response = await pn.send(payment);

      if (!response.success) {
        console.error('Paynow full response:', JSON.stringify(response, null, 2));
        return res.json({ success: false, error: response.errors?.join(', ') || 'PayNow initiation failed' });
      }

      await admin.database().ref(`pendingPayments/${reference}`).set({ userId, plan, billingCycle: billingCycle || 'once', amount: parseFloat(amount), pollUrl: response.pollUrl, reference, isTest, createdAt: Date.now(), processed: false });
      await admin.database().ref(`payments/${reference}`).set({ userId, amount: parseFloat(amount), status: 'pending', processingStarted: false, processedBy: null, createdAt: new Date().toISOString() });
      await admin.database().ref(`payment_polls/${reference}`).set({ pollUrl: response.pollUrl, status: 'pending', createdAt: new Date().toISOString() });

      if (response.redirectUrl) return res.json({ success: true, redirectUrl: response.redirectUrl, pollUrl: response.pollUrl, reference, isTest });
      res.json({ success: true, pollUrl: response.pollUrl, reference, isTest, instructions: `Payment prompt of $${amount} sent to ${phone}. Approve on your phone.` });
    } catch (err) { console.error('Paynow create error:', err.message); res.json({ success: false, error: err.message }); }
  });

  app.post('/api/paynow/callback', async (req, res) => {
    console.log('🔔 Paynow callback:', JSON.stringify(req.body));
    try {
      const pn      = getPaynow();
      const isValid = pn.verifyPayment(req.body);
      if (!isValid) return res.status(400).send('Invalid signature');

      const { reference, status, paynowreference, amount } = req.body;
      if (status && ['paid', 'awaiting delivery'].includes(status.toLowerCase())) {
        const snap    = await admin.database().ref(`pendingPayments/${reference}`).once('value');
        const pending = snap.val();
        if (pending?.userId && !pending.processed) {
          await admin.database().ref(`pendingPayments/${reference}`).update({ processed: true });
          await finalizePayment(pending.userId, { amount: pending.amount || parseFloat(amount), plan: pending.plan, billingCycle: pending.billingCycle, paymentMethod: 'paynow', transactionId: paynowreference || reference });
          await admin.database().ref(`pendingPayments/${reference}`).remove();
        }
      }
      res.sendStatus(200);
    } catch (err) { console.error('Paynow callback error:', err.message); res.sendStatus(500); }
  });

  app.get('/api/paynow/poll', async (req, res) => {
    try {
      const { pollUrl, userId, plan, billingCycle, amount, reference } = req.query;
      if (!pollUrl) return res.json({ success: false, error: 'pollUrl required' });

      const pn     = getPaynow();
      const status = await pn.pollTransaction(pollUrl);
      const isPaid = typeof status.paid === 'function' ? status.paid() : status.status === 'paid';

      if (isPaid && userId) {
        const pendingSnap = await admin.database().ref(`pendingPayments/${reference}`).once('value');
        const pending     = pendingSnap.val();
        const paymentSnap = await admin.database().ref(`payments/${reference}`).once('value');
        const payment     = paymentSnap.val();
        const alreadyDone = payment?.status === 'completed' || pending?.processed === true;

        if (!alreadyDone) {
          await admin.database().ref(`payments/${reference}`).update({ processingStarted: true, processingStartedAt: new Date().toISOString() });
          await finalizePayment(userId, { amount: parseFloat(amount) || (pending?.amount) || 0, plan: plan || pending?.plan || 'wallet_deposit', billingCycle: billingCycle || pending?.billingCycle || 'once', paymentMethod: 'paynow', transactionId: reference || pollUrl });
          if (pending) await admin.database().ref(`pendingPayments/${reference}`).update({ processed: true });
        }
      }
      res.json({ success: true, paid: isPaid, status: status.status || 'pending' });
    } catch (err) { console.error('Paynow poll error:', err.message); res.json({ success: false, error: err.message, paid: false }); }
  });

  app.post('/api/paypal/create-order', async (req, res) => {
    try {
      const { amount, plan, billingCycle, email, userId } = req.body;
      const client  = getPayPalClient();
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer('return=representation');
      request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: `zimchat_${userId}_${Date.now()}`, description: `ZimChat ${plan} Plan (${billingCycle})`, amount: { currency_code: 'USD', value: Number(amount).toFixed(2) }, custom_id: JSON.stringify({ userId, plan, billingCycle }) }],
        application_context: { brand_name: 'ZimChat', user_action: 'PAY_NOW' },
      });
      const order = await client.execute(request);
      res.json({ success: true, orderId: order.result.id });
    } catch (err) { console.error('PayPal create-order error:', err.message); res.json({ success: false, error: err.message }); }
  });

  app.post('/api/paypal/capture-order', async (req, res) => {
    try {
      const { orderId, plan, billingCycle, userId } = req.body;
      const client  = getPayPalClient();
      const request = new paypal.orders.OrdersCaptureRequest(orderId);
      request.requestBody({});
      const capture = await client.execute(request);
      const result  = capture.result;
      if (result.status !== 'COMPLETED') return res.json({ success: false, error: `PayPal status: ${result.status}` });

      const pu             = result.purchase_units[0];
      const amount         = parseFloat(pu.payments.captures[0].amount.value);
      const transactionId  = pu.payments.captures[0].id;
      let resolvedUserId   = userId;
      if (!resolvedUserId && pu.custom_id) { try { resolvedUserId = JSON.parse(pu.custom_id).userId; } catch (_) {} }

      await finalizePayment(resolvedUserId, { amount, plan, billingCycle, paymentMethod: 'paypal', transactionId });
      res.json({ success: true, transactionId });
    } catch (err) { console.error('PayPal capture error:', err.message); res.json({ success: false, error: err.message }); }
  });

  app.post('/api/cancel-subscription', async (req, res) => {
    try {
      const { userId } = req.body;
      const snap = await admin.database().ref(`users/${userId}`).once('value');
      const user = snap.val();
      if (!user) return res.json({ success: false, error: 'User not found' });
      await admin.database().ref(`users/${userId}`).update({ cancelAtPeriodEnd: true, cancelledAt: Date.now(), subscriptionStatus: 'cancelling' });
      const lastPaymentDate = user.lastPaymentDate || user.createdAt;
      const daysInCycle     = user.billingCycle === 'monthly' ? 30 : 365;
      res.json({ success: true, endDate: lastPaymentDate + (daysInCycle * 24 * 60 * 60 * 1000) });
    } catch (err) { console.error('Cancel subscription error:', err.message); res.json({ success: false, error: err.message }); }
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
    const u    = snap.val();
    if (!u) return res.json({ error: 'User not found' });
    res.json({
      userId: req.params.userId,
      stripeCustomerId:       u.stripeCustomerId       || '❌ MISSING',
      stripePaymentMethodId:  u.stripePaymentMethodId  || '❌ MISSING',
      cardLast4:  u.cardLast4  || '❌ MISSING',
      cardBrand:  u.cardBrand  || '❌ MISSING',
      cardExpiry: u.cardExpiry || '❌ MISSING',
      plan:          u.plan,
      paymentStatus: u.paymentStatus,
    });
  });

  app.post('/api/admin/backfill-stripe-customers', async (req, res) => {
    const stripe    = getStripe();
    const usersSnap = await admin.database().ref('users').once('value');
    const users     = usersSnap.val() || {};
    const results   = { fixed: [], skipped: [], errors: [] };

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
  console.log(`   Checkers:   joinGame / makeMove`);
  console.log(`   Ball Crush: joinRoom / paddleMove`);
});