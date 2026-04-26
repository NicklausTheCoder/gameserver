// ============================================================
// api/routes/user.js
// REST API routes — replaces direct Firebase calls from client
//
// All endpoints read/write Firebase via Admin SDK (server-side).
// Client Firebase files call these instead of the DB directly.
// Game scene files are NOT changed — only the firebase/*.ts files.
// ============================================================

'use strict';

const admin = require('firebase-admin');

// ── Helpers ───────────────────────────────────────────────────────────────────

function db() { return admin.database(); }

function normaliseWallet(raw) {
  if (typeof raw === 'number') {
    return { balance: raw, totalDeposited: 0, totalWithdrawn: 0, totalWon: 0, totalLost: 0, totalBonus: raw, totalGameFees: 0, totalRefunds: 0, currency: 'USD', isActive: true };
  }
  if (!raw || typeof raw !== 'object') {
    return { balance: 0, totalDeposited: 0, totalWithdrawn: 0, totalWon: 0, totalLost: 0, totalBonus: 0, totalGameFees: 0, totalRefunds: 0, currency: 'USD', isActive: true };
  }
  return {
    ...raw,
    balance: typeof raw.balance === 'number' ? raw.balance : 0,
    totalDeposited: raw.totalDeposited ?? 0,
    totalWithdrawn: raw.totalWithdrawn ?? 0,
    totalWon: raw.totalWon ?? 0,
    totalLost: raw.totalLost ?? 0,
    totalBonus: raw.totalBonus ?? 0,
    totalGameFees: raw.totalGameFees ?? 0,
    totalRefunds: raw.totalRefunds ?? 0,
    currency: raw.currency ?? 'USD',
    isActive: raw.isActive ?? true,
  };
}

// XP thresholds per level (per-game, independent)
// Level 1: 0-99 | Level 2: 100-299 | Level 3: 300-599
// Level 4: 600-999 | Level 5: 1000-1499 | Level 6: 1500-2099 | Level 7+: 2100+
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

// ── Route registration ────────────────────────────────────────────────────────

function registerUserRoutes(app) {


  // ══════════════════════════════════════════════════════════════════════════
  // SESSION LOCK
  // Atomic duplicate-login detection using a server-side Firebase transaction.
  // ══════════════════════════════════════════════════════════════════════════

  // POST /api/session/:uid/claim  body: { sessionId, userAgent }
  app.post('/api/session/:uid/claim', async (req, res) => {
    const { uid } = req.params;
    const { sessionId, userAgent } = req.body;

    if (!uid || uid.startsWith('temp_') || !sessionId) {
      return res.json({ success: true, blocked: false });
    }

    try {
      const sessionRef = db().ref(`active_sessions/${uid}`);
      let blocked = false;

      const result = await sessionRef.transaction((current) => {
        const now = Date.now();
        if (current !== null) {
          const isSameSession = current.sessionId === sessionId;
          const isStale = (now - (current.lockedAt || 0)) > 10000;
          if (!isSameSession && !isStale) { blocked = true; return undefined; }
        }
        return { sessionId, lockedAt: Date.now(), userAgent: userAgent || 'unknown' };
      });

      if (blocked) {
        console.warn(`[Session] Duplicate login blocked for ${uid}`);
        return res.json({ success: true, blocked: true });
      }
      if (!result.committed) {
        console.warn(`[Session] Transaction aborted for ${uid} — failing open`);
        return res.json({ success: true, blocked: false });
      }

      console.log(`[Session] Claimed for ${uid}`);
      res.json({ success: true, blocked: false });
    } catch (err) {
      console.error(`[Session] claimSession error for ${uid}:`, err.message);
      res.json({ success: true, blocked: false }); // fail open
    }
  });

  // POST /api/session/:uid/release  body: { sessionId }
  app.post('/api/session/:uid/release', async (req, res) => {
    const { uid } = req.params;
    const { sessionId } = req.body;
    if (!uid || !sessionId) return res.json({ success: true });
    try {
      await db().ref(`active_sessions/${uid}`).transaction((current) => {
        if (current && current.sessionId === sessionId) return null;
        return current;
      });
      console.log(`[Session] Released for ${uid}`);
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // WALLET
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/wallet/:uid
  app.get('/api/wallet/:uid', async (req, res) => {
    try {
      const { uid } = req.params;
      const snap = await db().ref(`wallets/${uid}`).once('value');
      const wallet = normaliseWallet(snap.exists() ? snap.val() : null);
      res.json({ success: true, wallet });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // GET /api/wallet/:uid/balance
  app.get('/api/wallet/:uid/balance', async (req, res) => {
    try {
      const snap = await db().ref(`wallets/${req.params.uid}`).once('value');
      const balance = normaliseWallet(snap.exists() ? snap.val() : null).balance;
      res.json({ success: true, balance });
    } catch (err) {
      res.json({ success: false, error: err.message, balance: 0 });
    }
  });

  // POST /api/wallet/:uid/transact
  // body: { amount, type, description }
  // type: 'win' | 'loss' | 'game_fee' | 'refund' | 'deposit' | 'withdrawal' | 'bonus'
  app.post('/api/wallet/:uid/transact', async (req, res) => {
    const { uid } = req.params;
    const { amount, type, description } = req.body;

    if (!uid || amount === undefined || !type) {
      return res.json({ success: false, error: 'Missing uid, amount, or type' });
    }

    const deductionTypes = ['game_fee', 'loss', 'withdrawal'];
    const isDeduction = deductionTypes.includes(type);
    const magnitude = Math.abs(amount);
    const signedAmount = isDeduction ? -magnitude : magnitude;

    console.log(`\n💳 [Transact] UID=${uid} type=${type} amount=${amount} magnitude=${magnitude} isDeduction=${isDeduction}`);

    // Determine which path holds the wallet.
    // Primary: wallets/{uid} — Secondary: users/{uid}/wallet (legacy accounts).
    const primarySnap = await db().ref(`wallets/${uid}`).once('value');
    const primaryExists = primarySnap.exists();
    const primaryVal = primaryExists ? primarySnap.val() : null;
    const walletPath = primaryExists ? `wallets/${uid}` : `users/${uid}/wallet`;

    console.log(`  📂 wallets/${uid} exists=${primaryExists} raw=${JSON.stringify(primaryVal)}`);

    if (!primaryExists) {
      const legacySnap = await db().ref(`users/${uid}/wallet`).once('value');
      console.log(`  📂 users/${uid}/wallet exists=${legacySnap.exists()} raw=${JSON.stringify(legacySnap.val())}`);
    }

    console.log(`  🎯 Using path: ${walletPath}`);

    const walletRef = db().ref(walletPath);

    let finalBalance = 0;

    try {
      // Read current wallet value first (avoids Firebase Admin SDK null-probe issue)
      const currentSnap = await walletRef.once('value');
      const wallet = normaliseWallet(currentSnap.exists() ? currentSnap.val() : null);

      console.log(`  🔄 [Read] current balance=$${wallet.balance} need=$${magnitude}`);

      if (isDeduction && wallet.balance < magnitude) {
        console.log(`  ❌ INSUFFICIENT: have $${wallet.balance}, need $${magnitude}`);
        return res.json({ success: false, error: 'Insufficient funds' });
      }

      const newBalance = wallet.balance + signedAmount;
      if (newBalance < 0) {
        console.log(`  ❌ Would go negative: ${wallet.balance} + ${signedAmount} = ${newBalance}`);
        return res.json({ success: false, error: 'Insufficient funds' });
      }

      switch (type) {
        case 'win': wallet.totalWon = (wallet.totalWon ?? 0) + magnitude; break;
        case 'loss': wallet.totalLost = (wallet.totalLost ?? 0) + magnitude; break;
        case 'deposit': wallet.totalDeposited = (wallet.totalDeposited ?? 0) + magnitude; break;
        case 'withdrawal': wallet.totalWithdrawn = (wallet.totalWithdrawn ?? 0) + magnitude; break;
        case 'bonus': wallet.totalBonus = (wallet.totalBonus ?? 0) + magnitude; break;
        case 'game_fee': wallet.totalGameFees = (wallet.totalGameFees ?? 0) + magnitude; break;
        case 'refund': wallet.totalRefunds = (wallet.totalRefunds ?? 0) + magnitude; break;
      }

      wallet.balance = newBalance;
      wallet.lastUpdated = new Date().toISOString();
      finalBalance = newBalance;

      // Write the updated wallet
      await walletRef.set(wallet);
      console.log(`  ✅ Written: $${finalBalance.toFixed(2)}`);

      // Keep both paths in sync regardless of which one was the transaction target
      const syncUpdates = { balance: finalBalance, lastUpdated: new Date().toISOString() };
      if (walletPath === `wallets/${uid}`) {
        await db().ref(`users/${uid}/wallet`).update(syncUpdates);
        console.log(`  🔁 Synced → users/${uid}/wallet balance=$${finalBalance}`);
      } else {
        await db().ref(`wallets/${uid}`).update(syncUpdates);
        console.log(`  🔁 Synced → wallets/${uid} balance=$${finalBalance} (legacy account migrated)`);
      }

      // Log transaction
      await db().ref(`transactions/${uid}`).push({
        type, amount: signedAmount, balanceAfter: finalBalance,
        description: description || type, timestamp: new Date().toISOString(),
      });

      console.log(`  💰 [Wallet] ${uid} ${type} ${signedAmount > 0 ? '+' : ''}${signedAmount.toFixed(2)} → $${finalBalance.toFixed(2)}\n`);
      res.json({ success: true, balance: finalBalance });

    } catch (err) {
      console.error(`  💥 [Transact] ERROR:`, err.message);
      res.json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // USER PROFILE
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/user/:uid
  app.get('/api/user/:uid', async (req, res) => {
    try {
      const { uid } = req.params;
      const [userSnap, walletSnap] = await Promise.all([
        db().ref(`users/${uid}`).once('value'),
        db().ref(`wallets/${uid}`).once('value'),
      ]);

      if (!userSnap.exists()) return res.json({ success: false, error: 'User not found' });

      const userData = userSnap.val();
      const wallet = normaliseWallet(walletSnap.exists() ? walletSnap.val() : null);

      // Strip private fields before sending to client
      const safeUser = {
        uid,
        public: userData.public || {},
        wallet,
        metadata: userData.metadata || {},
        games: userData.games || {},
        winnings: userData.winnings || {},
      };
      res.json({ success: true, user: safeUser });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GAME STATS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/stats/:uid/:gameId
  app.get('/api/stats/:uid/:gameId', async (req, res) => {
    try {
      const { uid, gameId } = req.params;
      const snap = await db().ref(`users/${uid}/games/${gameId}`).once('value');
      const stats = snap.exists() ? snap.val() : defaultStats();
      res.json({ success: true, stats });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // POST /api/stats/:uid/:gameId/update
  // body: { score, won, duration, flaps?, distance? }
  app.post('/api/stats/:uid/:gameId/update', async (req, res) => {
    try {
      const { uid, gameId } = req.params;
      const { score, won, duration, flaps, distance } = req.body;

      const [statsSnap, userSnap] = await Promise.all([
        db().ref(`users/${uid}/games/${gameId}`).once('value'),
        db().ref(`users/${uid}`).once('value'),
      ]);

      const now = new Date().toISOString();
      const curr = statsSnap.exists() ? statsSnap.val() : defaultStats();

      const newTotalGames = (curr.totalGames || 0) + 1;
      const newTotalScore = (curr.totalScore || 0) + score;
      const newAverageScore = Math.floor(newTotalScore / newTotalGames);
      const newHighScore = Math.max(curr.highScore || 0, score);
      const newTotalFlaps = (curr.totalFlaps || 0) + (flaps || 0);
      const newTotalDist = (curr.totalDistance || 0) + (distance || 0);
      const newWinStreak = won ? (curr.winStreak || 0) + 1 : 0;
      const newBestStreak = Math.max(curr.bestWinStreak || 0, newWinStreak);
      const newExp = (curr.experience || 0) + (won ? 15 : 0); // +15 XP only on win
      const newLevel = calcLevel(newExp);
      const newRank = calcRank(newLevel);

      const updates = {
        highScore: newHighScore, totalGames: newTotalGames,
        totalScore: newTotalScore, averageScore: newAverageScore,
        totalFlaps: newTotalFlaps, totalDistance: newTotalDist,
        winStreak: newWinStreak, bestWinStreak: newBestStreak,
        experience: newExp, level: newLevel, rank: newRank,
        lastPlayed: now,
        totalWins: won ? (curr.totalWins || 0) + 1 : (curr.totalWins || 0),
        totalLosses: won ? (curr.totalLosses || 0) : (curr.totalLosses || 0) + 1,
        gamesWon: won ? (curr.gamesWon || 0) + 1 : (curr.gamesWon || 0),
        gamesLost: won ? (curr.gamesLost || 0) : (curr.gamesLost || 0) + 1,
        winRate: newTotalGames > 0
          ? Math.round(((won ? (curr.totalWins || 0) + 1 : (curr.totalWins || 0)) / newTotalGames) * 100)
          : 0,
      };

      // Write game stats
      await db().ref(`users/${uid}/games/${gameId}`).update(updates);

      // Write to user_profiles (for leaderboard reads)
      const pub = userSnap.exists() ? (userSnap.val().public || {}) : {};
      await db().ref(`user_profiles/${uid}`).set({
        uid, username: pub.username || 'unknown',
        displayName: pub.displayName || 'Player',
        avatar: pub.avatar || 'default',
        highScore: newHighScore, totalGames: newTotalGames,
        totalWins: updates.totalWins, totalLosses: updates.totalLosses,
        winStreak: newWinStreak, bestWinStreak: newBestStreak,
        rank: newRank, level: newLevel, winRate: updates.winRate,
        lastUpdated: now,
      });

      // Write to dedicated game leaderboard
      await db().ref(`leaderboards/${gameId}/${uid}`).set({
        uid, username: pub.username || 'unknown',
        displayName: pub.displayName || 'Player',
        avatar: pub.avatar || 'default',
        highScore: newHighScore, totalGames: newTotalGames,
        totalWins: updates.totalWins, rank: newRank,
        level: newLevel, winRate: updates.winRate,
        lastUpdated: now,
      });

      // Update metadata
      await db().ref(`users/${uid}/metadata`).update({ lastGamePlayed: gameId, updatedAt: now });

      // Save score entry
      await db().ref(`users/${uid}/scores`).push({
        gameId, game: gameId, score, won,
        timestamp: Date.now(), date: now,
        ...(flaps !== undefined ? { flaps } : {}),
        ...(distance !== undefined ? { distance } : {}),
      });

      console.log(`📊 [Stats] ${uid} / ${gameId} score=${score} won=${won}`);
      res.json({ success: true, stats: updates });

    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CHECKERS-SPECIFIC STATS
  // ══════════════════════════════════════════════════════════════════════════

  // POST /api/checkers/stats/:uid
  // body: { won, piecesCaptured, kingsMade, moves }
  app.post('/api/checkers/stats/:uid', async (req, res) => {
    try {
      const { uid } = req.params;
      const { won, piecesCaptured = 0, kingsMade = 0, moves = 0 } = req.body;
      const now = new Date().toISOString();

      const [statsSnap, userSnap] = await Promise.all([
        db().ref(`users/${uid}/games/checkers`).once('value'),
        db().ref(`users/${uid}`).once('value'),
      ]);

      const curr = statsSnap.exists() ? statsSnap.val() : {};

      const newPlayed = (curr.gamesPlayed || 0) + 1;
      const newPieces = (curr.piecesCaptured || 0) + piecesCaptured;
      const newKings = (curr.kingsMade || 0) + kingsMade;
      const newTotalMoves = (curr.totalMoves || 0) + moves;
      const newAvgMoves = Math.floor(newTotalMoves / newPlayed);
      const newWon = won ? (curr.gamesWon || 0) + 1 : (curr.gamesWon || 0);
      const newLost = won ? (curr.gamesLost || 0) : (curr.gamesLost || 0) + 1;
      const newStreak = won ? (curr.winStreak || 0) + 1 : 0;
      const newBest = Math.max(curr.bestWinStreak || 0, newStreak);
      const winRate = Math.round((newWon / newPlayed) * 100);
      const newExp = (curr.experience || 0) + (won ? 15 : 0); // +15 XP only on win
      const newLevel = Math.floor(1 + newPlayed / 10);

      let newRank = 'Bronze';
      if (newWon >= 50 || newPieces >= 500) newRank = 'Diamond';
      else if (newWon >= 25 || newPieces >= 250) newRank = 'Platinum';
      else if (newWon >= 10 || newPieces >= 100) newRank = 'Gold';
      else if (newWon >= 5 || newPieces >= 50) newRank = 'Silver';

      const updates = {
        gamesPlayed: newPlayed, gamesWon: newWon, gamesLost: newLost,
        winStreak: newStreak, bestWinStreak: newBest,
        piecesCaptured: newPieces, kingsMade: newKings,
        totalMoves: newTotalMoves, averageMoves: newAvgMoves,
        experience: newExp, winRate, rank: newRank, level: newLevel,
        lastPlayed: now,
        // Aliases used by some leaderboard reads
        totalGames: newPlayed, totalWins: newWon,
      };

      await db().ref(`users/${uid}/games/checkers`).update(updates);

      // user_profiles sync
      const pub = userSnap.exists() ? (userSnap.val().public || {}) : {};
      await db().ref(`user_profiles/${uid}`).update({
        gamesPlayed: newPlayed, gamesWon: newWon, gamesLost: newLost,
        winStreak: newStreak, bestWinStreak: newBest, rank: newRank,
        level: newLevel, winRate, piecesCaptured: newPieces,
        kingsMade: newKings, lastUpdated: now,
      });

      // Dedicated leaderboard
      await db().ref(`leaderboards/checkers/${uid}`).set({
        uid, username: pub.username || 'unknown',
        displayName: pub.displayName || 'Player',
        avatar: pub.avatar || 'default',
        gamesWon: newWon, gamesPlayed: newPlayed, winRate,
        rank: newRank, level: newLevel,
        piecesCaptured: newPieces, kingsMade: newKings,
        lastUpdated: now,
      });

      console.log(`♟️ [Checkers stats] ${uid} won=${won} pieces=${piecesCaptured}`);
      res.json({ success: true, stats: updates });

    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // LEADERBOARDS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/leaderboard/:gameId?limit=10
  app.get('/api/leaderboard/:gameId', async (req, res) => {
    try {
      const { gameId } = req.params;
      const limit = parseInt(req.query.limit) || 10;

      const snap = await db().ref(`leaderboards/${gameId}`).once('value');

      if (!snap.exists()) return res.json({ success: true, leaderboard: [] });

      const entries = [];
      snap.forEach(child => { entries.push({ uid: child.key, ...child.val() }); });

      // Sort by the right field per game
      const sortField = gameId === 'checkers' ? 'gamesWon' : 'highScore';
      entries.sort((a, b) => (b[sortField] || 0) - (a[sortField] || 0));

      res.json({ success: true, leaderboard: entries.slice(0, limit) });
    } catch (err) {
      res.json({ success: false, error: err.message, leaderboard: [] });
    }
  });

  // GET /api/leaderboard/all?limit=100
  // All-games leaderboard sorted by totalWon from wallets
  app.get('/api/leaderboard-all', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;

      const [profSnap, wallSnap] = await Promise.all([
        db().ref('user_profiles').once('value'),
        db().ref('wallets').once('value'),
      ]);

      if (!profSnap.exists()) return res.json({ success: true, leaderboard: [] });

      const wallets = wallSnap.exists() ? wallSnap.val() : {};
      const entries = [];

      profSnap.forEach(child => {
        const uid = child.key;
        const p = child.val();
        const w = normaliseWallet(wallets[uid] || null);
        entries.push({
          uid,
          displayName: p.displayName || 'Player',
          rankTier: p.rank || 'Bronze',
          level: p.level || 1,
          totalGames: p.totalGames || 0,
          totalWins: p.totalWins || 0,
          winRate: p.winRate || 0,
          totalWon: w.totalWon || 0,
        });
      });

      entries.sort((a, b) => b.totalWon - a.totalWon);
      res.json({ success: true, leaderboard: entries.slice(0, limit) });
    } catch (err) {
      res.json({ success: false, error: err.message, leaderboard: [] });
    }
  });

  // GET /api/rank/:uid/:gameId
  app.get('/api/rank/:uid/:gameId', async (req, res) => {
    try {
      const { uid, gameId } = req.params;
      const snap = await db().ref(`leaderboards/${gameId}`).once('value');

      if (!snap.exists()) return res.json({ success: true, rank: 0, total: 0 });

      const entries = [];
      snap.forEach(child => { entries.push({ uid: child.key, ...child.val() }); });

      const sortField = gameId === 'checkers' ? 'gamesWon' : 'highScore';
      entries.sort((a, b) => (b[sortField] || 0) - (a[sortField] || 0));

      const idx = entries.findIndex(e => e.uid === uid);
      res.json({ success: true, rank: idx + 1, total: entries.length });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // GET /api/rank-by-username/:username/:gameId
  app.get('/api/rank-by-username/:username/:gameId', async (req, res) => {
    try {
      const { username, gameId } = req.params;
      const snap = await db().ref(`leaderboards/${gameId}`).once('value');

      if (!snap.exists()) return res.json({ success: true, rank: 0, total: 0 });

      const entries = [];
      snap.forEach(child => { entries.push({ uid: child.key, ...child.val() }); });

      const sortField = gameId === 'checkers' ? 'gamesWon' : 'highScore';
      entries.sort((a, b) => (b[sortField] || 0) - (a[sortField] || 0));

      const idx = entries.findIndex(e =>
        (e.username || '').toLowerCase() === username.toLowerCase()
      );
      res.json({ success: true, rank: idx + 1, total: entries.length });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SCORES / HISTORY
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/scores/:uid/:gameId?limit=10
  app.get('/api/scores/:uid/:gameId', async (req, res) => {
    try {
      const { uid, gameId } = req.params;
      const limit = parseInt(req.query.limit) || 10;

      const snap = await db().ref(`users/${uid}/scores`).once('value');
      if (!snap.exists()) return res.json({ success: true, scores: [] });

      const all = [];
      snap.forEach(child => {
        const d = child.val();
        if (!gameId || d.game === gameId || d.gameId === gameId) {
          all.push({ id: child.key, ...d });
        }
      });

      all.sort((a, b) => b.timestamp - a.timestamp);
      res.json({ success: true, scores: all.slice(0, limit) });
    } catch (err) {
      res.json({ success: false, error: err.message, scores: [] });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // WINNINGS (additive — separate from spendable balance)
  // ══════════════════════════════════════════════════════════════════════════

  // POST /api/winnings/:uid
  // body: { amount, description, game }
  app.post('/api/winnings/:uid', async (req, res) => {
    try {
      const { uid } = req.params;
      const { amount, description, game = 'checkers' } = req.body;

      const snap = await db().ref(`users/${uid}`).once('value');
      if (!snap.exists()) return res.json({ success: false, error: 'User not found' });

      const userData = snap.val();
      const currentTotal = userData.winnings?.[game]?.total || 0;
      const currentCount = userData.winnings?.[game]?.count || 0;
      const historyEntry = { amount, date: new Date().toISOString(), description, game };
      const existingHist = userData.winnings?.[game]?.history || [];

      await db().ref(`users/${uid}`).update({
        [`winnings/${game}/total`]: currentTotal + amount,
        [`winnings/${game}/count`]: currentCount + 1,
        [`winnings/${game}/lastWin`]: new Date().toISOString(),
        [`winnings/${game}/history`]: [historyEntry, ...existingHist].slice(0, 10),
      });

      await db().ref(`winnings/${game}/${uid}/total`).set(currentTotal + amount);
      await db().ref(`winnings/${game}/${uid}/count`).set(currentCount + 1);
      await db().ref(`winnings/${game}/${uid}/lastWin`).set(new Date().toISOString());

      await db().ref(`winnings_transactions/${game}/${uid}`).push({
        amount, balance: currentTotal + amount, description,
        timestamp: new Date().toISOString(), type: 'win', game,
      });

      res.json({ success: true, total: currentTotal + amount });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // GET /api/winnings/:uid/:game
  app.get('/api/winnings/:uid/:game', async (req, res) => {
    try {
      const { uid, game } = req.params;
      const snap = await db().ref(`users/${uid}/winnings/${game}/total`).once('value');
      if (snap.exists()) return res.json({ success: true, total: snap.val() });
      const alt = await db().ref(`winnings/${game}/${uid}/total`).once('value');
      res.json({ success: true, total: alt.exists() ? alt.val() : 0 });
    } catch (err) {
      res.json({ success: false, error: err.message, total: 0 });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GAME LOGS
  // ══════════════════════════════════════════════════════════════════════════

  // POST /api/logs/:lobbyId/:uid
  // body: { logs: [{ message, additionalData, timestamp }] }
  app.post('/api/logs/:lobbyId/:uid', async (req, res) => {
    try {
      const { lobbyId, uid } = req.params;
      const { logs } = req.body;
      if (!Array.isArray(logs) || logs.length === 0) return res.json({ success: true });

      const updates = {};
      for (const log of logs) {
        const key = `${log.timestamp || Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        updates[`game_logs/${lobbyId}/${uid}/${key}`] = {
          timestamp: log.timestamp || Date.now(),
          userId: uid,
          lobbyId,
          message: log.message || '',
          additionalData: log.additionalData ?? null,
        };
      }

      await db().ref().update(updates);
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // DELETE /api/logs/:lobbyId/:uid/cleanup?keep=1000
  app.delete('/api/logs/:lobbyId/:uid/cleanup', async (req, res) => {
    try {
      const { lobbyId, uid } = req.params;
      const keep = parseInt(req.query.keep) || 1000;

      const snap = await db().ref(`game_logs/${lobbyId}/${uid}`).once('value');
      if (!snap.exists()) return res.json({ success: true, deleted: 0 });

      const keys = Object.keys(snap.val()).sort();
      if (keys.length <= keep) return res.json({ success: true, deleted: 0 });

      const toDelete = keys.slice(0, keys.length - keep);
      const deletes = {};
      for (const key of toDelete) deletes[`game_logs/${lobbyId}/${uid}/${key}`] = null;

      await db().ref().update(deletes);
      res.json({ success: true, deleted: toDelete.length });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });
}

function defaultStats() {
  return {
    highScore: 0, totalGames: 0, totalWins: 0, totalLosses: 0,
    winStreak: 0, bestWinStreak: 0, experience: 0, level: 1, rank: 'Rookie',
    achievements: [], lastPlayed: new Date().toISOString(),
    averageScore: 0, totalScore: 0, gamesWon: 0, gamesLost: 0,
    totalFlaps: 0, totalDistance: 0,
  };
}

module.exports = { registerUserRoutes };