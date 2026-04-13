// D:\game-server\simple-server.js

require('dotenv').config();  // ← MUST be line 1, before anything else
console.log('Gateway mode:', process.env.PAYMENT_GATEWAY);
console.log('User email being used:', process.env.PAYMENT_GATEWAY);

const admin = require('firebase-admin');
const serviceAccount = require('./firebase.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://wintapgames-31286-default-rtdb.firebaseio.com'
});


const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(cors());
app.use(express.json()); // ← ADD THIS
app.use(express.urlencoded({ extended: true })); // ← and this (optional but good practice)

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now(), message: 'Server is running' });
});

const rooms = new Map();

// Check if a move is valid and return captured piece info
function isValidMove(board, fromRow, fromCol, toRow, toCol, playerColor) {
    const piece = board[fromRow][fromCol];
    if (!piece || !piece.includes(playerColor)) return { valid: false, capturedPiece: null };

    const isKing = piece.includes('king');
    const isRed = piece.includes('red');
    const rowDiff = toRow - fromRow;
    const colDiff = Math.abs(toCol - fromCol);

    // Check if moving diagonally
    if (Math.abs(rowDiff) !== colDiff) return { valid: false, capturedPiece: null };

    // Direction check for non-kings
    if (!isKing) {
        if (isRed && rowDiff >= 0) return { valid: false, capturedPiece: null };
        if (!isRed && rowDiff <= 0) return { valid: false, capturedPiece: null };
    }

    // Check if destination is empty
    if (board[toRow][toCol] !== null) return { valid: false, capturedPiece: null };

    // Check for capture
    let capturedPiece = null;
    if (Math.abs(rowDiff) > 1) {
        const rowStep = rowDiff > 0 ? 1 : -1;
        const colStep = toCol > fromCol ? 1 : -1;
        let captureCount = 0;
        let currentRow = fromRow + rowStep;
        let currentCol = fromCol + colStep;

        while (currentRow !== toRow || currentCol !== toCol) {
            const currentPiece = board[currentRow][currentCol];
            if (currentPiece) {
                const isOpponent = currentPiece.includes(isRed ? 'black' : 'red');
                if (isOpponent) {
                    captureCount++;
                    capturedPiece = { row: currentRow, col: currentCol };
                } else {
                    return { valid: false, capturedPiece: null };
                }
            }
            currentRow += rowStep;
            currentCol += colStep;
        }

        if (captureCount !== 1) return { valid: false, capturedPiece: null };
    }

    return { valid: true, capturedPiece };
}

// Apply move to board and return captured piece
function applyMove(board, fromRow, fromCol, toRow, toCol, playerColor) {
    const newBoard = JSON.parse(JSON.stringify(board));
    const piece = newBoard[fromRow][fromCol];
    const isRed = piece.includes('red');
    const rowDiff = toRow - fromRow;

    // Move piece
    newBoard[toRow][toCol] = piece;
    newBoard[fromRow][fromCol] = null;

    // Remove captured pieces
    let capturedPiece = null;
    if (Math.abs(rowDiff) > 1) {
        const rowStep = rowDiff > 0 ? 1 : -1;
        const colStep = toCol > fromCol ? 1 : -1;
        let currentRow = fromRow + rowStep;
        let currentCol = fromCol + colStep;

        while (currentRow !== toRow || currentCol !== toCol) {
            if (newBoard[currentRow][currentCol]) {
                capturedPiece = { row: currentRow, col: currentCol };
                newBoard[currentRow][currentCol] = null;
            }
            currentRow += rowStep;
            currentCol += colStep;
        }
    }

    // Check for king promotion
    let promoted = false;
    if (piece === 'red' && toRow === 0) {
        newBoard[toRow][toCol] = 'king_red';
        promoted = true;
    } else if (piece === 'black' && toRow === 7) {
        newBoard[toRow][toCol] = 'king_black';
        promoted = true;
    }

    return { newBoard, capturedPiece, promoted };
}

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    socket.on('joinGame', (data) => {
        const { roomId, color, isHost } = data;
        console.log('📡 joinGame:', { roomId, color, isHost });

        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                players: [],
                board: null,
                currentPlayer: 'red',
                moves: []
            });
        }

        const room = rooms.get(roomId);
        room.players.push({ socketId: socket.id, color, isHost });
        socket.join(roomId);

        socket.emit('gameJoined', { success: true, gameId: roomId });

        if (room.board) {
            socket.emit('gameStateSync', {
                board: room.board,
                currentPlayer: room.currentPlayer
            });
        }

        socket.to(roomId).emit('playerJoined', { playerId: socket.id, color });
    });

    socket.on('syncGameState', (data) => {
        const { roomId, board, currentPlayer } = data;
        const room = rooms.get(roomId);
        if (room) {
            room.board = board;
            room.currentPlayer = currentPlayer;
            console.log(`📡 Game state saved for ${roomId}, currentPlayer: ${currentPlayer}`);
        }
    });

    socket.on('makeMove', (data) => {
        const { roomId, move } = data;
        const room = rooms.get(roomId);

        if (!room || !room.board) {
            socket.emit('moveRejected', { message: 'Game not found' });
            return;
        }

        // Validate move and get captured piece
        const validation = isValidMove(
            room.board,
            move.fromRow, move.fromCol,
            move.toRow, move.toCol,
            move.playerColor
        );

        if (!validation.valid) {
            socket.emit('moveRejected', { message: 'Invalid move' });
            return;
        }

        // Check if it's player's turn
        if (room.currentPlayer !== move.playerColor) {
            socket.emit('moveRejected', { message: 'Not your turn' });
            return;
        }

        // Apply move
        const result = applyMove(room.board, move.fromRow, move.fromCol, move.toRow, move.toCol, move.playerColor);
        room.board = result.newBoard;

        // Switch turn
        room.currentPlayer = room.currentPlayer === 'red' ? 'black' : 'red';
        room.moves.push(move);

        console.log(`♟️ Move in ${roomId}: ${move.playerColor} moved from [${move.fromRow},${move.fromCol}] to [${move.toRow},${move.toCol}]`);
        if (result.capturedPiece) {
            console.log(`   💥 Captured piece at [${result.capturedPiece.row},${result.capturedPiece.col}]`);
        }
        if (result.promoted) {
            console.log(`   👑 Promoted to king!`);
        }
        console.log(`   Now ${room.currentPlayer}'s turn`);

        // Create move data to send
        const moveData = {
            fromRow: move.fromRow,
            fromCol: move.fromCol,
            toRow: move.toRow,
            toCol: move.toCol,
            capturedPiece: result.capturedPiece,
            promoted: result.promoted,
            playerColor: move.playerColor,
            newBoard: room.board,
            currentPlayer: room.currentPlayer
        };

        // Check for win
        let redPieces = 0, blackPieces = 0;
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const piece = room.board[row][col];
                if (piece && piece.includes('red')) redPieces++;
                if (piece && piece.includes('black')) blackPieces++;
            }
        }

        if (redPieces === 0) {
            io.to(roomId).emit('gameOver', { winner: 'black', message: 'Black wins!' });
            console.log(`🏆 Game over: Black wins in ${roomId}`);
        } else if (blackPieces === 0) {
            io.to(roomId).emit('gameOver', { winner: 'red', message: 'Red wins!' });
            console.log(`🏆 Game over: Red wins in ${roomId}`);
        } else {
            // Broadcast to all players in room
            io.to(roomId).emit('opponentMove', moveData);

            // Send confirmation to mover
            socket.emit('moveConfirmed', moveData);
        }
    });

    socket.on('requestGameState', (data) => {
        const { roomId } = data;
        const room = rooms.get(roomId);
        if (room && room.board) {
            socket.emit('gameStateSync', {
                board: room.board,
                currentPlayer: room.currentPlayer
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);

        for (const [roomId, room] of rooms.entries()) {
            const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                socket.to(roomId).emit('opponentDisconnected');

                if (room.players.length === 0) {
                    rooms.delete(roomId);
                    console.log(`🗑️ Room ${roomId} deleted`);
                }
                break;
            }
        }
    });
});

// ============================================================
// modules/payments.js — Stripe, PayNow, PayPal
// Updated: Paynow supports wallet deposits (plan='wallet_deposit')
//          Poll endpoint updated to credit wallet balance in Firebase
// ============================================================

const Stripe = require('stripe');
const paypal = require('@paypal/checkout-server-sdk');
const { Paynow } = require('paynow');

// ── Client factories ──────────────────────────────────────────────────────────

function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
    return Stripe(process.env.STRIPE_SECRET_KEY);
}

function getPaynow() {
    if (!process.env.PAYNOW_INTEGRATION_ID || !process.env.PAYNOW_INTEGRATION_KEY)
        throw new Error('PAYNOW credentials not set');
    const pn = new Paynow(process.env.PAYNOW_INTEGRATION_ID, process.env.PAYNOW_INTEGRATION_KEY);
    const backendUrl = process.env.SERVER_URL || 'https://game-server-xvdu.onrender.com';
    const frontendUrl = process.env.REACT_APP_FRONTEND_URL || 'https://wintapgames.com';
    pn.resultUrl = `${backendUrl}/api/paynow/callback`;
    pn.returnUrl = `${frontendUrl}/wallet?status=returned`;
    return pn;
}

function getPayPalClient() {
    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)
        throw new Error('PayPal credentials not set');
    const env = process.env.PAYPAL_MODE === 'live'
        ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
        : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
    return new paypal.core.PayPalHttpClient(env);
}

// ── Shared finalisePayment ────────────────────────────────────────────────────
// Handles both subscription plan upgrades AND wallet deposits.

async function finalizePayment(userId, {
    amount, plan, billingCycle, paymentMethod, transactionId,
    stripeCustomerId, stripePaymentMethodId, cardLast4, cardBrand, cardExpiry
}) {
    const timestamp = Date.now();
    const db = admin.database();

    // ── Wallet deposit ──────────────────────────────────────────────────────
    if (plan === 'wallet_deposit') {
        // Atomically credit the wallet balance
        const walletRef = db.ref(`wallets/${userId}`);
        const walletSnap = await walletRef.once('value');
        const wallet = walletSnap.val() || {
            balance: 0, totalDeposited: 0, totalWithdrawn: 0,
            totalWon: 0, totalLost: 0, totalBonus: 0,
            currency: 'USD', isActive: true,
        };

        const newBalance = (wallet.balance || 0) + amount;
        const newTotalDeposited = (wallet.totalDeposited || 0) + amount;

        await walletRef.update({
            balance: newBalance,
            totalDeposited: newTotalDeposited,
            lastUpdated: new Date().toISOString(),
            isActive: true,
        });

        // Add transaction record
        const txRef = db.ref(`transactions/${userId}`).push();
        await txRef.set({
            type: 'deposit',
            amount,
            balance: newBalance,
            description: `Deposit of $${amount} via ${paymentMethod} (Ref: ${transactionId})`,
            status: 'completed',
            timestamp: new Date().toISOString(),
            currency: 'USD',
            paymentReference: transactionId,
            paymentMethod,
        });

        // Mark pending payment as completed
        await db.ref(`payments/${transactionId}`).update({
            status: 'completed',
            verifiedAt: new Date().toISOString(),
        });
        await db.ref(`payment_polls/${transactionId}`).update({ status: 'completed' });

        console.log(`✅ Wallet deposit finalized: user=${userId} amount=$${amount} newBalance=$${newBalance}`);
        return;
    }

    // ── Subscription plan upgrade ───────────────────────────────────────────
    const updateData = {
        plan, billingCycle,
        paymentStatus: 'active',
        lastPaymentDate: timestamp,
        updatedAt: timestamp,
        failedPaymentAttempts: 0,
    };
    if (stripeCustomerId) updateData.stripeCustomerId = stripeCustomerId;
    if (stripePaymentMethodId) updateData.stripePaymentMethodId = stripePaymentMethodId;
    if (cardLast4) updateData.cardLast4 = cardLast4;
    if (cardBrand) updateData.cardBrand = cardBrand;
    if (cardExpiry) updateData.cardExpiry = cardExpiry;

    await db.ref(`users/${userId}`).update(updateData);
    await db.ref(`invoices/${userId}/${timestamp}`).set({
        invoiceNumber: `INV-${timestamp}`,
        date: timestamp,
        amount, plan, billingCycle,
        status: 'paid',
        paymentMethod,
        transactionId,
        dueDate: timestamp + (billingCycle === 'monthly' ? 30 : 365) * 24 * 60 * 60 * 1000,
    });

    console.log(`✅ Subscription finalized: user=${userId} plan=${plan} amount=$${amount}`);
}

// ── Stripe helpers ────────────────────────────────────────────────────────────

async function getOrCreateStripeCustomer(stripe, userId, email) {
    const snap = await admin.database().ref(`users/${userId}`).once('value');
    const existing = (snap.val() || {}).stripeCustomerId;
    if (existing) return existing;

    const customer = await stripe.customers.create({ email, metadata: { userId } });
    await admin.database().ref(`users/${userId}`).update({
        stripeCustomerId: customer.id,
        updatedAt: Date.now(),
    });
    console.log(`✅ Stripe customer created: ${customer.id}`);
    return customer.id;
}

async function attachAndDefaultPM(stripe, customerId, paymentMethodId) {
    try {
        await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } catch (e) {
        if (e.code !== 'resource_already_exists') throw e;
    }
    await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
    });
}

async function getCardDetails(stripe, paymentMethodId) {
    try {
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        if (!pm.card) return {};
        return {
            cardLast4: pm.card.last4,
            cardBrand: pm.card.brand,
            cardExpiry: String(pm.card.exp_month).padStart(2, '0') + '/' +
                String(pm.card.exp_year).slice(-2),
        };
    } catch (_) { return {}; }
}

// ── Register payment routes ───────────────────────────────────────────────────

function registerPaymentRoutes(app) {

    // ── Stripe: create intent ─────────────────────────────────────────────────
    app.post('/api/stripe/create-payment-intent', async (req, res) => {
        try {
            const { amount, plan, billingCycle, email, userId } = req.body;
            if (amount === undefined || !plan || !email || !userId)
                return res.json({ success: false, error: 'Missing required fields' });

            const stripe = getStripe();
            const customerId = await getOrCreateStripeCustomer(stripe, userId, email);

            if (Number(amount) === 0) {
                const si = await stripe.setupIntents.create({
                    customer: customerId,
                    payment_method_types: ['card'],
                    metadata: { userId, plan, billingCycle },
                });
                return res.json({ success: true, clientSecret: si.client_secret, isSetupIntent: true });
            }

            const pi = await stripe.paymentIntents.create({
                amount: Math.round(amount * 100),
                currency: 'usd',
                customer: customerId,
                receipt_email: email,
                metadata: { plan, billingCycle, userId },
                automatic_payment_methods: { enabled: true },
            });
            res.json({ success: true, clientSecret: pi.client_secret, isSetupIntent: false });
        } catch (err) {
            console.error('create-intent error:', err.message);
            res.json({ success: false, error: err.message });
        }
    });

    // ── Stripe: save card after SetupIntent ───────────────────────────────────
    app.post('/api/stripe/save-card', async (req, res) => {
        try {
            const { setupIntentId, paymentMethodId, userId } = req.body;
            if (!paymentMethodId || !userId)
                return res.json({ success: false, error: 'Missing required fields' });

            const stripe = getStripe();
            let customerId = null;

            if (setupIntentId) {
                const si = await stripe.setupIntents.retrieve(setupIntentId);
                customerId = si.customer || null;
            }
            if (!customerId) {
                const snap = await admin.database().ref(`users/${userId}`).once('value');
                customerId = (snap.val() || {}).stripeCustomerId || null;
            }
            if (!customerId)
                return res.json({ success: false, error: 'No Stripe customer found. Please refresh and retry.' });

            await attachAndDefaultPM(stripe, customerId, paymentMethodId);
            const cardDetails = await getCardDetails(stripe, paymentMethodId);

            await admin.database().ref(`users/${userId}`).update({
                stripeCustomerId: customerId,
                stripePaymentMethodId: paymentMethodId,
                ...cardDetails,
                updatedAt: Date.now(),
            });
            res.json({ success: true });
        } catch (err) {
            console.error('save-card error:', err.message);
            res.json({ success: false, error: err.message });
        }
    });

    // ── Stripe: confirm payment ───────────────────────────────────────────────
    app.post('/api/stripe/confirm-payment', async (req, res) => {
        try {
            const { paymentIntentId, plan, billingCycle, userId } = req.body;
            if (!paymentIntentId || !userId)
                return res.json({ success: false, error: 'Missing required fields' });

            const stripe = getStripe();
            const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
            if (intent.status !== 'succeeded')
                return res.json({ success: false, error: `Payment status: ${intent.status}` });

            const snap = await admin.database().ref(`users/${userId}`).once('value');
            let customerId = (snap.val() || {}).stripeCustomerId || intent.customer || null;
            if (!customerId) {
                const c = await stripe.customers.create({ email: intent.receipt_email, metadata: { userId } });
                customerId = c.id;
            }

            await attachAndDefaultPM(stripe, customerId, intent.payment_method);
            const cardDetails = await getCardDetails(stripe, intent.payment_method);

            await finalizePayment(userId, {
                amount: intent.amount / 100,
                plan: plan || intent.metadata.plan,
                billingCycle: billingCycle || intent.metadata.billingCycle,
                paymentMethod: 'stripe_card',
                transactionId: paymentIntentId,
                stripeCustomerId: customerId,
                stripePaymentMethodId: intent.payment_method,
                ...cardDetails,
            });
            res.json({ success: true });
        } catch (err) {
            console.error('confirm-payment error:', err.message);
            res.json({ success: false, error: err.message });
        }
    });

    // ── Stripe: charge saved card off-session ─────────────────────────────────
    app.post('/api/stripe/charge-saved-card', async (req, res) => {
        try {
            const { amount, plan, billingCycle, userId, email, paymentMethodId } = req.body;
            if (!paymentMethodId || !userId || amount === undefined)
                return res.json({ success: false, error: 'Missing required fields' });

            const stripe = getStripe();
            const snap = await admin.database().ref(`users/${userId}`).once('value');
            const userData = snap.val();
            if (!userData) return res.json({ success: false, error: 'User not found' });

            const customerId = userData.stripeCustomerId;
            if (!customerId)
                return res.json({ success: false, error: 'No Stripe customer on file. Please re-add your card.' });

            await attachAndDefaultPM(stripe, customerId, paymentMethodId);

            const pi = await stripe.paymentIntents.create({
                amount: Math.round(amount * 100),
                currency: 'usd',
                customer: customerId,
                payment_method: paymentMethodId,
                receipt_email: email,
                off_session: true,
                confirm: true,
                metadata: { plan, billingCycle, userId, source: 'saved_card' },
            });

            if (pi.status !== 'succeeded')
                return res.json({ success: false, error: `Unexpected payment status: ${pi.status}` });

            await finalizePayment(userId, {
                amount, plan, billingCycle,
                paymentMethod: 'stripe_card_saved',
                transactionId: pi.id,
                stripeCustomerId: customerId,
                stripePaymentMethodId: paymentMethodId,
            });
            res.json({ success: true, transactionId: pi.id });
        } catch (err) {
            console.error('charge-saved-card error:', err.message);
            const friendly = {
                authentication_required: 'Card requires authentication. Please re-enter your card details.',
                card_declined: 'Card declined. Please try a different payment method.',
                insufficient_funds: 'Insufficient funds on card.',
                expired_card: 'Card has expired. Please update your payment method.',
                incorrect_cvc: 'Incorrect CVC. Please re-enter your card details.',
                processing_error: 'Processing error. Please try again shortly.',
            };
            res.json({ success: false, error: friendly[err.code] || err.message });
        }
    });

    // ── Stripe: webhook ───────────────────────────────────────────────────────
    app.post('/api/stripe/webhook',
        require('express').raw({ type: 'application/json' }),
        async (req, res) => {
            const sig = req.headers['stripe-signature'];
            const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
            let event;
            try {
                event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
            } catch (err) {
                console.error('Stripe webhook sig error:', err.message);
                return res.status(400).send('Webhook signature error');
            }

            if (event.type === 'payment_intent.succeeded') {
                const intent = event.data.object;
                const { userId, plan, billingCycle } = intent.metadata;
                if (userId) {
                    await finalizePayment(userId, {
                        amount: intent.amount / 100,
                        plan, billingCycle,
                        paymentMethod: 'stripe_card',
                        transactionId: intent.id,
                    });
                }
            }

            if (event.type === 'payment_intent.payment_failed') {
                const intent = event.data.object;
                const { userId } = intent.metadata || {};
                if (userId) {
                    const snap = await admin.database().ref(`users/${userId}`).once('value');
                    const userData = snap.val() || {};
                    const attempts = (userData.failedPaymentAttempts || 0) + 1;
                    await admin.database().ref(`users/${userId}`).update({ failedPaymentAttempts: attempts });
                    if (attempts >= 3) {
                        await admin.database().ref(`users/${userId}`).update({
                            plan: 'free', paymentStatus: 'failed', downgradedAt: Date.now(),
                        });
                        console.log(`⚠️ User ${userId} downgraded after 3 failed payments`);
                    }
                }
            }
            res.sendStatus(200);
        }
    );

    // ── PayNow: create payment ────────────────────────────────────────────────
    // Now accepts plan='wallet_deposit' in addition to subscription plans.
    // For mobile (ecocash/innbucks): polls in-page, no redirect needed.
    // For web: redirect flow (returnUrl set above).
    app.post('/api/paynow/create', async (req, res) => {
        try {
            const { amount, email, phone, plan, billingCycle, userId, method } = req.body;

            if (!amount || !userId)
                return res.json({ success: false, error: 'amount and userId are required' });

            const isTest = (process.env.PAYMENT_GATEWAY || 'test') === 'test';
            const pn = getPaynow();
            const reference = `${plan === 'wallet_deposit' ? 'wallet' : 'zimchat'}_${userId}_${Date.now()}`;
            const payEmail = isTest
                ? (process.env.PAYMENT_GATEWAY_TEST_EMAIL || 'wintapgames@gmail.com')
                : (email || 'customer@example.com');

            const payment = pn.createPayment(reference, payEmail);
            const label = plan === 'wallet_deposit'
                ? `Wallet Deposit`
                : `ZimChat ${plan} Plan (${billingCycle})`;
            payment.add(label, parseFloat(amount));

            let response;
            if (isTest) {
                response = await pn.send(payment);
            } else if (method === 'ecocash') {
                if (!phone) return res.json({ success: false, error: 'Phone number required for EcoCash' });
                response = await pn.sendMobile(payment, phone, 'ecocash');
            } else if (method === 'innbucks') {
                if (!phone) return res.json({ success: false, error: 'Phone number required for InnBucks' });
                response = await pn.sendMobile(payment, phone, 'innbucks');
            } else {
                // web / USSD redirect
                response = await pn.send(payment);
            }

            if (!response.success) {
                console.error('Paynow full response:', JSON.stringify(response, null, 2));
                return res.json({ success: false, error: response.errors?.join(', ') || 'PayNow initiation failed' });
            }
            // Store pending payment record (used by both poll and callback)
            await admin.database().ref(`pendingPayments/${reference}`).set({
                userId, plan, billingCycle: billingCycle || 'once',
                amount: parseFloat(amount),
                pollUrl: response.pollUrl,
                reference,
                isTest,
                createdAt: Date.now(),
                processed: false,
            });

            // Also store in payments/ so the wallet can track status
            await admin.database().ref(`payments/${reference}`).set({
                userId, amount: parseFloat(amount),
                status: 'pending',
                processingStarted: false,
                processedBy: null,
                createdAt: new Date().toISOString(),
            });

            // Store poll URL
            await admin.database().ref(`payment_polls/${reference}`).set({
                pollUrl: response.pollUrl,
                status: 'pending',
                createdAt: new Date().toISOString(),
            });

            // Web redirect flow
            if (response.redirectUrl) {
                return res.json({
                    success: true,
                    redirectUrl: response.redirectUrl,
                    pollUrl: response.pollUrl,
                    reference,
                    isTest,
                });
            }

            // Mobile prompt sent — client will poll
            res.json({
                success: true,
                pollUrl: response.pollUrl,
                reference,
                isTest,
                instructions: `Payment prompt of $${amount} sent to ${phone}. Approve on your phone.`,
            });
        } catch (err) {
            console.error('Paynow create error:', err.message);
            res.json({ success: false, error: err.message });
        }
    });

    // ── PayNow: callback (from Paynow servers — server-to-server) ────────────
    app.post('/api/paynow/callback', async (req, res) => {
        console.log('🔔 Paynow callback:', JSON.stringify(req.body));
        try {
            const pn = getPaynow();
            const isValid = pn.verifyPayment(req.body);
            if (!isValid) return res.status(400).send('Invalid signature');

            const { reference, status, paynowreference, amount } = req.body;

            if (status && ['paid', 'awaiting delivery'].includes(status.toLowerCase())) {
                const snap = await admin.database().ref(`pendingPayments/${reference}`).once('value');
                const pending = snap.val();

                if (pending?.userId && !pending.processed) {
                    // Mark as processed before doing work (idempotency guard)
                    await admin.database().ref(`pendingPayments/${reference}`).update({ processed: true });

                    await finalizePayment(pending.userId, {
                        amount: pending.amount || parseFloat(amount),
                        plan: pending.plan,
                        billingCycle: pending.billingCycle,
                        paymentMethod: 'paynow',
                        transactionId: paynowreference || reference,
                    });

                    await admin.database().ref(`pendingPayments/${reference}`).remove();
                }
            }
            res.sendStatus(200);
        } catch (err) {
            console.error('Paynow callback error:', err.message);
            res.sendStatus(500);
        }
    });

    // ── PayNow: poll (called by the React wallet on an interval) ─────────────
    // Accepts: pollUrl, userId, plan, billingCycle, amount, reference
    app.get('/api/paynow/poll', async (req, res) => {
        try {
            const { pollUrl, userId, plan, billingCycle, amount, reference } = req.query;
            if (!pollUrl) return res.json({ success: false, error: 'pollUrl required' });

            const pn = getPaynow();
            const status = await pn.pollTransaction(pollUrl);
            const isPaid = typeof status.paid === 'function' ? status.paid() : status.status === 'paid';

            if (isPaid && userId) {
                // Idempotency: check if already processed
                const pendingSnap = await admin.database().ref(`pendingPayments/${reference}`).once('value');
                const pending = pendingSnap.val();

                // Also check payments/ node
                const paymentSnap = await admin.database().ref(`payments/${reference}`).once('value');
                const payment = paymentSnap.val();

                const alreadyDone = payment?.status === 'completed' || pending?.processed === true;

                if (!alreadyDone) {
                    // Guard against double-processing
                    await admin.database().ref(`payments/${reference}`).update({
                        processingStarted: true,
                        processingStartedAt: new Date().toISOString(),
                    });

                    await finalizePayment(userId, {
                        amount: parseFloat(amount) || (pending?.amount) || 0,
                        plan: plan || pending?.plan || 'wallet_deposit',
                        billingCycle: billingCycle || pending?.billingCycle || 'once',
                        paymentMethod: 'paynow',
                        transactionId: reference || pollUrl,
                    });

                    if (pending) {
                        await admin.database().ref(`pendingPayments/${reference}`).update({ processed: true });
                    }
                }
            }

            res.json({ success: true, paid: isPaid, status: status.status || 'pending' });
        } catch (err) {
            console.error('Paynow poll error:', err.message);
            res.json({ success: false, error: err.message, paid: false });
        }
    });

    // ── PayPal: create order ──────────────────────────────────────────────────
    app.post('/api/paypal/create-order', async (req, res) => {
        try {
            const { amount, plan, billingCycle, email, userId } = req.body;
            const client = getPayPalClient();
            const request = new paypal.orders.OrdersCreateRequest();
            request.prefer('return=representation');
            request.requestBody({
                intent: 'CAPTURE',
                purchase_units: [{
                    reference_id: `zimchat_${userId}_${Date.now()}`,
                    description: `ZimChat ${plan} Plan (${billingCycle})`,
                    amount: { currency_code: 'USD', value: Number(amount).toFixed(2) },
                    custom_id: JSON.stringify({ userId, plan, billingCycle }),
                }],
                application_context: { brand_name: 'ZimChat', user_action: 'PAY_NOW' },
            });
            const order = await client.execute(request);
            res.json({ success: true, orderId: order.result.id });
        } catch (err) {
            console.error('PayPal create-order error:', err.message);
            res.json({ success: false, error: err.message });
        }
    });

    // ── PayPal: capture order ─────────────────────────────────────────────────
    app.post('/api/paypal/capture-order', async (req, res) => {
        try {
            const { orderId, plan, billingCycle, userId } = req.body;
            const client = getPayPalClient();
            const request = new paypal.orders.OrdersCaptureRequest(orderId);
            request.requestBody({});

            const capture = await client.execute(request);
            const result = capture.result;
            if (result.status !== 'COMPLETED')
                return res.json({ success: false, error: `PayPal status: ${result.status}` });

            const pu = result.purchase_units[0];
            const amount = parseFloat(pu.payments.captures[0].amount.value);
            const transactionId = pu.payments.captures[0].id;

            let resolvedUserId = userId;
            if (!resolvedUserId && pu.custom_id) {
                try { resolvedUserId = JSON.parse(pu.custom_id).userId; } catch (_) { }
            }

            await finalizePayment(resolvedUserId, { amount, plan, billingCycle, paymentMethod: 'paypal', transactionId });
            res.json({ success: true, transactionId });
        } catch (err) {
            console.error('PayPal capture error:', err.message);
            res.json({ success: false, error: err.message });
        }
    });

    // ── Subscription management ───────────────────────────────────────────────
    app.post('/api/cancel-subscription', async (req, res) => {
        try {
            const { userId } = req.body;
            const snap = await admin.database().ref(`users/${userId}`).once('value');
            const user = snap.val();
            if (!user) return res.json({ success: false, error: 'User not found' });

            await admin.database().ref(`users/${userId}`).update({
                cancelAtPeriodEnd: true,
                cancelledAt: Date.now(),
                subscriptionStatus: 'cancelling',
            });

            const lastPaymentDate = user.lastPaymentDate || user.createdAt;
            const daysInCycle = user.billingCycle === 'monthly' ? 30 : 365;
            const endDate = lastPaymentDate + (daysInCycle * 24 * 60 * 60 * 1000);

            res.json({ success: true, endDate });
        } catch (err) {
            console.error('Cancel subscription error:', err.message);
            res.json({ success: false, error: err.message });
        }
    });

    app.post('/api/reactivate-subscription', async (req, res) => {
        try {
            const { userId } = req.body;
            await admin.database().ref(`users/${userId}`).update({
                cancelAtPeriodEnd: false,
                subscriptionStatus: 'active',
            });
            res.json({ success: true });
        } catch (err) {
            res.json({ success: false, error: err.message });
        }
    });

    // ── Admin / debug ─────────────────────────────────────────────────────────
    app.get('/api/debug/user-stripe/:userId', async (req, res) => {
        const snap = await admin.database().ref(`users/${req.params.userId}`).once('value');
        const u = snap.val();
        if (!u) return res.json({ error: 'User not found' });
        res.json({
            userId: req.params.userId,
            stripeCustomerId: u.stripeCustomerId || '❌ MISSING',
            stripePaymentMethodId: u.stripePaymentMethodId || '❌ MISSING',
            cardLast4: u.cardLast4 || '❌ MISSING',
            cardBrand: u.cardBrand || '❌ MISSING',
            cardExpiry: u.cardExpiry || '❌ MISSING',
            plan: u.plan,
            paymentStatus: u.paymentStatus,
        });
    });

    app.post('/api/admin/backfill-stripe-customers', async (req, res) => {
        const stripe = getStripe();
        const usersSnap = await admin.database().ref('users').once('value');
        const users = usersSnap.val() || {};
        const results = { fixed: [], skipped: [], errors: [] };

        for (const [userId, u] of Object.entries(users)) {
            if (u.stripeCustomerId) { results.skipped.push(userId); continue; }
            if (u.stripePaymentMethodId) {
                try {
                    const pm = await stripe.paymentMethods.retrieve(u.stripePaymentMethodId);
                    if (pm.customer) {
                        await admin.database().ref(`users/${userId}`).update({
                            stripeCustomerId: pm.customer, updatedAt: Date.now(),
                        });
                        results.fixed.push({ userId, customerId: pm.customer });
                    } else {
                        results.errors.push({ userId, reason: 'PM has no customer in Stripe' });
                    }
                } catch (e) {
                    results.errors.push({ userId, reason: e.message });
                }
            } else {
                results.skipped.push(userId);
            }
        }
        res.json({ success: true, ...results });
    });
}

module.exports = { registerPaymentRoutes, finalizePayment, getStripe };
registerPaymentRoutes(app);
const PORT = 3001;
server.listen(PORT, () => {
    console.log(`🎮 Socket server running on https://game-server-xvdu.onrender.com:${PORT}`);
});