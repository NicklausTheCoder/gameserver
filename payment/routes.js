// ============================================================
// payment/routes.js
// Stripe, PayNow, PayPal payment routes
// ============================================================

'use strict';

const admin  = require('firebase-admin');
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
  const pn          = new Paynow(process.env.PAYNOW_INTEGRATION_ID, process.env.PAYNOW_INTEGRATION_KEY);
  const backendUrl  = process.env.SERVER_URL          || 'https://game-server-xvdu.onrender.com';
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

// ── Shared helpers ────────────────────────────────────────────────────────────

async function getOrCreateStripeCustomer(stripe, userId, email) {
  const snap     = await admin.database().ref(`users/${userId}`).once('value');
  const existing = (snap.val() || {}).stripeCustomerId;
  if (existing) return existing;
  const customer = await stripe.customers.create({ email, metadata: { userId } });
  await admin.database().ref(`users/${userId}`).update({ stripeCustomerId: customer.id, updatedAt: Date.now() });
  console.log(`✅ Stripe customer created: ${customer.id}`);
  return customer.id;
}

async function attachAndDefaultPM(stripe, customerId, paymentMethodId) {
  try { await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }); }
  catch (e) { if (e.code !== 'resource_already_exists') throw e; }
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
}

async function getCardDetails(stripe, paymentMethodId) {
  try {
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (!pm.card) return {};
    return {
      cardLast4:  pm.card.last4,
      cardBrand:  pm.card.brand,
      cardExpiry: String(pm.card.exp_month).padStart(2, '0') + '/' + String(pm.card.exp_year).slice(-2),
    };
  } catch (_) { return {}; }
}

// ── Payment finalization (shared across gateways) ─────────────────────────────

async function finalizePayment(userId, {
  amount, plan, billingCycle, paymentMethod, transactionId,
  stripeCustomerId, stripePaymentMethodId, cardLast4, cardBrand, cardExpiry,
}) {
  const db        = admin.database();
  const timestamp = Date.now();

  // ── Wallet deposit ──────────────────────────────────────────────────────────
  if (plan === 'wallet_deposit') {
    const walletRef  = db.ref(`wallets/${userId}`);
    const walletSnap = await walletRef.once('value');
    const wallet     = walletSnap.val() || {
      balance: 0, totalDeposited: 0, totalWithdrawn: 0,
      totalWon: 0, totalLost: 0, totalBonus: 0, currency: 'USD', isActive: true,
    };
    const newBalance      = (wallet.balance       || 0) + amount;
    const newTotalDeposited = (wallet.totalDeposited || 0) + amount;

    await walletRef.update({
      balance: newBalance, totalDeposited: newTotalDeposited,
      lastUpdated: new Date().toISOString(), isActive: true,
    });

    const txRef = db.ref(`transactions/${userId}`).push();
    await txRef.set({
      type: 'deposit', amount, balance: newBalance,
      description: `Deposit of $${amount} via ${paymentMethod} (Ref: ${transactionId})`,
      status: 'completed', timestamp: new Date().toISOString(), currency: 'USD',
      paymentReference: transactionId, paymentMethod,
    });

    await db.ref(`payments/${transactionId}`).update({ status: 'completed', verifiedAt: new Date().toISOString() });
    await db.ref(`payment_polls/${transactionId}`).update({ status: 'completed' });

    console.log(`✅ Wallet deposit finalized: user=${userId} amount=$${amount} newBalance=$${newBalance}`);
    return;
  }

  // ── Subscription ────────────────────────────────────────────────────────────
  const updateData = {
    plan, billingCycle, paymentStatus: 'active',
    lastPaymentDate: timestamp, updatedAt: timestamp, failedPaymentAttempts: 0,
  };
  if (stripeCustomerId)       updateData.stripeCustomerId       = stripeCustomerId;
  if (stripePaymentMethodId)  updateData.stripePaymentMethodId  = stripePaymentMethodId;
  if (cardLast4)  updateData.cardLast4  = cardLast4;
  if (cardBrand)  updateData.cardBrand  = cardBrand;
  if (cardExpiry) updateData.cardExpiry = cardExpiry;

  await db.ref(`users/${userId}`).update(updateData);
  await db.ref(`invoices/${userId}/${timestamp}`).set({
    invoiceNumber: `INV-${timestamp}`, date: timestamp,
    amount, plan, billingCycle, status: 'paid', paymentMethod, transactionId,
    dueDate: timestamp + (billingCycle === 'monthly' ? 30 : 365) * 24 * 60 * 60 * 1000,
  });

  console.log(`✅ Subscription finalized: user=${userId} plan=${plan} amount=$${amount}`);
}

// ── Route registration ────────────────────────────────────────────────────────

function registerPaymentRoutes(app) {

  // ── Stripe ──────────────────────────────────────────────────────────────────

  app.post('/api/stripe/create-payment-intent', async (req, res) => {
    try {
      const { amount, plan, billingCycle, email, userId } = req.body;
      if (amount === undefined || !plan || !email || !userId)
        return res.json({ success: false, error: 'Missing required fields' });

      const stripe     = getStripe();
      const customerId = await getOrCreateStripeCustomer(stripe, userId, email);

      if (Number(amount) === 0) {
        const si = await stripe.setupIntents.create({
          customer: customerId, payment_method_types: ['card'],
          metadata: { userId, plan, billingCycle },
        });
        return res.json({ success: true, clientSecret: si.client_secret, isSetupIntent: true });
      }

      const pi = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), currency: 'usd', customer: customerId,
        receipt_email: email, metadata: { plan, billingCycle, userId },
        automatic_payment_methods: { enabled: true },
      });
      res.json({ success: true, clientSecret: pi.client_secret, isSetupIntent: false });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/stripe/save-card', async (req, res) => {
    try {
      const { setupIntentId, paymentMethodId, userId } = req.body;
      if (!paymentMethodId || !userId) return res.json({ success: false, error: 'Missing required fields' });

      const stripe = getStripe();
      let customerId = null;
      if (setupIntentId) { const si = await stripe.setupIntents.retrieve(setupIntentId); customerId = si.customer || null; }
      if (!customerId)   { const snap = await admin.database().ref(`users/${userId}`).once('value'); customerId = (snap.val() || {}).stripeCustomerId || null; }
      if (!customerId)   return res.json({ success: false, error: 'No Stripe customer found.' });

      await attachAndDefaultPM(stripe, customerId, paymentMethodId);
      const cardDetails = await getCardDetails(stripe, paymentMethodId);
      await admin.database().ref(`users/${userId}`).update({ stripeCustomerId: customerId, stripePaymentMethodId: paymentMethodId, ...cardDetails, updatedAt: Date.now() });
      res.json({ success: true });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/stripe/confirm-payment', async (req, res) => {
    try {
      const { paymentIntentId, plan, billingCycle, userId } = req.body;
      if (!paymentIntentId || !userId) return res.json({ success: false, error: 'Missing required fields' });

      const stripe = getStripe();
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (intent.status !== 'succeeded') return res.json({ success: false, error: `Payment status: ${intent.status}` });

      const snap       = await admin.database().ref(`users/${userId}`).once('value');
      let customerId   = (snap.val() || {}).stripeCustomerId || intent.customer || null;
      if (!customerId) { const c = await stripe.customers.create({ email: intent.receipt_email, metadata: { userId } }); customerId = c.id; }

      await attachAndDefaultPM(stripe, customerId, intent.payment_method);
      const cardDetails = await getCardDetails(stripe, intent.payment_method);

      await finalizePayment(userId, {
        amount: intent.amount / 100, plan: plan || intent.metadata.plan,
        billingCycle: billingCycle || intent.metadata.billingCycle,
        paymentMethod: 'stripe_card', transactionId: paymentIntentId,
        stripeCustomerId: customerId, stripePaymentMethodId: intent.payment_method,
        ...cardDetails,
      });
      res.json({ success: true });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/stripe/charge-saved-card', async (req, res) => {
    try {
      const { amount, plan, billingCycle, userId, email, paymentMethodId } = req.body;
      if (!paymentMethodId || !userId || amount === undefined)
        return res.json({ success: false, error: 'Missing required fields' });

      const stripe   = getStripe();
      const snap     = await admin.database().ref(`users/${userId}`).once('value');
      const userData = snap.val();
      if (!userData) return res.json({ success: false, error: 'User not found' });

      const customerId = userData.stripeCustomerId;
      if (!customerId) return res.json({ success: false, error: 'No Stripe customer on file.' });

      await attachAndDefaultPM(stripe, customerId, paymentMethodId);

      const pi = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), currency: 'usd', customer: customerId,
        payment_method: paymentMethodId, receipt_email: email,
        off_session: true, confirm: true,
        metadata: { plan, billingCycle, userId, source: 'saved_card' },
      });

      if (pi.status !== 'succeeded') return res.json({ success: false, error: `Unexpected status: ${pi.status}` });

      await finalizePayment(userId, { amount, plan, billingCycle, paymentMethod: 'stripe_card_saved', transactionId: pi.id, stripeCustomerId: customerId, stripePaymentMethodId: paymentMethodId });
      res.json({ success: true, transactionId: pi.id });
    } catch (err) {
      const friendly = {
        authentication_required: 'Card requires authentication.',
        card_declined:           'Card declined.',
        insufficient_funds:      'Insufficient funds.',
        expired_card:            'Card has expired.',
        incorrect_cvc:           'Incorrect CVC.',
        processing_error:        'Processing error. Please try again.',
      };
      res.json({ success: false, error: friendly[err.code] || err.message });
    }
  });

  app.post('/api/stripe/webhook',
    require('express').raw({ type: 'application/json' }),
    async (req, res) => {
      const sig = req.headers['stripe-signature'];
      let event;
      try { event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
      catch (_) { return res.status(400).send('Webhook signature error'); }

      if (event.type === 'payment_intent.succeeded') {
        const intent = event.data.object;
        const { userId, plan, billingCycle } = intent.metadata;
        if (userId) await finalizePayment(userId, { amount: intent.amount / 100, plan, billingCycle, paymentMethod: 'stripe_card', transactionId: intent.id });
      }

      if (event.type === 'payment_intent.payment_failed') {
        const { userId } = event.data.object.metadata || {};
        if (userId) {
          const snap     = await admin.database().ref(`users/${userId}`).once('value');
          const attempts = ((snap.val() || {}).failedPaymentAttempts || 0) + 1;
          await admin.database().ref(`users/${userId}`).update({ failedPaymentAttempts: attempts });
          if (attempts >= 3) {
            await admin.database().ref(`users/${userId}`).update({ plan: 'free', paymentStatus: 'failed', downgradedAt: Date.now() });
          }
        }
      }

      res.sendStatus(200);
    }
  );

  // ── PayNow ──────────────────────────────────────────────────────────────────

  app.post('/api/paynow/create', async (req, res) => {
    try {
      const { amount, email, phone, plan, billingCycle, userId, method } = req.body;
      if (!amount || !userId) return res.json({ success: false, error: 'amount and userId are required' });

      const isTest   = (process.env.PAYMENT_GATEWAY || 'test') === 'test';
      const pn       = getPaynow();
      const reference = `${plan === 'wallet_deposit' ? 'wallet' : 'zimchat'}_${userId}_${Date.now()}`;
      const payEmail  = isTest ? (process.env.PAYMENT_GATEWAY_TEST_EMAIL || 'wintapgames@gmail.com') : (email || 'theorg.thone.com');

      const payment = pn.createPayment(reference, payEmail);
      payment.add(plan === 'wallet_deposit' ? 'Wallet Deposit' : `ZimChat ${plan} Plan (${billingCycle})`, parseFloat(amount));

      let response;
      if (isTest)              response = await pn.send(payment);
      else if (method === 'ecocash') { if (!phone) return res.json({ success: false, error: 'Phone required' }); response = await pn.sendMobile(payment, phone, 'ecocash'); }
      else if (method === 'innbucks') { if (!phone) return res.json({ success: false, error: 'Phone required' }); response = await pn.sendMobile(payment, phone, 'innbucks'); }
      else                     response = await pn.send(payment);

      if (!response.success) return res.json({ success: false, error: response.errors?.join(', ') || 'PayNow failed' });

      await admin.database().ref(`pendingPayments/${reference}`).set({ userId, plan, billingCycle: billingCycle || 'once', amount: parseFloat(amount), pollUrl: response.pollUrl, reference, isTest, createdAt: Date.now(), processed: false });
      await admin.database().ref(`payments/${reference}`).set({ userId, amount: parseFloat(amount), status: 'pending', processingStarted: false, processedBy: null, createdAt: new Date().toISOString() });
      await admin.database().ref(`payment_polls/${reference}`).set({ pollUrl: response.pollUrl, status: 'pending', createdAt: new Date().toISOString() });

      if (response.redirectUrl) return res.json({ success: true, redirectUrl: response.redirectUrl, pollUrl: response.pollUrl, reference, isTest });
      res.json({ success: true, pollUrl: response.pollUrl, reference, isTest, instructions: `Payment prompt of $${amount} sent to ${phone}.` });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/paynow/callback', async (req, res) => {
    try {
      const pn = getPaynow();
      if (!pn.verifyPayment(req.body)) return res.status(400).send('Invalid signature');

      const { reference, status, paynowreference, amount } = req.body;
      if (status && ['paid', 'awaiting delivery'].includes(status.toLowerCase())) {
        const snap    = await admin.database().ref(`pendingPayments/${reference}`).once('value');
        const pending = snap.val();
        if (pending?.userId && !pending.processed) {
          await admin.database().ref(`pendingPayments/${reference}`).update({ processed: true });
          await finalizePayment(pending.userId, { amount: pending.amount || parseFloat(amount), plan: pending.plan, billingCycle: pending.billingCycle, paymentMethod: 'paynow', transactionId: paynowreference || reference });
          await admin.database().ref(`pendingPayments/${reference}`).remove();
        }
      }
      res.sendStatus(200);
    } catch (_) { res.sendStatus(500); }
  });

  app.get('/api/paynow/poll', async (req, res) => {
    try {
      const { pollUrl, userId, plan, billingCycle, amount, reference } = req.query;
      if (!pollUrl) return res.json({ success: false, error: 'pollUrl required' });

      const pn     = getPaynow();
      const status = await pn.pollTransaction(pollUrl);
      const isPaid = typeof status.paid === 'function' ? status.paid() : status.status === 'paid';

      if (isPaid && userId) {
        const pendingSnap = await admin.database().ref(`pendingPayments/${reference}`).once('value');
        const pending     = pendingSnap.val();
        const paymentSnap = await admin.database().ref(`payments/${reference}`).once('value');
        const payment     = paymentSnap.val();
        const alreadyDone = payment?.status === 'completed' || pending?.processed === true;

        if (!alreadyDone) {
          await admin.database().ref(`payments/${reference}`).update({ processingStarted: true, processingStartedAt: new Date().toISOString() });
          await finalizePayment(userId, { amount: parseFloat(amount) || pending?.amount || 0, plan: plan || pending?.plan || 'wallet_deposit', billingCycle: billingCycle || pending?.billingCycle || 'once', paymentMethod: 'paynow', transactionId: reference || pollUrl });
          if (pending) await admin.database().ref(`pendingPayments/${reference}`).update({ processed: true });
        }
      }
      res.json({ success: true, paid: isPaid, status: status.status || 'pending' });
    } catch (err) { res.json({ success: false, error: err.message, paid: false }); }
  });

  // ── PayPal ──────────────────────────────────────────────────────────────────

  app.post('/api/paypal/create-order', async (req, res) => {
    try {
      const { amount, plan, billingCycle, email, userId } = req.body;
      const client  = getPayPalClient();
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer('return=representation');
      request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: `zimchat_${userId}_${Date.now()}`,
          description:  `ZimChat ${plan} Plan (${billingCycle})`,
          amount:       { currency_code: 'USD', value: Number(amount).toFixed(2) },
          custom_id:    JSON.stringify({ userId, plan, billingCycle }),
        }],
        application_context: { brand_name: 'ZimChat', user_action: 'PAY_NOW' },
      });
      const order = await client.execute(request);
      res.json({ success: true, orderId: order.result.id });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/paypal/capture-order', async (req, res) => {
    try {
      const { orderId, plan, billingCycle, userId } = req.body;
      const client  = getPayPalClient();
      const request = new paypal.orders.OrdersCaptureRequest(orderId);
      request.requestBody({});
      const capture = await client.execute(request);
      const result  = capture.result;
      if (result.status !== 'COMPLETED') return res.json({ success: false, error: `PayPal status: ${result.status}` });

      const pu              = result.purchase_units[0];
      const amount          = parseFloat(pu.payments.captures[0].amount.value);
      const transactionId   = pu.payments.captures[0].id;
      let resolvedUserId    = userId;
      if (!resolvedUserId && pu.custom_id) { try { resolvedUserId = JSON.parse(pu.custom_id).userId; } catch (_) {} }

      await finalizePayment(resolvedUserId, { amount, plan, billingCycle, paymentMethod: 'paypal', transactionId });
      res.json({ success: true, transactionId });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── Subscription management ──────────────────────────────────────────────────

  app.post('/api/cancel-subscription', async (req, res) => {
    try {
      const { userId } = req.body;
      const snap       = await admin.database().ref(`users/${userId}`).once('value');
      const user       = snap.val();
      if (!user) return res.json({ success: false, error: 'User not found' });
      await admin.database().ref(`users/${userId}`).update({ cancelAtPeriodEnd: true, cancelledAt: Date.now(), subscriptionStatus: 'cancelling' });
      const daysInCycle = user.billingCycle === 'monthly' ? 30 : 365;
      res.json({ success: true, endDate: (user.lastPaymentDate || user.createdAt) + (daysInCycle * 24 * 60 * 60 * 1000) });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  app.post('/api/reactivate-subscription', async (req, res) => {
    try {
      const { userId } = req.body;
      await admin.database().ref(`users/${userId}`).update({ cancelAtPeriodEnd: false, subscriptionStatus: 'active' });
      res.json({ success: true });
    } catch (err) { res.json({ success: false, error: err.message }); }
  });

  // ── Admin / debug ────────────────────────────────────────────────────────────

  app.get('/api/debug/user-stripe/:userId', async (req, res) => {
    const snap = await admin.database().ref(`users/${req.params.userId}`).once('value');
    const u    = snap.val();
    if (!u) return res.json({ error: 'User not found' });
    res.json({
      userId:                req.params.userId,
      stripeCustomerId:      u.stripeCustomerId      || '❌ MISSING',
      stripePaymentMethodId: u.stripePaymentMethodId || '❌ MISSING',
      cardLast4:             u.cardLast4             || '❌ MISSING',
      cardBrand:             u.cardBrand             || '❌ MISSING',
      cardExpiry:            u.cardExpiry            || '❌ MISSING',
      plan:                  u.plan,
      paymentStatus:         u.paymentStatus,
    });
  });

  app.post('/api/admin/backfill-stripe-customers', async (req, res) => {
    const stripe    = getStripe();
    const usersSnap = await admin.database().ref('users').once('value');
    const users     = usersSnap.val() || {};
    const results   = { fixed: [], skipped: [], errors: [] };

    for (const [userId, u] of Object.entries(users)) {
      if (u.stripeCustomerId) { results.skipped.push(userId); continue; }
      if (u.stripePaymentMethodId) {
        try {
          const pm = await stripe.paymentMethods.retrieve(u.stripePaymentMethodId);
          if (pm.customer) {
            await admin.database().ref(`users/${userId}`).update({ stripeCustomerId: pm.customer, updatedAt: Date.now() });
            results.fixed.push({ userId, customerId: pm.customer });
          } else { results.errors.push({ userId, reason: 'PM has no customer in Stripe' }); }
        } catch (e) { results.errors.push({ userId, reason: e.message }); }
      } else { results.skipped.push(userId); }
    }
    res.json({ success: true, ...results });
  });
}

module.exports = { registerPaymentRoutes, finalizePayment, getStripe };
