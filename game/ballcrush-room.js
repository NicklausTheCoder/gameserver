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
  ENTRY_FEE:        1.00,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function db() { return admin.database(); }

// XP thresholds — must match user.js
const XP_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2100];
function calcLevel(exp) {
  let level = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (exp >= XP_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}
function calcRank(level) {
  if (level >= 7) return 'Diamond';
  if (level >= 6) return 'Platinum';
  if (level >= 5) return 'Gold';
  if (level >= 4) return 'Silver';
  if (level >= 3) return 'Bronze';
  if (level >= 2) return 'Iron';
  return 'Rookie';
}

// Simple read→write wallet (matches user.js pattern)
async function walletTransact(uid, amount, type, description) {
  const deductionTypes = ['game_fee', 'loss', 'withdrawal'];
  const isDeduction    = deductionTypes.includes(type);
  const magnitude      = Math.abs(amount);
  const signedAmount   = isDeduction ? -magnitude : magnitude;

  // Determine path
  const primarySnap   = await db().ref(`wallets/${uid}`).once('value');
  const walletPath    = primarySnap.exists() ? `wallets/${uid}` : `users/${uid}/wallet`;
  const currentSnap   = await db().ref(walletPath).once('value');

  const raw = currentSnap.exists() ? currentSnap.val() : {};
  const balance = typeof raw.balance === 'number' ? raw.balance : 0;

  if (isDeduction && balance < magnitude) {
    console.warn(`[Wallet] Insufficient: ${uid} has $${balance}, needs $${magnitude}`);
    return { success: false, error: 'Insufficient funds', balance };
  }

  const newBalance = balance + signedAmount;
  const updated = {
    ...raw,
    balance: newBalance,
    lastUpdated: new Date().toISOString(),
    totalWon:       (raw.totalWon       || 0) + (type === 'win'        ? magnitude : 0),
    totalLost:      (raw.totalLost      || 0) + (type === 'loss'       ? magnitude : 0),
    totalGameFees:  (raw.totalGameFees  || 0) + (type === 'game_fee'   ? magnitude : 0),
    totalRefunds:   (raw.totalRefunds   || 0) + (type === 'refund'     ? magnitude : 0),
    totalDeposited: (raw.totalDeposited || 0) + (type === 'deposit'    ? magnitude : 0),
    totalWithdrawn: (raw.totalWithdrawn || 0) + (type === 'withdrawal' ? magnitude : 0),
    currency: raw.currency || 'USD',
    isActive: raw.isActive !== false,
  };

  await db().ref(walletPath).set(updated);

  // Keep both paths in sync
  const syncUpdates = { balance: newBalance, lastUpdated: updated.lastUpdated };
  if (walletPath === `wallets/${uid}`) {
    await db().ref(`users/${uid}/wallet`).update(syncUpdates);
  } else {
    await db().ref(`wallets/${uid}`).update(syncUpdates);
  }

  // Log transaction
  await db().ref(`transactions/${uid}`).push({
    type, amount: signedAmount, balanceAfter: newBalance,
    description: description || type, timestamp: new Date().toISOString(),
  });

  console.log(`💰 [Wallet] ${uid} ${type} ${signedAmount > 0 ? '+' : ''}${signedAmount.toFixed(2)} → $${newBalance.toFixed(2)}`);
  return { success: true, balance: newBalance };
}

// Update game stats for ball-crush
async function updateBallCrushStats(uid, { won, score, duration }) {
  try {
    const [statsSnap, userSnap] = await Promise.all([
      db().ref(`users/${uid}/games/ball-crush`).once('value'),
      db().ref(`users/${uid}`).once('value'),
    ]);

    const now  = new Date().toISOString();
    const curr = statsSnap.exists() ? statsSnap.val() : {};

    const newTotalGames   = (curr.totalGames   || 0) + 1;
    const newTotalScore   = (curr.totalScore   || 0) + score;
    const newAverageScore = Math.floor(newTotalScore / newTotalGames);
    const newHighScore    = Math.max(curr.highScore || 0, score);
    const newWinStreak    = won ? (curr.winStreak || 0) + 1 : 0;
    const newBestStreak   = Math.max(curr.bestWinStreak || 0, newWinStreak);
    const newExp          = (curr.experience || 0) + (won ? 15 : 0); // +15 XP on win only
    const newLevel        = calcLevel(newExp);
    const newRank         = calcRank(newLevel);

    const updates = {
      highScore:    newHighScore,
      totalGames:   newTotalGames,
      totalScore:   newTotalScore,
      averageScore: newAverageScore,
      winStreak:    newWinStreak,
      bestWinStreak: newBestStreak,
      experience:   newExp,
      level:        newLevel,
      rank:         newRank,
      lastPlayed:   now,
      totalWins:    won ? (curr.totalWins   || 0) + 1 : (curr.totalWins   || 0),
      totalLosses:  won ? (curr.totalLosses || 0)     : (curr.totalLosses || 0) + 1,
      gamesWon:     won ? (curr.gamesWon    || 0) + 1 : (curr.gamesWon    || 0),
      gamesLost:    won ? (curr.gamesLost   || 0)     : (curr.gamesLost   || 0) + 1,
      winRate: newTotalGames > 0
        ? Math.round(((won ? (curr.totalWins || 0) + 1 : (curr.totalWins || 0)) / newTotalGames) * 100)
        : 0,
    };

    await db().ref(`users/${uid}/games/ball-crush`).update(updates);

    // Sync leaderboard
    const pub = userSnap.exists() ? (userSnap.val().public || {}) : {};
    await db().ref(`leaderboards/ball-crush/${uid}`).set({
      uid,
      username:    pub.username    || 'unknown',
      displayName: pub.displayName || 'Player',
      avatar:      pub.avatar      || 'default',
      highScore:   newHighScore,
      totalGames:  newTotalGames,
      totalWins:   updates.totalWins,
      rank:        newRank,
      level:       newLevel,
      winRate:     updates.winRate,
      lastUpdated: now,
    });

    // Save score entry
    await db().ref(`users/${uid}/scores`).push({
      gameId: 'ball-crush', game: 'ball-crush', score, won,
      timestamp: Date.now(), date: now, duration,
    });

    console.log(`📊 [Ball Crush Stats] ${uid} score=${score} won=${won} level=${newLevel} rank=${newRank}`);
  } catch (err) {
    console.error('❌ [Ball Crush Stats] Failed:', err.message);
  }
}

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
    this.startTime       = Date.now();

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
    this.active    = true;
    this.startTime = Date.now();
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
    // NOTE: hitCooldown is now decremented per-substep inside the loop (not here)

    const vel   = this.ballVel;
    const dist  = Math.sqrt(vel.x ** 2 + vel.y ** 2);
    const steps = Math.min(BC.MAX_SUBSTEPS, Math.ceil(dist / (BC.BALL_RADIUS * 0.5)));
    const dx    = vel.x / steps;
    const dy    = vel.y / steps;

    // Predictive look-ahead: extend collision check by one substep of travel
    // so a fast ball can't skip the entire paddle zone in one step
    const lookAhead = Math.min(BC.BALL_RADIUS, Math.abs(dy));

    let hitThisTick = false;

    for (let s = 0; s < steps; s++) {
      this.ball.x += dx;
      this.ball.y += dy;

      // ── hitCooldown per substep ──────────────────────────────────────────────
      // Moved inside loop so multiple substeps in one tick each count down,
      // preventing a second hit on substep 2+ of the same tick.
      if (this.hitCooldown > 0) { this.hitCooldown--; continue; }

      // Wall bounces
      if (this.ball.x - BC.BALL_RADIUS <= 0) {
        this.ball.x = BC.BALL_RADIUS;
        vel.x = Math.abs(vel.x);
      } else if (this.ball.x + BC.BALL_RADIUS >= BC.WIDTH) {
        this.ball.x = BC.WIDTH - BC.BALL_RADIUS;
        vel.x = -Math.abs(vel.x);
      }

      // ── Bottom paddle ────────────────────────────────────────────────────────
      if (vel.y > 0 && !hitThisTick) {
        // Extend check by lookAhead in the direction of travel
        const checkY = this.ball.y + lookAhead;
        if (this.ballOverlapsPaddle(this.ball.x, checkY, this.paddleX.bottom, BC.BOTTOM_PADDLE_Y)) {
          this.ball.y  = BC.BOTTOM_PADDLE_Y - BC.PADDLE_HALF_H - BC.BALL_RADIUS;
          this.hitCooldown = steps * 2; // block for remainder of this tick + next
          hitThisTick  = true;
          this.onPaddleHit('bottom');
          break; // stop substeps — velocity has reversed
        }
      }

      // ── Top paddle ───────────────────────────────────────────────────────────
      if (vel.y < 0 && !hitThisTick) {
        const checkY = this.ball.y - lookAhead;
        if (this.ballOverlapsPaddle(this.ball.x, checkY, this.paddleX.top, BC.TOP_PADDLE_Y)) {
          this.ball.y  = BC.TOP_PADDLE_Y + BC.PADDLE_HALF_H + BC.BALL_RADIUS;
          this.hitCooldown = steps * 2;
          hitThisTick  = true;
          this.onPaddleHit('top');
          break;
        }
      }

      // ── Scoring edges ────────────────────────────────────────────────────────
      // Only score if no paddle hit happened this tick — prevents a tunnel
      // where the ball passes through a misaligned paddle AND scores
      if (!hitThisTick) {
        if (this.ball.y + BC.BALL_RADIUS >= BC.HEIGHT) { this.onPoint('top');    return; }
        if (this.ball.y - BC.BALL_RADIUS <= 0)          { this.onPoint('bottom'); return; }
      }
    }
  }

  onPaddleHit(role) {
    this.hitCount++;
    this.score[role]++;

    this.ballVel.y = role === 'bottom' ? -Math.abs(this.ballVel.y) : Math.abs(this.ballVel.y);

    const offset  = Math.max(-0.9, Math.min(0.9, (this.ball.x - this.paddleX[role]) / BC.PADDLE_HALF_W));
    const speed   = this.currentSpeed();
    this.ballVel.x = offset * speed * 0.75;

    const newSpeed = this.currentSpeed();
    if (newSpeed > 0) {
      this.ballVel.x = (this.ballVel.x / newSpeed) * speed;
      this.ballVel.y = (this.ballVel.y / newSpeed) * speed;
    }

    if (this.hitCount % BC.SPEED_BUMP_EVERY === 0 && this.currentSpeed() < BC.MAX_SPEED) {
      this.ballVel.x *= BC.SPEED_BUMP_MULT;
      this.ballVel.y *= BC.SPEED_BUMP_MULT;
      this.io.to(this.roomId).emit('speedBump', { multiplier: BC.SPEED_BUMP_MULT });
      console.log(`⚡ [Ball Crush] ${this.roomId} speed bump | speed=${this.currentSpeed().toFixed(2)}`);
    }

    this.io.to(this.roomId).emit('paddleHit', { role, score: this.score[role] });
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

    const duration   = Math.floor((Date.now() - this.startTime) / 1000);
    const winner     = this.players.find(p => p.role === winnerRole);
    const loserRole  = winnerRole === 'bottom' ? 'top' : 'bottom';
    const loser      = this.players.find(p => p.role === loserRole);

    this.io.to(this.roomId).emit('gameOver', {
      winnerRole,
      winnerUsername: winner ? winner.username : 'Unknown',
      winnerUid:      winner ? winner.uid      : '',
    });

    console.log(`🏆 [Ball Crush] ${this.roomId} game over — winner: ${winnerRole} (${winner?.username})`);

    // ── Stats for both players ──────────────────────────────────────────────
    const promises = [];

    if (winner?.uid) {
      promises.push(
        updateBallCrushStats(winner.uid, {
          won:      true,
          score:    this.score[winnerRole],
          duration,
        })
      );
      // Award prize to wallet
      promises.push(
        walletTransact(winner.uid, BC.PRIZE, 'win', `Ball Crush win in lobby ${this.roomId}`)
      );
    }

    if (loser?.uid) {
      promises.push(
        updateBallCrushStats(loser.uid, {
          won:      false,
          score:    this.score[loserRole],
          duration,
        })
      );
    }

    // ── Mark lobby finished ─────────────────────────────────────────────────
    promises.push(
      db().ref(`lobbies/${this.roomId}`).update({
        status:     'finished',
        finishedAt: Date.now(),
        winner:     winner?.uid || '',
      })
    );

    try {
      await Promise.all(promises);
      console.log(`✅ [Ball Crush] ${this.roomId} — all post-game writes done`);
    } catch (err) {
      console.error('❌ [Ball Crush] Post-game write error:', err.message);
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
  socket.on('resign', (data) => {
    const { roomId, uid } = data || {};
    if (!roomId || !uid) return;
    const room = ballCrushRooms.get(roomId);
    if (!room || !room.active) return;
    const survivor = room.players.find(p => p.uid !== uid);
    if (!survivor) return;
    console.log(`🏳️  [Ball Crush] ${uid} resigned in ${roomId}`);
    room.endGame(survivor.role);
  });

  socket.on('offerDraw', (data) => {
    const { roomId, uid } = data || {};
    if (!roomId || !uid) return;
    const room = ballCrushRooms.get(roomId);
    if (!room || !room.active) return;
    const opponent = room.players.find(p => p.uid !== uid);
    if (!opponent) return;
    const oppSocket = room.io.sockets.sockets.get(opponent.socketId);
    if (oppSocket) oppSocket.emit('drawOffer');
    console.log(`🤝 [Ball Crush] ${uid} offered draw in ${roomId}`);
  });

  socket.on('respondDraw', (data) => {
    const { roomId, uid, accept } = data || {};
    if (!roomId || !uid) return;
    const room = ballCrushRooms.get(roomId);
    if (!room || !room.active) return;
    if (accept) {
      room.active = false;
      room.stop();
      room.io.to(roomId).emit('drawAccepted');
      // Persist draw — no prize
      try {
        const db = admin.database();
        db.ref(`lobbies/${roomId}`).update({ status: 'finished', winner: 'draw', finishedAt: Date.now() });
      } catch (e) { console.error('❌ [Ball Crush] Draw persist failed:', e); }
      setTimeout(() => ballCrushRooms.delete(roomId), 30_000);
      console.log(`🤝 [Ball Crush] Draw agreed in ${roomId}`);
    } else {
      const offerer = room.players.find(p => p.uid !== uid);
      if (offerer) {
        const s = room.io.sockets.sockets.get(offerer.socketId);
        if (s) s.emit('drawDeclined');
      }
    }
  });

  socket.on('reportGame', async (data) => {
    const { roomId, reporterUid, reason } = data || {};
    if (!roomId || !reporterUid || !reason) return;
    const room = ballCrushRooms.get(roomId);
    const reportedUid = room?.players.find(p => p.uid !== reporterUid)?.uid || null;
    console.log(`🚩 [Ball Crush] Report in ${roomId}: ${reporterUid} → "${reason}"`);
    try {
      const db = admin.database();
      await db.ref(`reports/ball-crush/${roomId}/${Date.now()}_${reporterUid.slice(0,6)}`).set({
        reporterUid, reportedUid, reason, roomId, timestamp: new Date().toISOString(),
      });
      socket.emit('reportAck');
    } catch (e) { console.error('❌ [Ball Crush] Report persist failed:', e); }
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