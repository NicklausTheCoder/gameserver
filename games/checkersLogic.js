// Checkers game logic
const checkersLogic = {
  initialize() {
    const board = Array(8).fill(null).map(() => Array(8).fill(null));
    
    // Place black pieces (top)
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 8; col++) {
        if ((row + col) % 2 === 1) {
          board[row][col] = 'black';
        }
      }
    }
    
    // Place red pieces (bottom)
    for (let row = 5; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if ((row + col) % 2 === 1) {
          board[row][col] = 'red';
        }
      }
    }
    
    return {
      board,
      currentPlayer: 'red',
      moves: [],
      capturedPieces: [],
      kings: []
    };
  },

  start(players, colors) {
    return {
      board: this.initialize().board,
      currentPlayer: colors[0],
      players: {
        [colors[0]]: players[0],
        [colors[1]]: players[1]
      },
      moves: [],
      capturedPieces: [],
      kings: []
    };
  },

  makeMove(gameState, move, player) {
    const { fromRow, fromCol, toRow, toCol, capturedPiece } = move;
    const newBoard = JSON.parse(JSON.stringify(gameState.board));
    
    // Get piece
    const piece = newBoard[fromRow][fromCol];
    if (!piece) {
      return { valid: false, message: 'No piece at source' };
    }

    // Check if it's player's piece
    const playerColor = player.uid === gameState.players?.red?.uid ? 'red' : 'black';
    if (!piece.includes(playerColor)) {
      return { valid: false, message: 'Not your piece' };
    }

    // Check if it's player's turn
    if (gameState.currentPlayer !== playerColor) {
      return { valid: false, message: 'Not your turn' };
    }

    // Move piece
    newBoard[toRow][toCol] = piece;
    newBoard[fromRow][fromCol] = null;

    // Handle capture
    if (capturedPiece) {
      newBoard[capturedPiece.row][capturedPiece.col] = null;
    }

    // Check for king promotion
    if (playerColor === 'red' && toRow === 0 && piece === 'red') {
      newBoard[toRow][toCol] = 'king_red';
    } else if (playerColor === 'black' && toRow === 7 && piece === 'black') {
      newBoard[toRow][toCol] = 'king_black';
    }

    // Update game state
    gameState.board = newBoard;
    gameState.currentPlayer = gameState.currentPlayer === 'red' ? 'black' : 'red';
    gameState.moves.push(move);

    // Check for win
    const redPieces = newBoard.flat().filter(p => p && p.includes('red')).length;
    const blackPieces = newBoard.flat().filter(p => p && p.includes('black')).length;

    if (redPieces === 0) {
      return {
        valid: true,
        gameState,
        gameOver: true,
        winner: 'black',
        message: 'Black wins!',
        currentPlayer: null
      };
    }

    if (blackPieces === 0) {
      return {
        valid: true,
        gameState,
        gameOver: true,
        winner: 'red',
        message: 'Red wins!',
        currentPlayer: null
      };
    }

    return {
      valid: true,
      gameState,
      gameOver: false,
      currentPlayer: gameState.currentPlayer
    };
  }
};

module.exports = checkersLogic;