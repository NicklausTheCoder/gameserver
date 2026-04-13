// Shared validation functions
const validation = {
  isValidGameId(gameId) {
    return ['ball-crush', 'checkers', 'flappy-bird'].includes(gameId);
  },

  isValidMove(gameId, move) {
    // Basic validation, game-specific validation happens in game logic
    return move && typeof move === 'object';
  },

  sanitizePlayer(data) {
    return {
      uid: data.uid?.substring(0, 50) || 'unknown',
      username: data.username?.substring(0, 30) || 'Player',
      displayName: data.displayName?.substring(0, 30) || data.username || 'Player',
      gameId: data.gameId
    };
  }
};

module.exports = validation;