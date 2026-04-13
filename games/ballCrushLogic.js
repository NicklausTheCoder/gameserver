// Ball Crush game logic
const ballCrushLogic = {
  initialize() {
    return {
      ball: {
        x: 180,
        y: 320,
        speed: 200,
        direction: { x: 0.5, y: 0.5 }
      },
      players: {},
      scores: { bottom: 0, top: 0 },
      health: { bottom: 5, top: 5 },
      lastUpdate: Date.now()
    };
  },

  start(players, colors) {
    return {
      ball: {
        x: 180,
        y: 320,
        speed: 200,
        direction: { x: 0.5, y: 0.5 }
      },
      players: {
        bottom: players[0],
        top: players[1]
      },
      scores: { bottom: 0, top: 0 },
      health: { bottom: 5, top: 5 },
      currentPlayer: 'bottom', // bottom starts (serves)
      lastUpdate: Date.now()
    };
  },

  makeMove(gameState, move, player) {
    const { type, data } = move;
    
    switch(type) {
      case 'move-paddle':
        // Update paddle position
        if (gameState.players.bottom?.uid === player.uid) {
          gameState.players.bottom.position = data.x;
        } else if (gameState.players.top?.uid === player.uid) {
          gameState.players.top.position = data.x;
        }
        break;

      case 'ball-update':
        // Update ball position (from host)
        gameState.ball = data;
        break;

      case 'score':
        // Player scored
        const scorer = data.scorer === 'bottom' ? 'bottom' : 'top';
        const opponent = scorer === 'bottom' ? 'top' : 'bottom';
        
        gameState.health[opponent] -= 1;
        gameState.scores[scorer] += 1;
        
        // Check for game over
        if (gameState.health[opponent] <= 0) {
          return {
            valid: true,
            gameState,
            gameOver: true,
            winner: scorer,
            message: `${scorer} player wins!`,
            currentPlayer: null
          };
        }
        
        // Reset ball
        gameState.ball = {
          x: 180,
          y: 320,
          speed: 200,
          direction: {
            x: (Math.random() * 0.8) - 0.4,
            y: scorer === 'bottom' ? -0.8 : 0.8
          }
        };
        break;
    }

    return {
      valid: true,
      gameState,
      gameOver: false,
      currentPlayer: gameState.currentPlayer
    };
  }
};

module.exports = ballCrushLogic;