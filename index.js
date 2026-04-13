// server/index.js (simplified version for testing)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Allow all origins for testing
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// Store active rooms
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);
  
  // Handle joining a game room
  socket.on('joinGame', (data) => {
    const { roomId, color, isHost } = data;
    console.log(`👤 Player joining room ${roomId} as ${color}, host: ${isHost}`);
    
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { players: [] });
    }
    
    const room = rooms.get(roomId);
    room.players.push({ id: socket.id, color, isHost });
    
    // Notify others in the room
    socket.to(roomId).emit('playerJoined', { color, isHost });
    
    // If this is the second player, game can start
    if (room.players.length === 2) {
      io.to(roomId).emit('gameReady');
    }
  });
  
  // Handle game state sync
  socket.on('gameState', (data) => {
    const { roomId, board, currentPlayer } = data;
    socket.to(roomId).emit('gameState', { board, currentPlayer });
  });
  
  // Handle moves
  socket.on('makeMove', (data) => {
    const { roomId, move } = data;
    socket.to(roomId).emit('opponentMove', move);
  });
  
  socket.on('disconnect', () => {
    console.log('🔌 Disconnected:', socket.id);
    // Notify rooms about disconnection
    // (simplified - you'd want to track which rooms the socket was in)
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`🎮 Socket server running on port ${PORT}`);
});