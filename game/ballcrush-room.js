// ============================================================
// game/ballcrush-room.js
// Ball Crush game room — physics loop, scoring, prize payout
// ============================================================

'use strict';

const admin = require('firebase-admin');

// ── Physics constants ─────────────────────────────────────────────────────────

const BC = {
  WIDTH:            360,
  HEIGHT:           640,
  BALL_RADIUS:       18,
  PADDLE_HALF_W:     50,
  PADDLE_HALF_H:     10,
  BOTTOM_PADDLE_Y:  550,
  TOP_PADDLE_Y:      50,
  INITIAL_SPEED:      9,
  SPEED_BUMP_EVERY:   5,
  SPEED_BUMP_MULT:  1.20,
  MAX_SPEED:         20,
  MAX_HEALTH:         5,
  TICK_MS:           33,
  MAX_SUBSTEPS:       8,
  RESET_PAUSE_TICKS: 45,
  PRIZE:           1.50,
};

// ── In-memory room map ────────────────────────────────────────────────────────

const ballCrushRooms = new Map(); // roomId → BallCrushRoom

// ── Room class ────────────────────────────────────────────────────────────────

class BallCrushRoom {
  constructor(roomId, io) {
    this.roomId          = roomId;
    this.io              = io;
    this.players         = []; // [{ socketId, uid, username, role }]
    this.active          = false;
    this.intervalId      = null;
    this.paddleX         = { bottom: BC.WIDTH / 2, top: BC.WIDTH / 2 };
    this.health          = { bottom: BC.MAX_HEALTH, top: BC.MAX_HEALTH };
    this.score           = { bottom: 0, top: 0 };
    this.hitCount        = 0;
    this.pauseTicksLeft  = 0;
    this._pendingServe   = null;
    this.hitCooldown     = 0;
    this.processingPoint = false;

    this.resetBall('bottom');
  }

  // ── Ball management ─────────────────────────────────────────────────────────

  resetBall(serveToward) {
    this.ball           = { x: BC.WIDTH / 2, y: BC.HEIGHT / 2 };
    this.ballVel        = { x: 0, y: 0 };
    this._pendingServe  = serveToward;
    this.pauseTicksLeft = BC.RESET_PAUSE_TICKS;
    this.hitCooldown    = 0;

    this.players.forEach(({ socketId }) => {
      const s = this.io.sockets.sockets.get(socketId);
      if (s) s.emit('ballReset', { ball: { x: BC.WIDTH / 2, y: BC.HEIGHT / 2 } });
    });
  }

  _launchBall() {
    if (!this._pendingServe) return;
    const angle = (Math.random() * 60 - 30) * (Math.PI / 180);
    const dir   = this._pendingServe === 'bottom' ? 1 : -1;
    this.ballVel = {
      x: Math.sin(angle) * BC.INITIAL_SPEED,
      y: Math.cos(angle) * BC.INITIAL_SPEED * dir,
    };
    this._pendingServe = null;
  }

  currentSpeed() {
    return Math.sqrt(this.ballVel.x ** 2 + this.ballVel.y ** 2);
  }

  ballOverlapsPaddle(ballX, ballY, paddleX, paddleY) {
    return (
      Math.abs(ballX - paddleX) <= BC.PADDLE_HALF_W + BC.BALL_RADIUS &&
      Math.abs(ballY - paddleY) <= BC.PADDLE_HALF_H + BC.BALL_RADIUS
    );
  }

  // ── Game loop ───────────────────────────────────────────────────────────────

  start() {
    if (this.active) return;
    this.active = true;
    console.log(`▶️  [Ball Crush] ${this.roomId} game loop starting`);

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

  tick() {
    if (this.pauseTicksLeft > 0) {
      this.pauseTicksLeft--;
      if (this.pauseTicksLeft === 0) this._launchBall();
      return;
    }

    if (this.processingPoint) return;
    if (this.hitCooldown > 0) this.hitCooldown--;

    const vel   = this.ballVel;
    const dist  = Math.sqrt(vel.x ** 2 + vel.y ** 2);
    const steps = Math.min(BC.MAX_SUBSTEPS, Math.ceil(dist / (BC.BALL_RADIUS * 0.5)));
    const dx    = vel.x / steps;
    const dy    = vel.y / steps;

    for (let s = 0; s < steps; s++) {
      this.ball.x += dx;
      this.ball.y += dy;

      // Wall bounces
      if (this.ball.x - BC.BALL_RADIUS <= 0)           { this.ball.x = BC.BALL_RADIUS;             vel.x =  Math.abs(vel.x); }
      else if (this.ball.x + BC.BALL_RADIUS >= BC.WIDTH) { this.ball.x = BC.WIDTH - BC.BALL_RADIUS;  vel.x = -Math.abs(vel.x); }

      // Bottom paddle
      if (vel.y > 0 && this.hitCooldown === 0 &&
          this.ballOverlapsPaddle(this.ball.x, this.ball.y, this.paddleX.bottom, BC.BOTTOM_PADDLE_Y)) {
        this.ball.y = BC.BOTTOM_PADDLE_Y - BC.PADDLE_HALF_H - BC.BALL_RADIUS;
        this.hitCooldown = 2;
        this.onPaddleHit('bottom');
        return;
      }

      // Top paddle
      if (vel.y < 0 && this.hitCooldown === 0 &&
          this.ballOverlapsPaddle(this.ball.x, this.ball.y, this.paddleX.top, BC.TOP_PADDLE_Y)) {
        this.ball.y = BC.TOP_PADDLE_Y + BC.PADDLE_HALF_H + BC.BALL_RADIUS;
        this.hitCooldown = 2;
        this.onPaddleHit('top');
        return;
      }

      // Scoring edges
      if (this.ball.y + BC.BALL_RADIUS >= BC.HEIGHT) { this.onPoint('top');    return; }
      if (this.ball.y - BC.BALL_RADIUS <= 0)          { this.onPoint('bottom'); return; }
    }
  }

  onPaddleHit(role) {
    this.hitCount++;
    this.score[role]++;

    // Reverse Y toward opponent
    this.ballVel.y = role === 'bottom' ? -Math.abs(this.ballVel.y) : Math.abs(this.ballVel.y);

    // Add angle based on hit offset
    const offset = Math.max(-0.9, Math.min(0.9, (this.ball.x - this.paddleX[role]) / BC.PADDLE_HALF_W));
    const speed  = this.currentSpeed();
    this.ballVel.x = offset * speed * 0.75;

    // Re-normalise to preserve speed
    const newSpeed = this.currentSpeed();
    if (newSpeed > 0) {
      this.ballVel.x = (this.ballVel.x / newSpeed) * speed;
      this.ballVel.y = (this.ballVel.y / newSpeed) * speed;
    }

    // Speed bump every N hits
    if (this.hitCount % BC.SPEED_BUMP_EVERY === 0 && this.currentSpeed() < BC.MAX_SPEED) {
      this.ballVel.x *= BC.SPEED_BUMP_MULT;
      this.ballVel.y *= BC.SPEED_BUMP_MULT;
      this.io.to(this.roomId).emit('speedBump', { multiplier: BC.SPEED_BUMP_MULT });
      console.log(`⚡ [Ball Crush] ${this.roomId} speed bump | speed=${this.currentSpeed().toFixed(2)}`);
    }

    this.io.to(this.roomId).emit('paddleHit', { role, score: this.score[role] });
    console.log(`🏓 [Ball Crush] ${this.roomId} | ${role} hit #${this.hitCount}`);
  }

  async onPoint(scorer) {
    if (this.processingPoint) return;
    this.processingPoint = true;

    const loser        = scorer === 'bottom' ? 'top' : 'bottom';
    this.health[loser] = Math.max(0, this.health[loser] - 1);

    console.log(`⚽ [Ball Crush] ${this.roomId} | ${scorer} scored | health bottom=${this.health.bottom} top=${this.health.top}`);

    this.io.to(this.roomId).emit('point', {
      scorer, health: { bottom: this.health.bottom, top: this.health.top },
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
      const socket = this.io.sockets.sockets.get(socketId);
      if (!socket) return;

      if (role === 'bottom') {
        socket.emit('gameState', {
          ball:    { x: ball.x, y: ball.y },
          paddles: { my: paddleX.bottom, opponent: paddleX.top   },
          health:  { my: health.bottom,  opponent: health.top    },
          score:   { my: score.bottom,   opponent: score.top     },
        });
      } else {
        socket.emit('gameState', {
          ball:    { x: ball.x, y: BC.HEIGHT - ball.y },
          paddles: { my: paddleX.top,  opponent: paddleX.bottom },
          health:  { my: health.top,   opponent: health.bottom  },
          score:   { my: score.top,    opponent: score.bottom   },
        });
      }
    });
  }

  // ── Game over + prize ───────────────────────────────────────────────────────

  async endGame(winnerRole) {
    this.active = false;
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }

    const winner = this.players.find(p => p.role === winnerRole);

    this.io.to(this.roomId).emit('gameOver', {
      winnerRole,
      winnerUsername: winner ? winner.username : 'Unknown',
      winnerUid:      winner ? winner.uid      : '',
    });

    console.log(`🏆 [Ball Crush] ${this.roomId} game over — winner: ${winnerRole}`);

    if (winner?.uid) {
      try {
        const db          = admin.database();
        const winningsRef = db.ref(`winningsBalance/${winner.uid}`);
        const snap        = await winningsRef.once('value');
        const current     = snap.exists() ? (snap.val().balance || 0) : 0;

        await winningsRef.update({ balance: current + BC.PRIZE, lastUpdated: new Date().toISOString() });
        await db.ref(`winnings/${winner.uid}/${this.roomId}`).set({
          amount: BC.PRIZE, game: 'ball-crush', lobbyId: this.roomId, awardedAt: new Date().toISOString(),
        });
        await db.ref(`lobbies/${this.roomId}`).update({ status: 'finished', finishedAt: Date.now(), winner: winner.uid });

        console.log(`💰 [Ball Crush] Awarded $${BC.PRIZE} to ${winner.username} (${winner.uid})`);
      } catch (err) {
        console.error('❌ [Ball Crush] Failed to award prize:', err);
      }
    }

    setTimeout(() => ballCrushRooms.delete(this.roomId), 30_000);
  }
}

// ── Room factory ──────────────────────────────────────────────────────────────

function getOrCreateRoom(roomId, io) {
  if (!ballCrushRooms.has(roomId)) {
    ballCrushRooms.set(roomId, new BallCrushRoom(roomId, io));
  }
  return ballCrushRooms.get(roomId);
}

// ── Socket handlers ───────────────────────────────────────────────────────────

function registerBallCrushRoomHandlers(io, socket) {

  socket.on('joinRoom', (data) => {
    const { roomId, username, uid, role } = data;
    console.log(`📡 [Ball Crush] joinRoom: roomId=${roomId} username=${username} role=${role}`);

    const room = getOrCreateRoom(roomId, io);

    if (room.players.find(p => p.socketId === socket.id)) {
      console.warn(`⚠️  [Ball Crush] ${socket.id} already in ${roomId}`);
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    room.players.push({ socketId: socket.id, uid, username, role });
    socket.join(roomId);
    socket.emit('roomJoined', { role });
    console.log(`✅ [Ball Crush] ${username} (${role}) joined ${roomId} [${room.players.length}/2]`);

    if (room.players.length === 2) {
      const [p1, p2] = room.players;
      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);
      if (s1) s1.emit('gameStart', { opponentName: p2.username });
      if (s2) s2.emit('gameStart', { opponentName: p1.username });
      console.log(`🎮 [Ball Crush] ${roomId} — ${p1.username}(${p1.role}) vs ${p2.username}(${p2.role})`);
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
}

// ── Disconnect handler ────────────────────────────────────────────────────────

async function handleBallCrushRoomDisconnect(socket) {
  for (const [roomId, room] of ballCrushRooms.entries()) {
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (idx !== -1) {
      const disconnected = room.players[idx];
      console.log(`⚠️  [Ball Crush] ${disconnected.username} disconnected from ${roomId}`);

      if (room.active) {
        const survivor = room.players[idx === 0 ? 1 : 0];
        if (survivor) await room.endGame(survivor.role);
      } else {
        socket.to(roomId).emit('opponentDisconnected');
      }

      room.stop();
      ballCrushRooms.delete(roomId);
      break;
    }
  }
}

module.exports = {
  ballCrushRooms,
  registerBallCrushRoomHandlers,
  handleBallCrushRoomDisconnect,
};
