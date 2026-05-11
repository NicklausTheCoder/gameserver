// ============================================================
// simple-server.js  (main entry point)
//
// Module layout:
//   game/ballcrush-matchmaking.js  — Ball Crush queue
//   game/ballcrush-room.js         — Ball Crush physics + game loop
//   game/checkers-matchmaking.js   — Checkers queue
//   game/checkers.js               — Checkers game room (board in memory)
//   payment/routes.js              — Stripe / PayNow / PayPal
//   utils/ping.js                  — Latency tracking
// ============================================================

'use strict';

require('dotenv').config();
console.log('Gateway mode:', process.env.PAYMENT_GATEWAY);

// ── Firebase ──────────────────────────────────────────────────────────────────

const admin          = require('firebase-admin');
const serviceAccount = require('./firebase.json');


admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: 'https://wintapgames-31286-default-rtdb.firebaseio.com',
});

// ── Express / Socket.IO ───────────────────────────────────────────────────────

const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const cors           = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: Date.now(),
    message:   'Server is running',
    uptime:    Math.floor(process.uptime()) + 's',
  });
});

// ── Game modules ──────────────────────────────────────────────────────────────

const {
  matchmakingQueue,
  registerBallCrushMatchmakingHandlers,
  handleBallCrushMatchmakingDisconnect,
  startMatchmakingCleanup,
} = require('./game/ballcrush-matchmaking');

const {
  ballCrushRooms,
  registerBallCrushRoomHandlers,
  handleBallCrushRoomDisconnect,
} = require('./game/ballcrush-room');

const {
  checkersGameRooms,
  registerCheckersHandlers,
  handleCheckersDisconnect,
} = require('./game/checkers');

const {
  registerCheckersMatchmakingHandlers,
  handleCheckersQueueDisconnect,
  startCheckersQueueCleanup,
} = require('./game/checkers-matchmaking');

// ── Utilities ─────────────────────────────────────────────────────────────────

const { startPingLoop, registerPingHandler, cleanupSocket } = require('./utils/ping');

// ── Payment routes ────────────────────────────────────────────────────────────

const { registerPaymentRoutes } = require('./payment/routes');
const { registerUserRoutes }    = require('./api/routes/user');
const { registerTournamentRoutes, startTournamentCleanup } = require('./api/routes/tournament');

registerPaymentRoutes(app);
registerUserRoutes(app);
registerTournamentRoutes(app);
startTournamentCleanup();

// ── Background jobs ───────────────────────────────────────────────────────────

startMatchmakingCleanup(io);
startCheckersQueueCleanup(io);
startPingLoop(io, ballCrushRooms, checkersGameRooms);

// ── Socket.IO connection handler ──────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  registerBallCrushMatchmakingHandlers(io, socket);
  registerBallCrushRoomHandlers(io, socket);
  registerCheckersMatchmakingHandlers(io, socket);
  registerCheckersHandlers(io, socket);
  registerPingHandler(io, socket, ballCrushRooms, checkersGameRooms);

  socket.on('disconnect', async () => {
    console.log('🔌 Client disconnected:', socket.id);

    cleanupSocket(socket.id); // clear ping strikes + timeouts
    handleBallCrushMatchmakingDisconnect(socket);
    await handleBallCrushRoomDisconnect(socket);
    handleCheckersQueueDisconnect(socket);
    handleCheckersDisconnect(io, socket);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎮 Game server running on port ${PORT}`);
  console.log(`   Ball Crush MM:   joinMatchmaking / leaveMatchmaking`);
  console.log(`   Ball Crush Game: joinRoom / paddleMove`);
  console.log(`   Checkers MM:     joinCheckersMatchmaking / leaveCheckersMatchmaking`);
  console.log(`   Checkers Game:   checkers:joinRoom / checkers:makeMove`);
  console.log(`   Checkers Legacy: joinGame / makeMove`);
  console.log(`   Health:          GET /health`);
});