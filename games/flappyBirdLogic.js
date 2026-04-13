// Flappy Bird game logic (for multiplayer races)
const flappyBirdLogic = {
  initialize() {
    return {
      players: {},
      scores: {},
      pipes: [],
      gameActive: false,
      startTime: null
    };
  },

  start(players, colors) {
    return {
      players: {
        player1: players[0],
        player2: players[1]
      },
      scores: { player1: 0, player2: 0 },
      pipes: this.generatePipes(),
      gameActive: true,
      startTime: Date.now(),
      currentPlayer: 'both' // Both play simultaneously
    };
  },

  generatePipes() {
    const pipes = [];
    for (let i = 0; i < 3; i++) {
      pipes.push({
        x: 300 + i * 200,
        gapY: 200 + Math.random() * 200,
        passed: false
      });
    }
    return pipes;
  },

  makeMove(gameState, move, player) {
    const { type, data } = move;
    
    if (type === 'flap') {
      // Player flapped
      const playerKey = gameState.players.player1?.uid === player.uid ? 'player1' : 'player2';
      
      if (!gameState.players[playerKey]) {
        return { valid: false, message: 'Player not found' };
      }

      // Update player position (bird flap)
      gameState.players[playerKey].velocity = -8;
      
      return {
        valid: true,
        gameState,
        gameOver: false,
        currentPlayer: 'both'
      };
    }

    if (type === 'update') {
      // Update game state (from host)
      gameState.players = data.players;
      gameState.pipes = data.pipes;
      gameState.scores = data.scores;

      // Check for game over
      for (const [key, player] of Object.entries(gameState.players)) {
        if (player.y > 600 || player.y < 0) {
          const winner = key === 'player1' ? 'player2' : 'player1';
          return {
            valid: true,
            gameState,
            gameOver: true,
            winner: gameState.players[winner]?.uid,
            message: `${gameState.players[winner]?.displayName} wins!`,
            currentPlayer: null
          };
        }
      }

      return {
        valid: true,
        gameState,
        gameOver: false,
        currentPlayer: 'both'
      };
    }

    return { valid: false, message: 'Invalid move type' };
  }
};

module.exports = flappyBirdLogic;