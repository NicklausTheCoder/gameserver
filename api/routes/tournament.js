// ============================================================
// api/routes/tournament.js
// Tournament routes — all Firebase access server-side only
// ============================================================

'use strict';

const admin = require('firebase-admin');

function db() { return admin.database(); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCurrentPeriodId() {
  const now  = new Date();
  const y    = now.getFullYear();
  const m    = String(now.getMonth() + 1).padStart(2, '0');
  const d    = String(now.getDate()).padStart(2, '0');
  const h    = String(Math.floor(now.getHours() / 4) * 4).padStart(2, '0');
  return `${y}-${m}-${d}-${h}`;
}

function getPeriodBounds(periodId) {
  const [y, mo, d, h] = periodId.split('-').map(Number);
  const start = new Date(y, mo - 1, d, h, 0, 0, 0).getTime();
  const end   = new Date(y, mo - 1, d, h + 4, 0, 0, 0).getTime();
  return { start, end };
}

async function getOrCreatePeriod(gameId = 'flappy-bird') {
  const periodId = getCurrentPeriodId();
  const snap     = await db().ref(`tournaments/${gameId}/${periodId}`).once('value');
  const { start, end } = getPeriodBounds(periodId);

  if (snap.exists()) return snap.val();

  const period = {
    id: periodId, startTime: start, endTime: end,
    players: {}, totalPool: 0, status: 'active',
  };
  await db().ref(`tournaments/${gameId}/${periodId}`).set(period);
  console.log(`🏆 [Tournament] New period created: ${periodId}`);
  return period;
}

async function completePeriod(gameId, periodId) {
  const snap = await db().ref(`tournaments/${gameId}/${periodId}`).once('value');
  if (!snap.exists()) return;

  const period = snap.val();
  if (period.status !== 'active') return;

  // Find winner
  let winnerUid = null, winnerUsername = '', winnerDisplayName = '', highestScore = 0;
  Object.entries(period.players || {}).forEach(([uid, p]) => {
    if (p.highestScore > highestScore) {
      highestScore = p.highestScore;
      winnerUid = uid; winnerUsername = p.username; winnerDisplayName = p.displayName;
    }
  });

  if (!winnerUid) {
    await db().ref(`tournaments/${gameId}/${periodId}`).update({ status: 'completed' });
    console.log(`🏁 [Tournament] ${periodId} ended with no players`);
    return;
  }

  const prize = Math.round(period.totalPool * 0.4 * 100) / 100 + 1;
  const winner = { uid: winnerUid, username: winnerUsername, displayName: winnerDisplayName, score: highestScore, prize };

  await db().ref(`tournaments/${gameId}/${periodId}`).update({ winner, status: 'completed' });
  console.log(`🏆 [Tournament] ${periodId} winner: ${winnerDisplayName} — $${prize}`);

  // Award prize
  const winningsRef  = db().ref(`winningsBalance/${winnerUid}`);
  const winningsSnap = await winningsRef.once('value');
  const current      = winningsSnap.exists() ? (winningsSnap.val().balance || 0) : 0;
  await winningsRef.update({ balance: current + prize, lastUpdated: new Date().toISOString() });
  await db().ref(`winnings/${winnerUid}/${periodId}`).set({
    amount: prize, game: gameId, periodId, awardedAt: new Date().toISOString(),
  });
  console.log(`💰 [Tournament] Awarded $${prize} to ${winnerUid}`);
}

// ── Route registration ─────────────────────────────────────────────────────────

function registerTournamentRoutes(app) {

  // GET /api/tournament/:gameId/current
  app.get('/api/tournament/:gameId/current', async (req, res) => {
    try {
      const { gameId } = req.params;
      const periodId   = getCurrentPeriodId();
      const { end }    = getPeriodBounds(periodId);

      const snap = await db().ref(`tournaments/${gameId}/${periodId}`).once('value');
      const period     = snap.exists() ? snap.val() : { players: {}, totalPool: 0 };
      const timeRemaining = Math.max(0, end - Date.now());

      const topPlayers = Object.entries(period.players || {})
        .map(([, p]) => ({ username: p.username, displayName: p.displayName, score: p.highestScore }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      res.json({
        success: true,
        periodId, timeRemaining,
        totalPool: period.totalPool || 0,
        players:   Object.keys(period.players || {}).length,
        topPlayers,
      });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // POST /api/tournament/:gameId/record
  // body: { uid, username, displayName, score }
  app.post('/api/tournament/:gameId/record', async (req, res) => {
    try {
      const { gameId }                       = req.params;
      const { uid, username, displayName, score } = req.body;
      if (!uid || score === undefined) return res.json({ success: false, error: 'Missing uid or score' });

      const periodId = getCurrentPeriodId();
      const ref      = db().ref(`tournaments/${gameId}/${periodId}`);
      const snap     = await ref.once('value');
      const period   = snap.exists() ? snap.val() : await getOrCreatePeriod(gameId);

      const existing = period.players?.[uid] || { highestScore: 0, gamesPlayed: 0 };
      await ref.update({
        [`players/${uid}`]: {
          username, displayName,
          highestScore: Math.max(score, existing.highestScore),
          gamesPlayed:  (existing.gamesPlayed || 0) + 1,
          lastPlayed:   Date.now(),
        },
        totalPool: (period.totalPool || 0) + 1,
      });

      console.log(`📊 [Tournament] ${username} score=${score} pool=$${(period.totalPool || 0) + 1}`);

      // Auto-complete if period expired
      const { end } = getPeriodBounds(periodId);
      if (Date.now() >= end && period.status === 'active') {
        await completePeriod(gameId, periodId);
      }

      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // POST /api/tournament/:gameId/:periodId/complete  (admin / cron)
  app.post('/api/tournament/:gameId/:periodId/complete', async (req, res) => {
    try {
      await completePeriod(req.params.gameId, req.params.periodId);
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // GET /api/tournament/:gameId/history?limit=10
  app.get('/api/tournament/:gameId/history', async (req, res) => {
    try {
      const { gameId } = req.params;
      const limit      = parseInt(req.query.limit) || 10;

      const snap = await db().ref(`tournaments/${gameId}`).once('value');
      if (!snap.exists()) return res.json({ success: true, history: [] });

      const periods = [];
      snap.forEach(child => { periods.push(child.val()); });
      periods.sort((a, b) => b.endTime - a.endTime);

      res.json({ success: true, history: periods.slice(0, limit) });
    } catch (err) {
      res.json({ success: false, error: err.message, history: [] });
    }
  });

  // POST /api/tournament/check-expired  — call from a cron/setInterval
  app.post('/api/tournament/check-expired', async (req, res) => {
    try {
      const gameIds = ['flappy-bird', 'ball-crush', 'checkers'];
      const now     = Date.now();

      for (const gameId of gameIds) {
        const snap = await db().ref(`tournaments/${gameId}`).once('value');
        if (!snap.exists()) continue;
        snap.forEach(child => {
          const p = child.val();
          if (p.status === 'active' && now >= p.endTime) {
            completePeriod(gameId, p.id).catch(console.error);
          }
        });
      }
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });
}

// Auto-check expired tournaments every 5 min when server starts
function startTournamentCleanup() {
  setInterval(async () => {
    const gameIds = ['flappy-bird', 'ball-crush', 'checkers'];
    const now     = Date.now();
    for (const gameId of gameIds) {
      try {
        const snap = await db().ref(`tournaments/${gameId}`).once('value');
        if (!snap.exists()) continue;
        snap.forEach(child => {
          const p = child.val();
          if (p.status === 'active' && now >= p.endTime) {
            completePeriod(gameId, p.id).catch(console.error);
          }
        });
      } catch (err) {
        console.error(`[Tournament] Cleanup error for ${gameId}:`, err.message);
      }
    }
  }, 5 * 60_000);
}

module.exports = { registerTournamentRoutes, startTournamentCleanup };
