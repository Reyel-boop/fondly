const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());
app.use(cors());

// Serve the frontend (fondly-app) as static files from this same server/origin.
// This lets the app run entirely from http://localhost:3000, which is required
// for the service worker + "Add to Home Screen" / PWA install feature to work
// (browsers refuse to register service workers on file:// pages).
app.use(express.static(path.join(__dirname, '..', 'fondly-app')));

const PORT = process.env.PORT || 3000;

// Public web address of this app. On your own computer this stays
// http://localhost:3000; on Render, set APP_BASE_URL to your real
// https://your-app.onrender.com address (Environment tab) so PayMongo's
// GCash/QR Ph redirect-back links point somewhere reachable by real phones.
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const anonClient = require('./supabaseClient');
const pendingGcashSources = new Map();


async function requirePremium(req, res, next) {
  const { data, error } = await req.supabase
    .from('premium_status')
    .select('is_premium')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data || !data.is_premium) {
    return res.status(403).json({ error: 'This feature requires Fondly Premium', premiumRequired: true });
  }
  next();
}

const pendingPremiumGcash = new Map();
const pendingPremiumQrph = new Map();
const PREMIUM_PRICE_PHP = 1;


const pendingTopupGcash = new Map();
const pendingTopupQrph = new Map();

// Placeholder retail prices — replace with your actual reseller's net rates + your markup once you've signed up with a provider (FazerCards, Vibolshop, FoxReload, MooGold, etc.)
const DIAMOND_PACKAGES = [
  { id: 'd86',   diamonds: 86,   price_php: 75 },
  { id: 'd172',  diamonds: 172,  price_php: 150 },
  { id: 'd257',  diamonds: 257,  price_php: 225 },
  { id: 'd344',  diamonds: 344,  price_php: 300 },
  { id: 'd429',  diamonds: 429,  price_php: 375 },
  { id: 'd514',  diamonds: 514,  price_php: 450 },
  { id: 'd706',  diamonds: 706,  price_php: 600 },
  { id: 'd878',  diamonds: 878,  price_php: 750 },
  { id: 'd963',  diamonds: 963,  price_php: 825 },
  { id: 'd1050', diamonds: 1050, price_php: 900 }
];

// STUB — this does NOT send real diamonds yet. Once you have a reseller API key,
// replace the body of this function with the actual API call. Example shape for
// a Vibolshop-style provider is left commented below as a starting point.
async function fulfillDiamondTopUp(order) {
  // const response = await axios.post('https://reseller.PROVIDER.com/reseller.php', {
  //   userid: order.mlbb_user_id,
  //   zoneid: order.mlbb_zone_id,
  //   package: order.package_diamonds,
  //   token: process.env.TOPUP_PROVIDER_API_KEY,
  //   game_code: 'MLBB'
  // });
  // if (response.data.status !== 'success') throw new Error('Top-up provider rejected the order');
  // return { providerOrderId: response.data.transaction_id };

  console.warn('⚠️ fulfillDiamondTopUp is a STUB — no real diamonds were sent. Configure your reseller API to go live.');
  return { providerOrderId: 'STUB-' + crypto.randomUUID() };
}

// ---------------- Buy Load (Fondly Cash) ----------------
const LOAD_NETWORKS = [
  { id: 'globe', name: 'Globe', color: '#0057b8' },
  { id: 'smart', name: 'Smart', color: '#0033a0' },
  { id: 'tnt', name: 'TNT', color: '#f7941d' },
  { id: 'tm', name: 'TM', color: '#8dc63f' },
  { id: 'sun', name: 'Sun Cellular', color: '#ed1c24' },
  { id: 'dito', name: 'DITO', color: '#ffcc00' }
];

const LOAD_DENOMINATIONS = [10, 15, 20, 30, 50, 100, 150, 200, 300, 500];

// Common everyday promo/data bundles per network. Prices and inclusions are
// approximate placeholders — update to match current official promo pricing
// before going live.
const LOAD_PROMOS = {
  globe: [
    { id: 'gosurf20', name: 'GOSURF20', price: 20, details: '300MB data + unli all-net texts · 1 day' },
    { id: 'gosurf50', name: 'GOSURF50', price: 50, details: '1GB data + unli all-net calls/texts · 3 days' },
    { id: 'gosurf99', name: 'GOSURF99', price: 99, details: '2.5GB data + unli all-net calls/texts · 7 days' },
    { id: 'gosurf149', name: 'GOSURF149', price: 149, details: '5GB data + unli all-net calls/texts · 15 days' },
    { id: 'gosurf299', name: 'GOSURF299', price: 299, details: '10GB data + unli all-net calls/texts · 30 days' },
    { id: 'gosakto50', name: 'GOSAKTO50', price: 50, details: '600MB data + unli calls/texts to Globe/TM · 7 days' },
    { id: 'gosakto99', name: 'GOSAKTO99', price: 99, details: '1GB data + unli calls/texts to Globe/TM · 30 days' },
    { id: 'goextra20', name: 'GOEXTRA20', price: 20, details: 'Unli all-net texts + 5 mins all-net calls · 1 day' },
    { id: 'gowatch25', name: 'GOWATCH25', price: 25, details: '1GB data for YouTube/Netflix/streaming apps · 1 day' },
    { id: 'gounli30', name: 'GOUNLI30', price: 30, details: 'Unli all-net calls/texts, no data · 1 day' }
  ],
  smart: [
    { id: 'giga20', name: 'GIGA20', price: 20, details: '300MB data + unli all-net texts · 1 day' },
    { id: 'giga50', name: 'GIGA50', price: 50, details: '1.5GB data + unli all-net calls/texts · 3 days' },
    { id: 'giga99', name: 'GIGA99', price: 99, details: '4GB data + unli all-net calls/texts · 7 days' },
    { id: 'giga149', name: 'GIGA149', price: 149, details: '6GB data + unli all-net calls/texts · 15 days' },
    { id: 'giga299', name: 'GIGA299', price: 299, details: '12GB data + unli all-net calls/texts · 30 days' },
    { id: 'allin30', name: 'ALL-IN 30', price: 30, details: '1GB data + unli calls/texts to Smart/TNT · 3 days' },
    { id: 'allin50', name: 'ALL-IN 50', price: 50, details: '2GB data + unli all-net calls/texts · 5 days' },
    { id: 'unlicallandtext20', name: 'UNLI CALL & TEXT 20', price: 20, details: 'Unli all-net calls/texts, no data · 1 day' },
    { id: 'streamgiga25', name: 'STREAM GIGA 25', price: 25, details: '1GB data for streaming apps · 1 day' },
    { id: 'suprapower99', name: 'SUPRA POWER 99', price: 99, details: '3GB data + unli calls/texts to Smart/TNT · 7 days' }
  ],
  tnt: [
    { id: 'all10', name: 'ALL10', price: 10, details: '200MB data + unli all-net texts · 1 day' },
    { id: 'all30', name: 'ALL30', price: 30, details: '1GB data + unli all-net calls/texts · 3 days' },
    { id: 'big50', name: 'TNT50 BIG BUNDLE', price: 50, details: '2GB data + unli all-net calls/texts · 5 days' },
    { id: 'big99', name: 'TNT99 BIG BUNDLE', price: 99, details: '5GB data + unli all-net calls/texts · 10 days' },
    { id: 'big149', name: 'TNT149 BIG BUNDLE', price: 149, details: '8GB data + unli all-net calls/texts · 15 days' },
    { id: 'big299', name: 'TNT299 BIG BUNDLE', price: 299, details: '15GB data + unli all-net calls/texts · 30 days' },
    { id: 'gigasurf20', name: 'GIGA SURF 20', price: 20, details: '1GB data for TikTok/FB/streaming · 1 day' },
    { id: 'unlitxt15', name: 'UNLI TEXT 15', price: 15, details: 'Unli all-net texts, no calls/data · 1 day' },
    { id: 'combo25', name: 'COMBO25', price: 25, details: '500MB data + 10 mins all-net calls · 1 day' }
  ],
  tm: [
    { id: 'gigasurf20', name: 'GIGASURF20', price: 20, details: '300MB data + unli all-net texts · 1 day' },
    { id: 'gigasurf50', name: 'GIGASURF50', price: 50, details: '1GB data + unli all-net texts · 3 days' },
    { id: 'gigasurf99', name: 'GIGASURF99', price: 99, details: '3GB data + unli all-net calls/texts · 7 days' },
    { id: 'allowance30', name: 'ALLOWANCE30', price: 30, details: 'Unli calls/texts to TM/Globe + 150MB · 3 days' },
    { id: 'allowance50', name: 'ALLOWANCE50', price: 50, details: 'Unli calls/texts to TM/Globe + 300MB · 3 days' },
    { id: 'tiktok20', name: 'TIKTOK20', price: 20, details: '1GB data for TikTok · 1 day' },
    { id: 'unlitxt15', name: 'UNLI TEXT 15', price: 15, details: 'Unli all-net texts, no calls/data · 1 day' }
  ],
  sun: [
    { id: 'sunallnet20', name: 'ALL-NET 20', price: 20, details: '300MB data + unli all-net texts · 1 day' },
    { id: 'sunallnet50', name: 'ALL-NET 50', price: 50, details: '1.5GB data + unli all-net calls/texts · 3 days' },
    { id: 'sunallnet99', name: 'ALL-NET 99', price: 99, details: '4GB data + unli all-net calls/texts · 7 days' },
    { id: 'sunallnet149', name: 'ALL-NET 149', price: 149, details: '6GB data + unli all-net calls/texts · 15 days' },
    { id: 'sunallnet299', name: 'ALL-NET 299', price: 299, details: '12GB data + unli all-net calls/texts · 30 days' },
    { id: 'sunsulit30', name: 'SULIT 30', price: 30, details: 'Unli calls/texts to Sun/Smart/TNT + 500MB · 3 days' },
    { id: 'sunstream25', name: 'STREAM 25', price: 25, details: '1GB data for streaming apps · 1 day' },
    { id: 'sununli20', name: 'UNLI CALL & TEXT 20', price: 20, details: 'Unli all-net calls/texts, no data · 1 day' }
  ],
  dito: [
    { id: 'gigablast20', name: 'GIGA BLAST 20', price: 20, details: '2GB data + unli all-net calls/texts · 1 day' },
    { id: 'gigablast50', name: 'GIGA BLAST 50', price: 50, details: '5GB data + unli all-net calls/texts · 7 days' },
    { id: 'gigablast99', name: 'GIGA BLAST 99', price: 99, details: '10GB data + unli all-net calls/texts · 15 days' },
    { id: 'gigablast149', name: 'GIGA BLAST 149', price: 149, details: '20GB data + unli all-net calls/texts · 30 days' },
    { id: 'gigablast299', name: 'GIGA BLAST 299', price: 299, details: '50GB data + unli all-net calls/texts · 30 days' },
    { id: 'dito30', name: 'DITO30 UNLI', price: 30, details: 'Unli all-net calls/texts, no data · 3 days' },
    { id: 'streamdito25', name: 'STREAM DITO 25', price: 25, details: '2GB data for streaming apps · 1 day' }
  ]
};

// STUB — this does NOT send real prepaid load yet. Once you've signed up with a
// load reseller/aggregator (e.g. a Load Central / Prepaid Pinas style API), replace
// the body of this function with the actual provider call.
async function fulfillLoadPurchase(order) {
  console.warn('⚠️ fulfillLoadPurchase is a STUB — no real load was sent. Configure your load reseller API to go live.');
  return { providerOrderId: 'STUB-' + crypto.randomUUID() };
}

// Flat service fee added on top of every load purchase, kept as Fondly's revenue.
// The user pays (load amount + this fee) from their FondlyCash balance; only the
// load amount itself is ever passed to fulfillLoadPurchase(). Since FondlyCash is
// funded through your real PayMongo account (see /gcash/create-source above), this
// fee is already sitting in your PayMongo balance the moment the cash-in happened —
// this just tracks how much of a user's spend is your margin vs. the load itself.
const LOAD_SERVICE_FEE = 2;

app.get('/load/networks', (req, res) => {
  res.json({ networks: LOAD_NETWORKS, denominations: LOAD_DENOMINATIONS, promos: LOAD_PROMOS });
});

app.post('/load/buy', requireAuth, async (req, res) => {
  const { network_id, mobile_number, amount, package_id } = req.body;

  const network = LOAD_NETWORKS.find(n => n.id === network_id);
  if (!network) return res.status(400).json({ error: 'Please select a valid network' });

  let promo = null;
  let numAmount;
  if (package_id) {
    promo = (LOAD_PROMOS[network_id] || []).find(p => p.id === package_id);
    if (!promo) return res.status(400).json({ error: 'Please select a valid promo package' });
    numAmount = promo.price;
  } else {
    numAmount = Number(amount);
    if (!numAmount || numAmount < 10 || numAmount > 2000) {
      return res.status(400).json({ error: 'Please enter an amount between ₱10 and ₱2,000' });
    }
  }

  const cleanedNumber = (mobile_number || '').replace(/\s|-/g, '');
  if (!/^(09\d{9}|\+639\d{9})$/.test(cleanedNumber)) {
    return res.status(400).json({ error: 'Please enter a valid Philippine mobile number (e.g. 09171234567)' });
  }

  const { data: fondlyCash, error: acctError } = await req.supabase
    .from('accounts')
    .select('id, current_balance')
    .eq('user_id', req.user.id)
    .eq('institution', 'fondlycash')
    .maybeSingle();

  const totalCharge = numAmount + LOAD_SERVICE_FEE;

  if (acctError) return res.status(500).json({ error: acctError.message });
  if (!fondlyCash) return res.status(400).json({ error: 'FondlyCash account not found' });
  if (Number(fondlyCash.current_balance) < totalCharge) {
    return res.status(400).json({ error: `Insufficient FondlyCash balance (need ₱${totalCharge.toFixed(2)} incl. ₱${LOAD_SERVICE_FEE} service fee)` });
  }

  const maskedNumber = cleanedNumber.slice(0, 4) + '****' + cleanedNumber.slice(-3);
  const baseNote = promo ? `${network.name} ${promo.name} — ${maskedNumber}` : `${network.name} load — ${maskedNumber}`;

  const { error: txnError } = await req.supabase
    .from('transactions')
    .insert([{
      type: 'outflow',
      amount: totalCharge,
      category: 'Load',
      note: `${baseNote} (incl. ₱${LOAD_SERVICE_FEE} service fee)`,
      user_id: req.user.id,
      account_id: fondlyCash.id
    }]);
  if (txnError) return res.status(500).json({ error: txnError.message });

  const newBalance = Number(fondlyCash.current_balance) - totalCharge;
  const { error: updateError } = await req.supabase
    .from('accounts')
    .update({ current_balance: newBalance })
    .eq('id', fondlyCash.id)
    .eq('user_id', req.user.id);
  if (updateError) return res.status(500).json({ error: updateError.message });

  try {
    await fulfillLoadPurchase({ network_id, mobile_number: cleanedNumber, amount: numAmount });
  } catch (err) {
    // Balance already deducted and transaction logged; surface a soft warning rather than failing the request.
    console.warn('Load fulfillment stub error:', err.message);
  }

  res.status(201).json({
    success: true,
    network: network.name,
    package_name: promo ? promo.name : null,
    mobile_number: maskedNumber,
    amount: numAmount,
    service_fee: LOAD_SERVICE_FEE,
    total_charged: totalCharge,
    new_balance: newBalance
  });
});

const pendingQrphIntents = new Map();




app.post('/gcash/create-source', requireAuth, async (req, res) => {
  const { amount, category, payment_method, note } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const authHeader = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const ref = crypto.randomUUID();

    const sourceRes = await fetch('https://api.paymongo.com/v1/sources', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(amount * 100),
                    redirect: {
          success: `${APP_BASE_URL}/cash-in-success.html?source_id=${ref}`,
          failed: `${APP_BASE_URL}/cash-in-failed.html?source_id=${ref}`
        },
            type: 'gcash',
            currency: 'PHP'
          }
        }
      })
    });

    const sourceData = await sourceRes.json();
    if (!sourceRes.ok) throw new Error(sourceData.errors?.[0]?.detail || 'Could not create GCash source');

    const source = sourceData.data;

   pendingGcashSources.set(ref, {
  paymongoSourceId: source.id,
  userId: req.user.id,
  token: req.headers.authorization.slice(7),
  amount,
  category,
  payment_method: payment_method || 'GCash',
  note
});

 res.json({ checkoutUrl: source.attributes.redirect.checkout_url, sourceId: source.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/gcash/confirm', async (req, res) => {
  const sourceId = req.query.source_id;
  const pending = pendingGcashSources.get(sourceId);
  if (!pending) return res.status(404).json({ error: 'No pending payment found for this source' });

  try {
    const authHeader = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');

   const checkRes = await fetch(`https://api.paymongo.com/v1/sources/${pending.paymongoSourceId}`, {
      headers: { 'Authorization': authHeader }
    });
    const checkData = await checkRes.json();
    if (checkData.data.attributes.status !== 'chargeable') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const paymentRes = await fetch('https://api.paymongo.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(pending.amount * 100),
            currency: 'PHP',
           source: { id: pending.paymongoSourceId, type: 'source' },
            description: pending.note || 'Fondly Cash In'
          }
        }
      })
    });
    const paymentData = await paymentRes.json();
    if (!paymentRes.ok) throw new Error(paymentData.errors?.[0]?.detail || 'Payment failed');

    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${pending.token}` } }
    });

    await recordCashIn(userClient, pending);
    console.log('GCash cash in saved to FondlyCash');

    pendingGcashSources.delete(sourceId);
    res.json({ success: true, amount: pending.amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/premium/gcash/create-source', requireAuth, async (req, res) => {
  try {
    const authHeader = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const ref = crypto.randomUUID();

    const sourceRes = await fetch('https://api.paymongo.com/v1/sources', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(PREMIUM_PRICE_PHP * 100),
            redirect: {
              success: `${APP_BASE_URL}/premium-success.html?source_id=${ref}`,
              failed: `${APP_BASE_URL}/premium-upgrade.html?source_id=${ref}&status=failed`
            },
            type: 'gcash',
            currency: 'PHP'
          }
        }
      })
    });

    const sourceData = await sourceRes.json();
    if (!sourceRes.ok) throw new Error(sourceData.errors?.[0]?.detail || 'Could not create GCash source');

    const source = sourceData.data;

    pendingPremiumGcash.set(ref, {
      paymongoSourceId: source.id,
      userId: req.user.id,
      token: req.headers.authorization.slice(7)
    });

    res.json({ checkoutUrl: source.attributes.redirect.checkout_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/premium/gcash/confirm', async (req, res) => {
  const ref = req.query.source_id;
  const pending = pendingPremiumGcash.get(ref);
  if (!pending) return res.status(404).json({ error: 'No pending premium payment found' });

  try {
    const authHeader = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');

    const checkRes = await fetch(`https://api.paymongo.com/v1/sources/${pending.paymongoSourceId}`, {
      headers: { 'Authorization': authHeader }
    });
    const checkData = await checkRes.json();
    if (checkData.data.attributes.status !== 'chargeable') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const paymentRes = await fetch('https://api.paymongo.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(PREMIUM_PRICE_PHP * 100),
            currency: 'PHP',
            source: { id: pending.paymongoSourceId, type: 'source' },
            description: 'Fondly Premium Unlock'
          }
        }
      })
    });
    const paymentData = await paymentRes.json();
    if (!paymentRes.ok) throw new Error(paymentData.errors?.[0]?.detail || 'Payment failed');

    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${pending.token}` } }
    });

    const { error: upsertError } = await userClient.from('premium_status').upsert({
      user_id: pending.userId,
      is_premium: true,
      unlocked_at: new Date().toISOString(),
      payment_method: 'GCash'
    });
    if (upsertError) throw new Error(upsertError.message);

    pendingPremiumGcash.delete(ref);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/premium/qrph/create-intent', requireAuth, async (req, res) => {
  try {
    const secretAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const publicAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_PUBLIC_KEY}:`).toString('base64');

    const intentRes = await fetch('https://api.paymongo.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': secretAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(PREMIUM_PRICE_PHP * 100),
            currency: 'PHP',
            payment_method_allowed: ['qrph'],
            description: 'Fondly Premium Unlock'
          }
        }
      })
    });
    const intentData = await intentRes.json();
    if (!intentRes.ok) throw new Error(intentData.errors?.[0]?.detail || 'Could not create payment intent');
    const intent = intentData.data;

    const methodRes = await fetch('https://api.paymongo.com/v1/payment_methods', {
      method: 'POST',
      headers: {
        'Authorization': publicAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: { attributes: { type: 'qrph' } }
      })
    });
    const methodData = await methodRes.json();
    if (!methodRes.ok) throw new Error(methodData.errors?.[0]?.detail || 'Could not create payment method');
    const paymentMethod = methodData.data;

    const attachRes = await fetch(`https://api.paymongo.com/v1/payment_intents/${intent.id}/attach`, {
      method: 'POST',
      headers: {
        'Authorization': publicAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            payment_method: paymentMethod.id,
            client_key: intent.attributes.client_key
          }
        }
      })
    });
    const attachData = await attachRes.json();
    if (!attachRes.ok) throw new Error(attachData.errors?.[0]?.detail || 'Could not attach payment method');
    const attachedIntent = attachData.data;

    const qrImageUrl = attachedIntent.attributes.next_action?.code?.image_url;
    if (!qrImageUrl) throw new Error('QR code was not generated');

    pendingPremiumQrph.set(intent.id, {
      userId: req.user.id,
      token: req.headers.authorization.slice(7)
    });

    res.json({ qrImageUrl, intentId: intent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/premium/qrph/status/:intentId', async (req, res) => {
  const { intentId } = req.params;
  const pending = pendingPremiumQrph.get(intentId);
  if (!pending) return res.status(404).json({ error: 'No pending premium payment found' });

  try {
    const secretAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const checkRes = await fetch(`https://api.paymongo.com/v1/payment_intents/${intentId}`, {
      headers: { 'Authorization': secretAuth }
    });
    const checkData = await checkRes.json();
    const status = checkData.data.attributes.status;

    if (status !== 'succeeded') {
      return res.json({ status });
    }

    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${pending.token}` } }
    });

    const { error: upsertError } = await userClient.from('premium_status').upsert({
      user_id: pending.userId,
      is_premium: true,
      unlocked_at: new Date().toISOString(),
      payment_method: 'QR Ph'
    });
    if (upsertError) throw new Error(upsertError.message);

    pendingPremiumQrph.delete(intentId);
    res.json({ status: 'succeeded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/qrph/create-intent', requireAuth, async (req, res) => {
  const { amount, category, payment_method, note } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const secretAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const publicAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_PUBLIC_KEY}:`).toString('base64');

    const intentRes = await fetch('https://api.paymongo.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': secretAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(amount * 100),
            currency: 'PHP',
            payment_method_allowed: ['qrph'],
            description: note || 'Fondly Cash In'
          }
        }
      })
    });
    const intentData = await intentRes.json();
    if (!intentRes.ok) throw new Error(intentData.errors?.[0]?.detail || 'Could not create payment intent');
    const intent = intentData.data;

    const methodRes = await fetch('https://api.paymongo.com/v1/payment_methods', {
      method: 'POST',
      headers: {
        'Authorization': publicAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: { attributes: { type: 'qrph' } }
      })
    });
    const methodData = await methodRes.json();
    if (!methodRes.ok) throw new Error(methodData.errors?.[0]?.detail || 'Could not create payment method');
    const paymentMethod = methodData.data;

    const attachRes = await fetch(`https://api.paymongo.com/v1/payment_intents/${intent.id}/attach`, {
      method: 'POST',
      headers: {
        'Authorization': publicAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            payment_method: paymentMethod.id,
            client_key: intent.attributes.client_key
          }
        }
      })
    });
    const attachData = await attachRes.json();
    if (!attachRes.ok) throw new Error(attachData.errors?.[0]?.detail || 'Could not attach payment method');
    const attachedIntent = attachData.data;

    const qrImageUrl = attachedIntent.attributes.next_action?.code?.image_url;
    if (!qrImageUrl) throw new Error('QR code was not generated');

    pendingQrphIntents.set(intent.id, {
      userId: req.user.id,
      token: req.headers.authorization.slice(7),
      amount,
      category,
      payment_method: payment_method || 'QR Ph',
      note
    });

    res.json({ qrImageUrl, intentId: intent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/qrph/status/:intentId', async (req, res) => {
  const { intentId } = req.params;
  const pending = pendingQrphIntents.get(intentId);
  if (!pending) return res.status(404).json({ error: 'No pending payment found for this intent' });

  try {
    const secretAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const checkRes = await fetch(`https://api.paymongo.com/v1/payment_intents/${intentId}`, {
      headers: { 'Authorization': secretAuth }
    });
    const checkData = await checkRes.json();
    const status = checkData.data.attributes.status;

    if (status !== 'succeeded') {
      return res.json({ status });
    }

    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${pending.token}` } }
    });

    await recordCashIn(userClient, pending);
    console.log('QR Ph cash in saved to FondlyCash');

    pendingQrphIntents.delete(intentId);
    res.json({ status: 'succeeded', amount: pending.amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Records a cash in and credits the user's FondlyCash account
async function recordCashInOnce(userClient, pending) {
  const { data: fondly, error: fondlyError } = await userClient
    .from('accounts')
    .select('id, current_balance')
    .eq('user_id', pending.userId)
    .eq('institution', 'fondlycash')
    .limit(1);
  if (fondlyError) throw new Error(fondlyError.message);
  const account = fondly && fondly[0] ? fondly[0] : null;

  const { error: insertError } = await userClient.from('transactions').insert([{
    type: 'cash_in',
    amount: pending.amount,
    category: pending.category,
    payment_method: pending.payment_method,
    note: pending.note,
    user_id: pending.userId,
    account_id: account ? account.id : null
  }]);
  if (insertError) throw new Error(insertError.message);

  if (account) {
    const { error: balanceError } = await userClient
      .from('accounts')
      .update({ current_balance: Number(account.current_balance) + Number(pending.amount) })
      .eq('id', account.id)
      .eq('user_id', pending.userId);
    if (balanceError) throw new Error(balanceError.message);
  }
}
// Makes sure FondlyCash exists, and never credits the same payment twice
async function ensureFondlyCash(userClient, userId) {
  const { data } = await userClient
    .from('accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('institution', 'fondlycash')
    .limit(1);
  if (data && data.length > 0) return;
  const { error } = await userClient.from('accounts').insert([{
    name: 'FondlyCash',
    type: 'Cash',
    institution: 'fondlycash',
    starting_balance: 0,
    current_balance: 0,
    currency: 'PHP',
    color: '#006c4a',
    user_id: userId
  }]);
  if (error && error.code !== '23505') throw new Error(error.message);
}

async function recordCashIn(userClient, pending) {
  if (pending.credited) return false;
  pending.credited = true;
  try {
    await ensureFondlyCash(userClient, pending.userId);
    await recordCashInOnce(userClient, pending);
    return true;
  } catch (err) {
    pending.credited = false;
    throw err;
  }
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing login token' });

  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired login' });

  req.user = data.user;
  req.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  next();
}

// ---------------- Biometric passkey login (WebAuthn) ----------------
// Lets a user register a device passkey (fingerprint/Face ID/Windows Hello)
// and sign in with it instead of typing their password. Needs two things
// set up once, outside this code, before it will work:
//   1. A `webauthn_credentials` table in Supabase (see the SQL shared with
//      the user in chat).
//   2. A SUPABASE_SERVICE_ROLE_KEY environment variable on Render (from
//      Supabase Project Settings > API > service_role secret key). Passkey
//      login has to create a real logged-in session for someone who hasn't
//      typed a password, which only the service-role key is allowed to do.
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const adminClient = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function requireAdminClient(res) {
  if (!adminClient) {
    res.status(500).json({
      error: 'Biometric passkey login is not set up yet on the server (missing SUPABASE_SERVICE_ROLE_KEY).'
    });
    return null;
  }
  return adminClient;
}

let WEBAUTHN_RP_ID = 'localhost';
try { WEBAUTHN_RP_ID = new URL(APP_BASE_URL).hostname; } catch (_) {}
const WEBAUTHN_ORIGIN = APP_BASE_URL;

// In-memory challenge stores. Fine as long as this runs on a single
// instance (true for Render's free tier). Each entry expires after 5 min.
const registrationChallenges = new Map();
const authenticationChallenges = new Map();
function stashChallenge(map, key, challenge) {
  map.set(key, { challenge, expires: Date.now() + 5 * 60 * 1000 });
}
function takeChallenge(map, key) {
  const entry = map.get(key);
  map.delete(key);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.challenge;
}

// Step 1 (already logged in): ask the browser to create a passkey.
app.post('/webauthn/registration-options', requireAuth, async (req, res) => {
  const admin = requireAdminClient(res);
  if (!admin) return;
  try {
    const { data: existing, error } = await admin
      .from('webauthn_credentials')
      .select('credential_id, transports')
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });

    const options = await generateRegistrationOptions({
      rpName: 'Fondly',
      rpID: WEBAUTHN_RP_ID,
      userName: req.user.email,
      userDisplayName: req.user.email,
      attestationType: 'none',
      excludeCredentials: (existing || []).map(c => ({
        id: c.credential_id,
        transports: c.transports || undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    stashChallenge(registrationChallenges, req.user.id, options.challenge);
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2 (already logged in): verify the new passkey and save it.
app.post('/webauthn/registration-verify', requireAuth, async (req, res) => {
  const admin = requireAdminClient(res);
  if (!admin) return;
  try {
    const expectedChallenge = takeChallenge(registrationChallenges, req.user.id);
    if (!expectedChallenge) return res.status(400).json({ error: 'Registration session expired, please try again.' });

    const verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Could not verify passkey.' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const { error } = await admin.from('webauthn_credentials').insert({
      user_id: req.user.id,
      email: req.user.email,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      device_type: credentialDeviceType,
      backed_up: credentialBackedUp,
      transports: credential.transports || [],
    });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 3 (signed out): ask which passkey to use for this email.
app.post('/webauthn/authentication-options', async (req, res) => {
  const admin = requireAdminClient(res);
  if (!admin) return;
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    const { data: creds, error } = await admin
      .from('webauthn_credentials')
      .select('credential_id, transports')
      .eq('email', email);
    if (error) return res.status(500).json({ error: error.message });
    if (!creds || creds.length === 0) {
      return res.status(404).json({ error: 'No passkey is set up for this account yet.' });
    }

    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      userVerification: 'preferred',
      allowCredentials: creds.map(c => ({
        id: c.credential_id,
        transports: c.transports || undefined,
      })),
    });

    stashChallenge(authenticationChallenges, email, options.challenge);
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 4 (signed out): verify the passkey and hand back a real Supabase
// session, without ever sending an actual email.
app.post('/webauthn/authentication-verify', async (req, res) => {
  const admin = requireAdminClient(res);
  if (!admin) return;
  const email = (req.body.email || '').trim().toLowerCase();
  const response = req.body.response;
  if (!email || !response) return res.status(400).json({ error: 'Email and passkey response are required.' });

  try {
    const expectedChallenge = takeChallenge(authenticationChallenges, email);
    if (!expectedChallenge) return res.status(400).json({ error: 'Login session expired, please try again.' });

    const { data: row, error: lookupError } = await admin
      .from('webauthn_credentials')
      .select('*')
      .eq('email', email)
      .eq('credential_id', response.id)
      .maybeSingle();
    if (lookupError) return res.status(500).json({ error: lookupError.message });
    if (!row) return res.status(400).json({ error: 'This passkey is not recognized.' });

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      credential: {
        id: row.credential_id,
        publicKey: Buffer.from(row.public_key, 'base64'),
        counter: row.counter,
        transports: row.transports || undefined,
      },
    });

    if (!verification.verified) {
      return res.status(400).json({ error: 'Passkey verification failed.' });
    }

    await admin
      .from('webauthn_credentials')
      .update({ counter: verification.authenticationInfo.newCounter })
      .eq('id', row.id);

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    if (linkError) return res.status(500).json({ error: linkError.message });

    res.json({ success: true, token_hash: linkData.properties.hashed_token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.send('Fondly backend is running! v2');
});

app.get('/transactions', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase.from('transactions').select('*').eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/transactions', requireAuth, async (req, res) => {
  const { type, amount, category, payment_method, note, account_id } = req.body;
  if (type === 'cash_in') {
       const { data: target } = account_id
      ? await req.supabase.from('accounts').select('institution').eq('id', account_id).eq('user_id', req.user.id).maybeSingle()
      : { data: null };
    if (!target || target.institution === 'fondlycash') {
      return res.status(400).json({ error: 'Cash in for FondlyCash only happens through a real payment' });
    }
  }

  const { data, error } = await req.supabase
    .from('transactions')
    .insert([{ type, amount, category, payment_method, note, user_id: req.user.id, account_id: account_id || null }])
    .select();
  if (error) return res.status(500).json({ error: error.message });

   if (account_id) {
    const { data: account, error: acctError } = await req.supabase
      .from('accounts')
      .select('current_balance')
      .eq('id', account_id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!acctError && account) {
      const delta = type === 'cash_in' ? Number(amount) : -Number(amount);
      const newBalance = Number(account.current_balance) + delta;

      await req.supabase
        .from('accounts')
        .update({ current_balance: newBalance })
        .eq('id', account_id)
        .eq('user_id', req.user.id);
    }
  }

  let roundup = null;
  if (type === 'outflow') {
    roundup = await applyRoundup(req, Number(amount));
  }

  res.status(201).json({ transaction: data, roundup });
});

app.delete('/transactions/:id', requireAuth, async (req, res) => {
  const { data: existing, error: fetchError } = await req.supabase
    .from('transactions')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Transaction not found' });

  const { error: deleteError } = await req.supabase
    .from('transactions')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (deleteError) return res.status(500).json({ error: deleteError.message });

  // Put the money back the way it was before this transaction happened.
  if (existing.account_id) {
    const { data: account, error: acctError } = await req.supabase
      .from('accounts')
      .select('current_balance')
      .eq('id', existing.account_id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!acctError && account) {
      const reverseDelta = existing.type === 'cash_in' ? -Number(existing.amount) : Number(existing.amount);
      const newBalance = Number(account.current_balance) + reverseDelta;

      await req.supabase
        .from('accounts')
        .update({ current_balance: newBalance })
        .eq('id', existing.account_id)
        .eq('user_id', req.user.id);
    }
  }

  res.json({ success: true });
});

app.get('/summary', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase.from('transactions').select('type, amount').eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  let totalCashIn = 0;
  let totalOutflow = 0;
  data.forEach(row => {
    if (row.type === 'cash_in') totalCashIn += Number(row.amount);
    if (row.type === 'outflow') totalOutflow += Number(row.amount);
  });

  res.json({
    totalCashIn,
    totalOutflow,
    remaining: totalCashIn - totalOutflow,
    transactionCount: data.length
  });
});

app.get('/breakdown', requireAuth, requirePremium, async (req, res) => {
  const { data, error } = await req.supabase
    .from('transactions')
    .select('category, amount')
    .eq('type', 'outflow')
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  const categoryMap = {};
  let totalSpent = 0;
  data.forEach(row => {
    const cat = row.category || 'Other';
    if (!categoryMap[cat]) categoryMap[cat] = { spent: 0, count: 0 };
    categoryMap[cat].spent += Number(row.amount);
    categoryMap[cat].count += 1;
    totalSpent += Number(row.amount);
  });

  const categories = Object.keys(categoryMap).map(name => ({
    name,
    spent: categoryMap[name].spent,
    count: categoryMap[name].count
  }));

  res.json({ totalSpent, categories });
});

app.get('/goals', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('goals')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/goals', requireAuth, async (req, res) => {
  const { name, target_amount, target_date } = req.body;

  const { data: premium } = await req.supabase
    .from('premium_status')
    .select('is_premium')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!premium || !premium.is_premium) {
    const { count, error: countError } = await req.supabase
      .from('goals')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id);

    if (countError) return res.status(500).json({ error: countError.message });
    if (count >= 1) {
      return res.status(403).json({
        error: 'Free plan is limited to 1 goal. Upgrade to Fondly Premium for unlimited goals.',
        premiumRequired: true
      });
    }
  }

  const { data, error } = await req.supabase
    .from('goals')
    .insert([{ name, target_amount, target_date, user_id: req.user.id }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/goals/:id', requireAuth, async (req, res) => {
  const { current_amount } = req.body;
  const { data, error } = await req.supabase
    .from('goals')
    .update({ current_amount })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/goals/:id', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('goals')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Goal not found' });
  res.json({ success: true });
});

app.get('/accounts', requireAuth, async (req, res) => {
  // Every user gets exactly one FondlyCash account
  const { data: existing, error: existingError } = await req.supabase
    .from('accounts')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('institution', 'fondlycash')
    .limit(1);
  if (existingError) return res.status(500).json({ error: existingError.message });

  if (!existing || existing.length === 0) {
    const { error: createError } = await req.supabase
      .from('accounts')
      .insert([{
        name: 'FondlyCash',
        type: 'Cash',
        institution: 'fondlycash',
        starting_balance: 0,
        current_balance: 0,
        currency: 'PHP',
        color: '#006c4a',
        user_id: req.user.id
      }]);
    // 23505 means another request created it a moment earlier, which is fine
    if (createError && createError.code !== '23505') {
      return res.status(500).json({ error: createError.message });
    }
  }

  const { data, error } = await req.supabase
    .from('accounts')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/accounts', requireAuth, async (req, res) => {
  const { name, type, starting_balance, color, institution, account_number } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Name and type are required' });
  if (institution === 'fondlycash') {
    return res.status(400).json({ error: 'FondlyCash is created automatically' });
  }

  const { data, error } = await req.supabase
    .from('accounts')
    .insert([{
      name,
      type,
      institution: institution || null,
      account_number: account_number || null,
      starting_balance: starting_balance || 0,
      current_balance: starting_balance || 0,
      currency: 'PHP',
      color: color || '#2596be',
      user_id: req.user.id
    }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/accounts/:id', requireAuth, async (req, res) => {
  const { current_balance, name, color, account_number } = req.body;
  if (current_balance !== undefined) {
    const { data: target } = await req.supabase
      .from('accounts')
      .select('institution')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (target && target.institution === 'fondlycash') {
      return res.status(400).json({ error: 'FondlyCash balance only changes with real payments' });
    }
  }
  const updates = {};
  if (current_balance !== undefined) updates.current_balance = current_balance;
  if (name !== undefined) updates.name = name;
  if (color !== undefined) updates.color = color;
  if (account_number !== undefined) updates.account_number = account_number;

  const { data, error } = await req.supabase
    .from('accounts')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/accounts/:id', requireAuth, async (req, res) => {
  const { data: acct, error: fetchError } = await req.supabase
    .from('accounts')
    .select('institution')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (acct && acct.institution === 'fondlycash') {
    return res.status(400).json({ error: 'FondlyCash cannot be deleted' });
  }

  const { error } = await req.supabase
    .from('accounts')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});


app.get('/budget-caps', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('budget_caps')
    .select('*')
    .eq('user_id', req.user.id)
    .order('category', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/budget-caps', requireAuth, async (req, res) => {
  const { category, monthly_limit } = req.body;
  if (!category || monthly_limit === undefined) {
    return res.status(400).json({ error: 'Category and monthly_limit are required' });
  }

  const { data, error } = await req.supabase
    .from('budget_caps')
    .upsert(
      { user_id: req.user.id, category, monthly_limit },
      { onConflict: 'user_id,category' }
    )
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.delete('/budget-caps/:id', requireAuth, async (req, res) => {
  const { error } = await req.supabase
    .from('budget_caps')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/budget-caps/status', requireAuth, async (req, res) => {
  const { data: caps, error: capsError } = await req.supabase
    .from('budget_caps')
    .select('*')
    .eq('user_id', req.user.id);
  if (capsError) return res.status(500).json({ error: capsError.message });

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data: txns, error: txError } = await req.supabase
    .from('transactions')
    .select('category, amount, created_at')
    .eq('user_id', req.user.id)
    .eq('type', 'outflow')
    .gte('created_at', monthStart);
  if (txError) return res.status(500).json({ error: txError.message });

  const spentByCategory = {};
  txns.forEach(row => {
    const cat = row.category || 'Other';
    spentByCategory[cat] = (spentByCategory[cat] || 0) + Number(row.amount);
  });

  const status = caps.map(cap => {
    const spent = spentByCategory[cap.category] || 0;
    const limit = Number(cap.monthly_limit);
    const percentUsed = limit > 0 ? (spent / limit) * 100 : 0;
    return {
      id: cap.id,
      category: cap.category,
      monthly_limit: limit,
      spent,
      remaining: limit - spent,
      percent_used: Math.round(percentUsed),
      is_over: spent > limit
    };
  });

  res.json(status);
});



function getNextDueDate(dueDay, from = new Date()) {
  const clampDay = (year, month) => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    return Math.min(dueDay, lastDay);
  };

  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let year = today.getFullYear();
  let month = today.getMonth();
  let candidate = new Date(year, month, clampDay(year, month));

  if (candidate < today) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    candidate = new Date(year, month, clampDay(year, month));
  }
  return candidate;
}

app.get('/recurring-bills', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('recurring_bills')
    .select('*')
    .eq('user_id', req.user.id)
    .order('due_day', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/recurring-bills/upcoming', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('recurring_bills')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });

  const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  const upcoming = data.map(bill => {
    const nextDue = getNextDueDate(bill.due_day);
    const daysLeft = Math.round((nextDue - today) / (1000 * 60 * 60 * 24));
    return {
      id: bill.id,
      name: bill.name,
      amount: Number(bill.amount),
      category: bill.category,
      payment_method: bill.payment_method,
      due_day: bill.due_day,
      next_due_date: nextDue.toISOString().slice(0, 10),
      days_left: daysLeft,
      is_overdue: daysLeft < 0
    };
  }).sort((a, b) => a.days_left - b.days_left);

  res.json(upcoming);
});

app.post('/recurring-bills', requireAuth, async (req, res) => {
  const { name, amount, category, due_day, payment_method } = req.body;
  if (!name || !amount || !due_day) {
    return res.status(400).json({ error: 'Name, amount, and due_day are required' });
  }
  if (due_day < 1 || due_day > 31) {
    return res.status(400).json({ error: 'due_day must be between 1 and 31' });
  }

  const { data, error } = await req.supabase
    .from('recurring_bills')
    .insert([{ name, amount, category, due_day, payment_method, user_id: req.user.id }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/recurring-bills/:id', requireAuth, async (req, res) => {
  const { name, amount, category, due_day, payment_method, is_active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (amount !== undefined) updates.amount = amount;
  if (category !== undefined) updates.category = category;
  if (due_day !== undefined) updates.due_day = due_day;
  if (payment_method !== undefined) updates.payment_method = payment_method;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await req.supabase
    .from('recurring_bills')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/recurring-bills/:id/mark-paid', requireAuth, async (req, res) => {
  const { data: bill, error: billError } = await req.supabase
    .from('recurring_bills')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (billError) return res.status(500).json({ error: billError.message });
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  const { error: txError } = await req.supabase
    .from('transactions')
    .insert([{
      type: 'outflow',
      amount: bill.amount,
      category: bill.category,
      payment_method: bill.payment_method,
      note: bill.name,
      user_id: req.user.id
    }]);
  if (txError) return res.status(500).json({ error: txError.message });

  const { data, error } = await req.supabase
    .from('recurring_bills')
    .update({ last_paid_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/recurring-bills/:id', requireAuth, async (req, res) => {
  const { error } = await req.supabase
    .from('recurring_bills')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/payday-settings', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('payday_settings')
    .select('*')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  const settings = data || { payday_day: null, expected_amount: 0 };
  let daysUntil = null;
  let nextPayday = null;
  if (settings.payday_day) {
    const next = getNextDueDate(settings.payday_day);
    const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    daysUntil = Math.round((next - today) / (1000 * 60 * 60 * 24));
    nextPayday = next.toISOString().slice(0, 10);
  }

  res.json({
    payday_day: settings.payday_day,
    expected_amount: Number(settings.expected_amount) || 0,
    next_payday: nextPayday,
    days_until: daysUntil
  });
});

app.post('/payday-settings', requireAuth, async (req, res) => {
  const { payday_day, expected_amount } = req.body;
  if (payday_day !== null && payday_day !== undefined && (payday_day < 1 || payday_day > 31)) {
    return res.status(400).json({ error: 'payday_day must be between 1 and 31' });
  }

  const { data, error } = await req.supabase
    .from('payday_settings')
    .upsert(
      { user_id: req.user.id, payday_day: payday_day ?? null, expected_amount: expected_amount || 0 },
      { onConflict: 'user_id' }
    )
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ---------------- Debt Tracker ----------------
// type: 'owed_by_me' (debt the user owes) or 'owed_to_me' (money owed to the user)

app.get('/debts', requireAuth, async (req, res) => {
  const { type } = req.query;
  let query = req.supabase
    .from('debts')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (type) query = query.eq('type', type);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const withRemaining = data.map(d => ({
    ...d,
    remaining_amount: Number(d.original_amount) - Number(d.amount_paid || 0),
    percent_paid: Number(d.original_amount) > 0 ? Math.min(100, Math.round((Number(d.amount_paid || 0) / Number(d.original_amount)) * 100)) : 0
  }));
  res.json(withRemaining);
});

app.post('/debts', requireAuth, async (req, res) => {
  const { type, person_name, original_amount, notes } = req.body;
  if (!type || !['owed_by_me', 'owed_to_me'].includes(type)) {
    return res.status(400).json({ error: 'type must be owed_by_me or owed_to_me' });
  }
  if (!person_name || !original_amount || original_amount <= 0) {
    return res.status(400).json({ error: 'person_name and a positive original_amount are required' });
  }

  const { data, error } = await req.supabase
    .from('debts')
    .insert([{
      type,
      person_name,
      original_amount,
      amount_paid: 0,
      notes: notes || null,
      status: 'open',
      user_id: req.user.id
    }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.post('/debts/:id/record-payment', requireAuth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' });

  const { data: debt, error: fetchError } = await req.supabase
    .from('debts')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!debt) return res.status(404).json({ error: 'Debt not found' });

  const newAmountPaid = Math.min(Number(debt.original_amount), Number(debt.amount_paid || 0) + Number(amount));
  const newStatus = newAmountPaid >= Number(debt.original_amount) ? 'settled' : 'open';

  const { data, error } = await req.supabase
    .from('debts')
    .update({ amount_paid: newAmountPaid, status: newStatus })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/debts/:id', requireAuth, async (req, res) => {
  const { error } = await req.supabase
    .from('debts')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ---------------- Streaks & Badges ----------------

const BADGE_THRESHOLDS = [
  { id: 'first_spark', name: 'First Spark', days: 1 },
  { id: 'second_step', name: 'Second Step', days: 2 },
  { id: 'pocket_ember', name: 'Pocket Ember', days: 3 },
  { id: 'week_keeper', name: 'Week Keeper', days: 7 },
  { id: 'fortnight_flame', name: 'Fortnight Flame', days: 14 },
  { id: 'month_blaze', name: 'Month Blaze', days: 30 },
  { id: 'season_bonfire', name: 'Season Bonfire', days: 60 },
  { id: 'century_wildfire', name: 'Century Wildfire', days: 100 }
];

function dateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

async function getOrCreateStreak(req) {
  const { data: existing, error } = await req.supabase
    .from('user_streaks')
    .select('*')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing;

  const { data: created, error: createError } = await req.supabase
    .from('user_streaks')
    .insert([{ user_id: req.user.id, current_streak: 0, longest_streak: 0, last_active_date: null }])
    .select()
    .maybeSingle();
  if (createError) throw createError;
  return created;
}

app.get('/streak', requireAuth, async (req, res) => {
  try {
    const streak = await getOrCreateStreak(req);
    const { data: badges, error: badgesError } = await req.supabase
      .from('user_badges')
      .select('badge_id, earned_at')
      .eq('user_id', req.user.id);
    if (badgesError) return res.status(500).json({ error: badgesError.message });

    res.json({
      current_streak: streak.current_streak,
      longest_streak: streak.longest_streak,
      last_active_date: streak.last_active_date,
      badges: badges.map(b => b.badge_id),
      all_badges: BADGE_THRESHOLDS
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/streak/ping', requireAuth, async (req, res) => {
  try {
    const streak = await getOrCreateStreak(req);
    const today = dateOnly(new Date());
    const lastActive = streak.last_active_date ? dateOnly(new Date(streak.last_active_date + 'T00:00:00')) : null;

    let newCurrent = streak.current_streak;
    let changed = false;

    if (!lastActive) {
      newCurrent = 1;
      changed = true;
    } else {
      const diffDays = Math.round((today - lastActive) / (1000 * 60 * 60 * 24));
      if (diffDays === 0) {
        // already logged in today, no change
      } else if (diffDays === 1) {
        newCurrent = streak.current_streak + 1;
        changed = true;
      } else if (diffDays > 1) {
        newCurrent = 1;
        changed = true;
      }
    }

    const newLongest = Math.max(streak.longest_streak, newCurrent);

    if (changed) {
      const { error: updateError } = await req.supabase
        .from('user_streaks')
        .update({ current_streak: newCurrent, longest_streak: newLongest, last_active_date: today.toISOString().slice(0, 10) })
        .eq('user_id', req.user.id);
      if (updateError) return res.status(500).json({ error: updateError.message });
    }

    const { data: existingBadges, error: badgesFetchError } = await req.supabase
      .from('user_badges')
      .select('badge_id')
      .eq('user_id', req.user.id);
    if (badgesFetchError) return res.status(500).json({ error: badgesFetchError.message });

    const earnedIds = new Set(existingBadges.map(b => b.badge_id));
    const newlyEarned = BADGE_THRESHOLDS.filter(b => newCurrent >= b.days && !earnedIds.has(b.id));

    if (newlyEarned.length > 0) {
      const { error: insertError } = await req.supabase
        .from('user_badges')
        .insert(newlyEarned.map(b => ({ user_id: req.user.id, badge_id: b.id })));
      if (insertError) return res.status(500).json({ error: insertError.message });
    }

    res.json({
      current_streak: newCurrent,
      longest_streak: newLongest,
      newly_earned: newlyEarned
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- Bill Splitting ----------------
app.get('/split-bills', requireAuth, async (req, res) => {
  const { data: bills, error } = await req.supabase
    .from('split_bills')
    .select('*, split_bill_participants(*)')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const withProgress = bills.map(b => {
    const participants = b.split_bill_participants || [];
    const collected = participants.filter(p => p.paid).reduce((sum, p) => sum + Number(p.share_amount), 0);
    const paidCount = participants.filter(p => p.paid).length;
    return {
      id: b.id,
      title: b.title,
      category: b.category,
      total_amount: Number(b.total_amount),
      created_at: b.created_at,
      participants: participants.map(p => ({
        id: p.id,
        name: p.name,
        share_amount: Number(p.share_amount),
        paid: p.paid
      })),
      collected_amount: collected,
      remaining_amount: Number(b.total_amount) - collected,
      paid_count: paidCount,
      participant_count: participants.length,
      percent_collected: Number(b.total_amount) > 0 ? Math.min(100, Math.round((collected / Number(b.total_amount)) * 100)) : 0
    };
  });

  res.json(withProgress);
});

app.post('/split-bills', requireAuth, async (req, res) => {
  const { title, category, total_amount, participants } = req.body;
  if (!title || !total_amount || Number(total_amount) <= 0) {
    return res.status(400).json({ error: 'title and total_amount (>0) are required' });
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: 'at least one participant is required' });
  }
  for (const p of participants) {
    if (!p.name || !p.share_amount || Number(p.share_amount) <= 0) {
      return res.status(400).json({ error: 'each participant needs a name and a share_amount > 0' });
    }
  }

  const { data: bill, error: billError } = await req.supabase
    .from('split_bills')
    .insert({ user_id: req.user.id, title, category: category || 'Other', total_amount: Number(total_amount) })
    .select()
    .single();
  if (billError) return res.status(500).json({ error: billError.message });

  const { error: participantsError } = await req.supabase
    .from('split_bill_participants')
    .insert(participants.map(p => ({
      split_bill_id: bill.id,
      user_id: req.user.id,
      name: p.name,
      share_amount: Number(p.share_amount),
      paid: false
    })));
  if (participantsError) return res.status(500).json({ error: participantsError.message });

  res.status(201).json(bill);
});

app.post('/split-bills/:billId/participants/:participantId/mark-paid', requireAuth, async (req, res) => {
  const { billId, participantId } = req.params;

  const { data: bill, error: billError } = await req.supabase
    .from('split_bills')
    .select('id')
    .eq('id', billId)
    .eq('user_id', req.user.id)
    .single();
  if (billError || !bill) return res.status(404).json({ error: 'Bill not found' });

  const { data: participant, error } = await req.supabase
    .from('split_bill_participants')
    .update({ paid: true, paid_at: new Date().toISOString() })
    .eq('id', participantId)
    .eq('split_bill_id', billId)
    .eq('user_id', req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  res.json(participant);
});

app.delete('/split-bills/:id', requireAuth, async (req, res) => {
  const { error } = await req.supabase
    .from('split_bills')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// ---------------- Financial Literacy Coach ----------------
const LESSONS = [
  { id: 'budget_basics', category: 'Budgeting', title: 'The 50/30/20 Rule', minutes: 3,
    content: 'A simple way to split your take-home pay: 50% on needs (rent, food, bills), 30% on wants (eating out, hobbies), and 20% on savings or debt payoff. It is a starting point, not a law — adjust the splits to fit your real costs, especially if rent alone eats more than 50%.' },
  { id: 'emergency_fund', category: 'Saving', title: 'Why You Need an Emergency Fund', minutes: 3,
    content: 'An emergency fund is 3-6 months of essential expenses kept somewhere easy to access but separate from your everyday spending money. It exists so a job loss, medical bill, or broken phone does not force you into high-interest debt. Start small: even one month of expenses changes how stressful a surprise bill feels.' },
  { id: 'good_vs_bad_debt', category: 'Debt', title: 'Good Debt vs Bad Debt', minutes: 4,
    content: 'Not all debt is the same. Debt that helps you build an asset or earn more over time (a reasonable mortgage, a student loan for a in-demand skill) can be worth taking on carefully. Debt that funds things that lose value fast and carries a high interest rate (credit card balances on wants, most short-term loans) tends to compound against you. When in doubt, ask: does this debt make me money later, or just cost me money now?' },
  { id: 'compound_interest', category: 'Investing', title: 'How Compound Interest Works', minutes: 4,
    content: 'Compound interest is interest earned on your interest, not just your original amount. The earlier you start saving or investing, the more time compounding has to work — a small amount saved in your 20s can outgrow a much larger amount saved starting in your 40s, purely because of time. This cuts both ways: it also makes carrying a credit card balance expensive fast.' },
  { id: 'credit_score_101', category: 'Credit', title: 'What Actually Moves Your Credit Score', minutes: 4,
    content: 'The two biggest factors are payment history (always pay at least the minimum, on time) and credit utilization (how much of your available credit you are using — lower is better, ideally under 30%). Length of credit history, new credit inquiries, and the mix of credit types matter less, but still add up. Closing your oldest card can actually hurt your score by shortening your history.' },
  { id: 'needs_vs_wants', category: 'Budgeting', title: 'Needs vs Wants, Honestly', minutes: 3,
    content: 'A need keeps you fed, housed, and able to work. Everything else is a want — even things that feel essential in the moment, like a subscription or the newest phone. This is not about guilt; it is about knowing which spending you can flex when money is tight, so cutting back is a choice you make on purpose instead of a surprise.' },
  { id: 'paying_off_debt_strategies', category: 'Debt', title: 'Snowball vs Avalanche', minutes: 4,
    content: 'Two popular ways to pay off multiple debts: the snowball method pays off the smallest balance first for quick psychological wins, while the avalanche method pays off the highest-interest debt first to save the most money overall. Snowball tends to keep people motivated; avalanche is mathematically cheaper. The best method is the one you will actually stick with.' },
  { id: 'diversification', category: 'Investing', title: 'Do not Put All Your Eggs in One Basket', minutes: 3,
    content: 'Diversification means spreading your money across different investments so one bad outcome does not wipe you out. This does not guarantee profit, but it reduces the chance that a single company, sector, or market event tanks your entire savings. Index funds are a common way to get broad diversification without picking individual stocks yourself.' },
  { id: 'lifestyle_inflation', category: 'Saving', title: 'Watch Lifestyle Inflation', minutes: 3,
    content: 'Lifestyle inflation is when your spending rises to match every raise or bonus, so your savings rate never actually improves even as you earn more. A simple guard: whenever your income goes up, commit a fixed share of the increase to savings or debt payoff before your spending has a chance to absorb it.' },
  { id: 'reading_a_statement', category: 'Credit', title: 'Reading Your Statement Without the Panic', minutes: 3,
    content: 'Your statement balance, current balance, and minimum payment are three different numbers. Paying only the statement balance in full by the due date avoids interest entirely. Paying only the minimum keeps you technically current but lets interest pile up on the rest. Knowing which number you are looking at prevents accidental interest charges.' }
];

app.get('/lessons', requireAuth, async (req, res) => {
  const { data: completedRows, error } = await req.supabase
    .from('user_lesson_progress')
    .select('lesson_id, completed_at')
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  const completedMap = new Map(completedRows.map(r => [r.lesson_id, r.completed_at]));

  const lessons = LESSONS.map(l => ({
    ...l,
    completed: completedMap.has(l.id),
    completed_at: completedMap.get(l.id) || null
  }));

  res.json({
    lessons,
    completed_count: completedMap.size,
    total_count: LESSONS.length,
    percent_complete: LESSONS.length > 0 ? Math.round((completedMap.size / LESSONS.length) * 100) : 0
  });
});

app.post('/lessons/:id/complete', requireAuth, async (req, res) => {
  const lesson = LESSONS.find(l => l.id === req.params.id);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

  const { error } = await req.supabase
    .from('user_lesson_progress')
    .upsert({ user_id: req.user.id, lesson_id: lesson.id, completed_at: new Date().toISOString() }, { onConflict: 'user_id,lesson_id' });
  if (error) return res.status(500).json({ error: error.message });

  const { data: completedRows, error: countError } = await req.supabase
    .from('user_lesson_progress')
    .select('lesson_id')
    .eq('user_id', req.user.id);
  if (countError) return res.status(500).json({ error: countError.message });

  res.json({ completed: true, completed_count: completedRows.length, total_count: LESSONS.length });
});

// ---------------- Quick Actions ----------------
const QUICK_ACTION_CATEGORIES = [
  { category: 'Food', icon: 'restaurant' },
  { category: 'Transport', icon: 'directions_car' },
  { category: 'Groceries', icon: 'shopping_cart' },
  { category: 'Coffee', icon: 'local_cafe' },
  { category: 'Bills', icon: 'receipt_long' },
  { category: 'Shopping', icon: 'shopping_bag' }
];

app.get('/quick-stats', requireAuth, async (req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data, error } = await req.supabase
    .from('transactions')
    .select('type, amount, created_at')
    .eq('user_id', req.user.id)
    .gte('created_at', todayStart.toISOString());
  if (error) return res.status(500).json({ error: error.message });

  const todaySpent = data
    .filter(t => t.type === 'outflow')
    .reduce((sum, t) => sum + Number(t.amount), 0);
  const todayCount = data.filter(t => t.type === 'outflow').length;

  res.json({
    today_spent: todaySpent,
    today_count: todayCount,
    quick_categories: QUICK_ACTION_CATEGORIES
  });
});

// ---------------- AI Assistant ----------------
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';

async function callClaude({ system, messages, tools, tool_choice }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not set on the server');
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system,
    messages
  };
  if (tools) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || 'Claude API request failed');
    err.code = 'CLAUDE_API_ERROR';
    throw err;
  }
  return data;
}

async function buildFinancialSnapshot(req) {
  const [{ data: accounts }, { data: txns }, { data: debts }] = await Promise.all([
    req.supabase.from('accounts').select('name, type, current_balance').eq('user_id', req.user.id),
    req.supabase.from('transactions').select('type, amount, category, created_at').eq('user_id', req.user.id),
    req.supabase.from('debts').select('type, person_name, original_amount, amount_paid, status').eq('user_id', req.user.id)
  ]);

  const safeAccounts = accounts || [];
  const safeTxns = txns || [];
  const safeDebts = debts || [];

  const assets = safeAccounts.filter(a => a.type !== 'Credit').reduce((s, a) => s + Number(a.current_balance), 0);
  const liabilities = safeAccounts.filter(a => a.type === 'Credit').reduce((s, a) => s + Math.abs(Number(a.current_balance)), 0);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const thisMonthTxns = safeTxns.filter(t => new Date(t.created_at) >= monthStart);
  const monthSpent = thisMonthTxns.filter(t => t.type === 'outflow').reduce((s, t) => s + Number(t.amount), 0);
  const monthIncome = thisMonthTxns.filter(t => t.type === 'cash_in').reduce((s, t) => s + Number(t.amount), 0);

  const categoryTotals = {};
  thisMonthTxns.filter(t => t.type === 'outflow').forEach(t => {
    categoryTotals[t.category] = (categoryTotals[t.category] || 0) + Number(t.amount);
  });
  const topCategories = Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, amt]) => `${cat}: ₱${amt.toFixed(2)}`)
    .join(', ') || 'none yet';

  const openDebts = safeDebts.filter(d => d.status !== 'settled');
  const debtSummary = openDebts.length > 0
    ? openDebts.map(d => `${d.type === 'owed_by_me' ? 'owes' : 'owed by'} ${d.person_name}: ₱${(Number(d.original_amount) - Number(d.amount_paid || 0)).toFixed(2)}`).join('; ')
    : 'none';

  return `Net worth: ₱${(assets - liabilities).toFixed(2)} (assets ₱${assets.toFixed(2)}, liabilities ₱${liabilities.toFixed(2)}).
This month so far: spent ₱${monthSpent.toFixed(2)}, income ₱${monthIncome.toFixed(2)}.
Top spending categories this month: ${topCategories}.
Open debts: ${debtSummary}.`;
}

const LOG_TRANSACTION_TOOL = {
  name: 'log_transaction',
  description: 'Log a new expense (money spent) for the user when their message describes a purchase or payment they made. Only use this when they clearly want to record spending, not when just asking a question.',
  input_schema: {
    type: 'object',
    properties: {
      amount: { type: 'number', description: 'The amount spent, in PHP' },
      category: { type: 'string', description: 'One of: Food, Groceries, Transport, Coffee, Bills, Shopping, Health, Entertainment, Other' },
      note: { type: 'string', description: 'A short note about the purchase, optional' }
    },
    required: ['amount', 'category']
  }
};

app.post('/assistant/chat', requireAuth, async (req, res) => {
  const { message, history } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  try {
    const snapshot = await buildFinancialSnapshot(req);
    const systemPrompt = `You are the in-app financial assistant for Fondly, a personal finance app. Be concise, friendly, and practical. Use PHP (₱) for amounts. Here is the user's current financial snapshot:\n\n${snapshot}\n\nIf the user describes spending money (e.g. "I spent 150 on lunch"), use the log_transaction tool to record it instead of just replying in text. Otherwise, answer their question directly using the snapshot data when relevant.`;

    const messages = [
      ...(Array.isArray(history) ? history : []),
      { role: 'user', content: message }
    ];

    const first = await callClaude({
      system: systemPrompt,
      messages,
      tools: [LOG_TRANSACTION_TOOL]
    });

    const toolUse = (first.content || []).find(block => block.type === 'tool_use' && block.name === 'log_transaction');

    if (first.stop_reason === 'tool_use' && toolUse) {
      const { amount, category, note } = toolUse.input;

      const { data: inserted, error: insertError } = await req.supabase
        .from('transactions')
        .insert([{ type: 'outflow', amount, category, note: note || null, user_id: req.user.id, account_id: null }])
        .select();
      if (insertError) throw new Error(insertError.message);

      const followUpMessages = [
        ...messages,
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Logged: ₱${amount} on ${category}${note ? ' (' + note + ')' : ''}.`
          }]
        }
      ];

      const second = await callClaude({
        system: systemPrompt,
        messages: followUpMessages
      });

      const replyText = (second.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || 'Logged it!';

      return res.json({
        reply: replyText,
        logged: true,
        transaction: inserted[0],
        history: followUpMessages.concat([{ role: 'assistant', content: second.content }])
      });
    }

    const replyText = (first.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || "I'm not sure how to respond to that.";

    res.json({
      reply: replyText,
      logged: false,
      history: messages.concat([{ role: 'assistant', content: first.content }])
    });
  } catch (err) {
    if (err.code === 'MISSING_API_KEY') {
      return res.status(503).json({ error: 'The AI assistant is not configured yet. Add ANTHROPIC_API_KEY to your backend .env file.' });
    }
    res.status(500).json({ error: err.message });
  }
});

const EXTRACT_RECEIPT_TOOL = {
  name: 'extract_receipt',
  description: 'Extract structured purchase details from a photo of a receipt.',
  input_schema: {
    type: 'object',
    properties: {
      merchant: { type: 'string', description: 'The store or merchant name, or "Unknown" if not legible' },
      amount: { type: 'number', description: 'The total amount paid, as a plain number' },
      category: { type: 'string', description: 'Best guess category: Food, Groceries, Transport, Coffee, Bills, Shopping, Health, Entertainment, or Other' },
      date: { type: 'string', description: 'The date on the receipt in YYYY-MM-DD format, or "" if not legible' }
    },
    required: ['merchant', 'amount', 'category']
  }
};

app.post('/assistant/scan-receipt', requireAuth, async (req, res) => {
  const { image_base64, media_type } = req.body;
  if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const type = allowedTypes.includes(media_type) ? media_type : 'image/jpeg';

  try {
    const result = await callClaude({
      system: 'You extract structured data from receipt photos. Always call the extract_receipt tool with your best reading of the receipt, even if some fields are unclear.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: type, data: image_base64 } },
          { type: 'text', text: 'Extract the merchant, total amount, best-guess category, and date from this receipt.' }
        ]
      }],
      tools: [EXTRACT_RECEIPT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_receipt' }
    });

    const toolUse = (result.content || []).find(block => block.type === 'tool_use' && block.name === 'extract_receipt');
    if (!toolUse) throw new Error('Could not read the receipt');

    res.json(toolUse.input);
  } catch (err) {
    if (err.code === 'MISSING_API_KEY') {
      return res.status(503).json({ error: 'The AI assistant is not configured yet. Add ANTHROPIC_API_KEY to your backend .env file.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/premium/status', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('premium_status')
    .select('is_premium, unlocked_at, payment_method')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || { is_premium: false });
});

app.get('/coach-insights', requireAuth, requirePremium, async (req, res) => {
  const { data, error } = await req.supabase
    .from('transactions')
    .select('type, amount, created_at')
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();

  let totalCashIn = 0;
  let totalOutflow = 0;
  data.forEach(row => {
    if (row.type === 'cash_in') totalCashIn += Number(row.amount);
    if (row.type === 'outflow') totalOutflow += Number(row.amount);
  });

  const dailyBurn = dayOfMonth > 0 ? totalOutflow / dayOfMonth : 0;
  const safeSpendable = totalCashIn * 0.8;
  const targetDaily = daysInMonth > 0 ? safeSpendable / daysInMonth : 0;
  const paceGap = dailyBurn - targetDaily;

  res.json({
    totalCashIn,
    totalOutflow,
    dailyBurn: Math.round(dailyBurn),
    targetDaily: Math.round(targetDaily),
    paceGap: Math.round(paceGap),
    isOverPace: paceGap > 0
  });
});

app.get('/savings-target', requireAuth, async (req, res) => {
  const { data: targetRow, error: targetError } = await req.supabase
    .from('savings_targets')
    .select('monthly_target')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (targetError) return res.status(500).json({ error: targetError.message });

  const target = targetRow ? Number(targetRow.monthly_target) : 0;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  const { data: txns, error: txError } = await req.supabase
    .from('transactions')
    .select('type, amount')
    .eq('user_id', req.user.id)
    .gte('created_at', monthStart);
  if (txError) return res.status(500).json({ error: txError.message });

  let cashIn = 0;
  let outflow = 0;
  txns.forEach(row => {
    if (row.type === 'cash_in') cashIn += Number(row.amount);
    if (row.type === 'outflow') outflow += Number(row.amount);
  });

  const saved = cashIn - outflow;
  res.json({
    target,
    cash_in: cashIn,
    outflow,
    saved,
    remaining: Math.max(target - saved, 0),
    percent: target > 0 ? Math.max(Math.round((saved / target) * 100), 0) : 0,
    days_left: daysInMonth - now.getDate()
  });
});

app.post('/savings-target', requireAuth, async (req, res) => {
  const value = Number(req.body.monthly_target);
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'monthly_target must be a number greater than 0' });
  }

  const { data, error } = await req.supabase
    .from('savings_targets')
    .upsert(
      { user_id: req.user.id, monthly_target: value, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});


app.get('/roundup-settings', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('roundup_settings')
    .select('*')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || { enabled: false, round_to: 10, goal_id: null, total_saved: 0 });
});

app.post('/roundup-settings', requireAuth, async (req, res) => {
  const { enabled, round_to, goal_id } = req.body;

  const { data, error } = await req.supabase
    .from('roundup_settings')
    .upsert(
      { user_id: req.user.id, enabled, round_to, goal_id: goal_id || null },
      { onConflict: 'user_id' }
    )
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

async function applyRoundup(req, transactionAmount) {
  const { data: settings } = await req.supabase
    .from('roundup_settings')
    .select('*')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!settings || !settings.enabled || !settings.goal_id) return null;

  const roundTo = Number(settings.round_to);
  if (!roundTo || roundTo <= 0) return null;

  const rounded = Math.ceil(transactionAmount / roundTo) * roundTo;
  const spareChange = Math.round((rounded - transactionAmount) * 100) / 100;
  if (spareChange <= 0) return null;

  const { data: goal } = await req.supabase
    .from('goals')
    .select('*')
    .eq('id', settings.goal_id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (!goal) return null;

  const newGoalAmount = Number(goal.current_amount || 0) + spareChange;
  await req.supabase
    .from('goals')
    .update({ current_amount: newGoalAmount })
    .eq('id', goal.id)
    .eq('user_id', req.user.id);

  await req.supabase
    .from('roundup_settings')
    .update({ total_saved: Number(settings.total_saved) + spareChange })
    .eq('user_id', req.user.id);

  return { spareChange, goalName: goal.name, newGoalAmount };
}


app.get('/topup/packages', (req, res) => {
  res.json(DIAMOND_PACKAGES);
});

app.get('/topup/orders', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('topup_orders')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

async function createTopupOrder(req, pkg, mlbb_user_id, mlbb_zone_id, payment_method) {
  const { data, error } = await req.supabase
    .from('topup_orders')
    .insert([{
      user_id: req.user.id,
      mlbb_user_id,
      mlbb_zone_id,
      package_diamonds: pkg.diamonds,
      price_php: pkg.price_php,
      payment_method,
      status: 'pending'
    }])
    .select();
  if (error) throw new Error(error.message);
  return data[0];
}

async function fulfillAndRecordOrder(userClient, order) {
  try {
    const result = await fulfillDiamondTopUp(order);

    await userClient
      .from('topup_orders')
      .update({ status: 'fulfilled', provider_order_id: result.providerOrderId, fulfilled_at: new Date().toISOString() })
      .eq('id', order.id);

    await userClient.from('transactions').insert([{
      type: 'outflow',
      amount: order.price_php,
      category: 'Shopping',
      payment_method: order.payment_method,
      note: `MLBB Top-Up — ${order.package_diamonds} Diamonds`,
      user_id: order.user_id
    }]);

    return { fulfilled: true };
  } catch (err) {
    await userClient
      .from('topup_orders')
      .update({ status: 'failed' })
      .eq('id', order.id);
    return { fulfilled: false, error: err.message };
  }
}

app.post('/topup/gcash/create-source', requireAuth, async (req, res) => {
  const { package_id, mlbb_user_id, mlbb_zone_id } = req.body;
  const pkg = DIAMOND_PACKAGES.find(p => p.id === package_id);
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });
  if (!mlbb_user_id || !mlbb_zone_id) return res.status(400).json({ error: 'MLBB User ID and Zone ID are required' });

  try {
    const order = await createTopupOrder(req, pkg, mlbb_user_id, mlbb_zone_id, 'GCash');

    const authHeader = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const ref = crypto.randomUUID();

    const sourceRes = await fetch('https://api.paymongo.com/v1/sources', {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(pkg.price_php * 100),
            redirect: {
              success: `${APP_BASE_URL}/cash-in-success.html?source_id=${ref}`,
              failed: `${APP_BASE_URL}/cash-in-failed.html?source_id=${ref}`
            },
            type: 'gcash',
            currency: 'PHP'
          }
        }
      })
    });
    const sourceData = await sourceRes.json();
    if (!sourceRes.ok) throw new Error(sourceData.errors?.[0]?.detail || 'Could not create GCash source');
    const source = sourceData.data;

    pendingTopupGcash.set(ref, {
      paymongoSourceId: source.id,
      token: req.headers.authorization.slice(7),
      orderId: order.id
    });

    res.json({ checkoutUrl: source.attributes.redirect.checkout_url, orderId: order.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/topup/gcash/confirm', async (req, res) => {
  const sourceId = req.query.source_id;
  const pending = pendingTopupGcash.get(sourceId);
  if (!pending) return res.status(404).json({ error: 'No pending top-up found for this source' });

  try {
    const authHeader = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const checkRes = await fetch(`https://api.paymongo.com/v1/sources/${pending.paymongoSourceId}`, {
      headers: { 'Authorization': authHeader }
    });
    const checkData = await checkRes.json();
    if (checkData.data.attributes.status !== 'chargeable') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${pending.token}` } }
    });

    const { data: order } = await userClient.from('topup_orders').select('*').eq('id', pending.orderId).maybeSingle();
    if (!order) throw new Error('Order not found');

    const paymentRes = await fetch('https://api.paymongo.com/v1/payments', {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(order.price_php * 100),
            currency: 'PHP',
            source: { id: pending.paymongoSourceId, type: 'source' },
            description: `MLBB Top-Up — ${order.package_diamonds} Diamonds`
          }
        }
      })
    });
    const paymentData = await paymentRes.json();
    if (!paymentRes.ok) throw new Error(paymentData.errors?.[0]?.detail || 'Payment failed');

    await userClient.from('topup_orders').update({ status: 'paid', paymongo_ref: paymentData.data.id }).eq('id', order.id);

    const fulfillResult = await fulfillAndRecordOrder(userClient, order);

    pendingTopupGcash.delete(sourceId);
    res.json({ success: true, ...fulfillResult, package_diamonds: order.package_diamonds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/topup/qrph/create-intent', requireAuth, async (req, res) => {
  const { package_id, mlbb_user_id, mlbb_zone_id } = req.body;
  const pkg = DIAMOND_PACKAGES.find(p => p.id === package_id);
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });
  if (!mlbb_user_id || !mlbb_zone_id) return res.status(400).json({ error: 'MLBB User ID and Zone ID are required' });

  try {
    const order = await createTopupOrder(req, pkg, mlbb_user_id, mlbb_zone_id, 'QR Ph');

    const secretAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const publicAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_PUBLIC_KEY}:`).toString('base64');

    const intentRes = await fetch('https://api.paymongo.com/v1/payment_intents', {
      method: 'POST',
      headers: { 'Authorization': secretAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(pkg.price_php * 100),
            currency: 'PHP',
            payment_method_allowed: ['qrph'],
            description: `MLBB Top-Up — ${pkg.diamonds} Diamonds`
          }
        }
      })
    });
    const intentData = await intentRes.json();
    if (!intentRes.ok) throw new Error(intentData.errors?.[0]?.detail || 'Could not create payment intent');
    const intent = intentData.data;

    const methodRes = await fetch('https://api.paymongo.com/v1/payment_methods', {
      method: 'POST',
      headers: { 'Authorization': publicAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { attributes: { type: 'qrph' } } })
    });
    const methodData = await methodRes.json();
    if (!methodRes.ok) throw new Error(methodData.errors?.[0]?.detail || 'Could not create payment method');
    const paymentMethod = methodData.data;

    const attachRes = await fetch(`https://api.paymongo.com/v1/payment_intents/${intent.id}/attach`, {
      method: 'POST',
      headers: { 'Authorization': publicAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { attributes: { payment_method: paymentMethod.id, client_key: intent.attributes.client_key } } })
    });
    const attachData = await attachRes.json();
    if (!attachRes.ok) throw new Error(attachData.errors?.[0]?.detail || 'Could not attach payment method');
    const attachedIntent = attachData.data;

    const qrImageUrl = attachedIntent.attributes.next_action?.code?.image_url;
    if (!qrImageUrl) throw new Error('QR code was not generated');

    pendingTopupQrph.set(intent.id, {
      token: req.headers.authorization.slice(7),
      orderId: order.id
    });

    res.json({ qrImageUrl, intentId: intent.id, orderId: order.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/topup/qrph/status/:intentId', async (req, res) => {
  const { intentId } = req.params;
  const pending = pendingTopupQrph.get(intentId);
  if (!pending) return res.status(404).json({ error: 'No pending top-up found for this intent' });

  try {
    const secretAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    const checkRes = await fetch(`https://api.paymongo.com/v1/payment_intents/${intentId}`, {
      headers: { 'Authorization': secretAuth }
    });
    const checkData = await checkRes.json();
    const status = checkData.data.attributes.status;

    if (status !== 'succeeded') return res.json({ status });

    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${pending.token}` } }
    });

    const { data: order } = await userClient.from('topup_orders').select('*').eq('id', pending.orderId).maybeSingle();
    if (!order) throw new Error('Order not found');

    await userClient.from('topup_orders').update({ status: 'paid', paymongo_ref: intentId }).eq('id', order.id);

    const fulfillResult = await fulfillAndRecordOrder(userClient, order);

    pendingTopupQrph.delete(intentId);
    res.json({ status: 'succeeded', ...fulfillResult, package_diamonds: order.package_diamonds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/users', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('profiles')
         .select('id, email, display_name, last_seen, avatar_url, first_name, last_name')
    .neq('id', req.user.id)
    .order('display_name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const withStatus = data.map(u => ({ ...u, is_online: isRecentlyOnline(u.last_seen) }));
  res.json(withStatus);
});

app.get('/conversations', requireAuth, async (req, res) => {
  const { data: participantRows, error: partError } = await req.supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', req.user.id);
  if (partError) return res.status(500).json({ error: partError.message });

  const convIds = participantRows.map(r => r.conversation_id);
  if (convIds.length === 0) return res.json([]);

  const { data: conversations, error: convError } = await req.supabase
    .from('conversations')
    .select('*')
    .in('id', convIds)
    .order('created_at', { ascending: false });
  if (convError) return res.status(500).json({ error: convError.message });

  const { data: allParticipants, error: allPartError } = await req.supabase
    .from('conversation_participants')
         .select('conversation_id, user_id, profiles(id, email, display_name, last_seen, avatar_url, first_name, last_name)')
    .in('conversation_id', convIds);
  if (allPartError) return res.status(500).json({ error: allPartError.message });

  const result = conversations.map(conv => {
    const members = allParticipants
      .filter(p => p.conversation_id === conv.id)
      .map(p => p.profiles);
       const otherMember = !conv.is_group ? members.find(m => m && m.id !== req.user.id) : null;
    return {
      ...conv,
      members,
      display_name: conv.is_group ? (conv.name || 'Group chat') : (otherMember ? (otherMember.display_name || otherMember.email) : 'Conversation'),
      is_online: otherMember ? isRecentlyOnline(otherMember.last_seen) : false
    };
  });

  res.json(result);
});

app.post('/conversations', requireAuth, async (req, res) => {
  const { participant_ids, is_group, name } = req.body;
  if (!participant_ids || !Array.isArray(participant_ids) || participant_ids.length === 0) {
    return res.status(400).json({ error: 'participant_ids is required' });
  }

  const allParticipantIds = [...new Set([...participant_ids, req.user.id])];

  if (!is_group && allParticipantIds.length === 2) {
    const { data: myConvs } = await req.supabase
      .from('conversation_participants')
      .select('conversation_id')
      .eq('user_id', req.user.id);
    const myConvIds = (myConvs || []).map(r => r.conversation_id);

    if (myConvIds.length > 0) {
      const { data: candidates } = await req.supabase
        .from('conversations')
        .select('id')
        .eq('is_group', false)
        .in('id', myConvIds);

      for (const c of candidates || []) {
        const { data: participants } = await req.supabase
          .from('conversation_participants')
          .select('user_id')
          .eq('conversation_id', c.id);
        const ids = (participants || []).map(p => p.user_id).sort();
        if (ids.length === 2 && ids.join(',') === allParticipantIds.slice().sort().join(',')) {
          return res.json({ id: c.id, existing: true });
        }
      }
    }
  }

  const { data: conv, error: convError } = await req.supabase
    .from('conversations')
    .insert([{ is_group: !!is_group, name: name || null, created_by: req.user.id }])
    .select();
  if (convError) return res.status(500).json({ error: convError.message });

  const conversationId = conv[0].id;
  const participantRows = allParticipantIds.map(uid => ({ conversation_id: conversationId, user_id: uid }));

  const { error: partError } = await req.supabase
    .from('conversation_participants')
    .insert(participantRows);
  if (partError) return res.status(500).json({ error: partError.message });

  res.status(201).json({ id: conversationId, existing: false });
});

app.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  const { data: isParticipant } = await req.supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (!isParticipant) return res.status(403).json({ error: 'Not a participant in this conversation' });

  const { data, error } = await req.supabase
    .from('messages')
          .select('*, profiles(display_name, email, avatar_url, first_name, last_name)')
    .eq('conversation_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  const { body, attachment_url, attachment_name, attachment_type } = req.body;
  if ((!body || !body.trim()) && !attachment_url) {
    return res.status(400).json({ error: 'Message body or attachment is required' });
  }

  const { data, error } = await req.supabase
    .from('messages')
    .insert([{
      conversation_id: req.params.id,
      sender_id: req.user.id,
      body: body || null,
      attachment_url: attachment_url || null,
      attachment_name: attachment_name || null,
      attachment_type: attachment_type || null
    }])
        .select('*, profiles(display_name, email, avatar_url)');
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data[0]);
});


app.post('/conversations/:id/attachments/upload-url', requireAuth, async (req, res) => {
  const { file_name } = req.body;
  if (!file_name) return res.status(400).json({ error: 'file_name is required' });

  const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${req.params.id}/${Date.now()}-${safeName}`;

  const { data, error } = await req.supabase
    .storage
    .from('message-attachments')
    .createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    signedUrl: data.signedUrl,
    path: data.path,
    token: data.token
  });
});

app.get('/attachments/signed-url', requireAuth, async (req, res) => {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path is required' });

  const { data, error } = await req.supabase
    .storage
    .from('message-attachments')
    .createSignedUrl(path, 3600);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ signedUrl: data.signedUrl });
});

app.patch('/messages/:id', requireAuth, async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });

  const { data: existing, error: fetchError } = await req.supabase
    .from('messages')
    .select('sender_id, deleted')
    .eq('id', req.params.id)
    .maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Message not found' });
  if (existing.sender_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages' });
  if (existing.deleted) return res.status(400).json({ error: 'Cannot edit a deleted message' });

  const { data, error } = await req.supabase
    .from('messages')
    .update({ body, edited_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('sender_id', req.user.id)
       .select('*, profiles(display_name, email, avatar_url, first_name, last_name)');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/messages/:id', requireAuth, async (req, res) => {
  const { data: existing, error: fetchError } = await req.supabase
    .from('messages')
    .select('sender_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Message not found' });
  if (existing.sender_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own messages' });

  const { data, error } = await req.supabase
    .from('messages')
    .update({ deleted: true, body: null })
    .eq('id', req.params.id)
    .eq('sender_id', req.user.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});


app.post('/profile/heartbeat', requireAuth, async (req, res) => {
  const { error } = await req.supabase
    .from('profiles')
    .update({ last_seen: new Date().toISOString() })
    .eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

function isRecentlyOnline(lastSeen) {
  if (!lastSeen) return false;
  return (Date.now() - new Date(lastSeen).getTime()) < 60000;
}


app.get('/posts', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('posts')
    .select('*, profiles(display_name, email, avatar_url, first_name, last_name)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/posts', requireAuth, async (req, res) => {
  const { caption, media_url, media_type } = req.body;
  if ((!caption || !caption.trim()) && !media_url) {
    return res.status(400).json({ error: 'Caption or media is required' });
  }

  const { data, error } = await req.supabase
    .from('posts')
    .insert([{
      user_id: req.user.id,
      caption: caption || null,
      media_url: media_url || null,
      media_type: media_type || null
    }])
    .select('*, profiles(display_name, email)');
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data[0]);
});

app.delete('/posts/:id', requireAuth, async (req, res) => {
  const { error } = await req.supabase
    .from('posts')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/posts/media/upload-url', requireAuth, async (req, res) => {
  const { file_name } = req.body;
  if (!file_name) return res.status(400).json({ error: 'file_name is required' });

  const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${req.user.id}/${Date.now()}-${safeName}`;

  const { data, error } = await req.supabase
    .storage
    .from('posts-media')
    .createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ signedUrl: data.signedUrl, path: data.path, token: data.token });
});

app.get('/posts/media/signed-url', requireAuth, async (req, res) => {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path is required' });

  const { data, error } = await req.supabase
    .storage
    .from('posts-media')
    .createSignedUrl(path, 3600);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ signedUrl: data.signedUrl });
});

app.get('/stories', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('stories')
    .select('*, profiles(display_name, email, avatar_url, first_name, last_name)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/stories', requireAuth, async (req, res) => {
  const { media_url, media_type, caption } = req.body;
  if (!media_url || !media_type) {
    return res.status(400).json({ error: 'media_url and media_type are required' });
  }

  const { data, error } = await req.supabase
    .from('stories')
    .insert([{
      user_id: req.user.id,
      media_url,
      media_type,
      caption: caption || null
    }])
    .select('*, profiles(display_name, email)');
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data[0]);
});

app.delete('/stories/:id', requireAuth, async (req, res) => {
  const { error } = await req.supabase
    .from('stories')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/profile/avatar', requireAuth, async (req, res) => {
  const { avatar_url } = req.body;
  if (!avatar_url) return res.status(400).json({ error: 'avatar_url is required' });

  const { error } = await req.supabase
    .from('profiles')
    .update({ avatar_url })
    .eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, avatar_url });
});

app.get('/profile/avatar', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('profiles')
    .select('avatar_url')
    .eq('id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ avatar_url: data ? data.avatar_url : null });
});


app.get('/profile/name', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ first_name: data ? data.first_name : null, last_name: data ? data.last_name : null });
});

app.post('/profile/name', requireAuth, async (req, res) => {
  const { first_name, last_name } = req.body;
  if (!first_name || !first_name.trim()) return res.status(400).json({ error: 'First name is required' });

  const { error } = await req.supabase
    .from('profiles')
    .update({ first_name: first_name.trim(), last_name: last_name ? last_name.trim() : null })
    .eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Background check: credits FondlyCash even if the Cash In page was closed
setInterval(async () => {
  for (const [intentId, pending] of pendingQrphIntents) {
    if (!pending.createdAt) pending.createdAt = Date.now();
    if (Date.now() - pending.createdAt > 30 * 60 * 1000) {
      pendingQrphIntents.delete(intentId);
      continue;
    }
    try {
      const secretAuth = 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
      const checkRes = await fetch(`https://api.paymongo.com/v1/payment_intents/${intentId}`, {
        headers: { 'Authorization': secretAuth }
      });
      const checkData = await checkRes.json();
      if (!checkData.data || checkData.data.attributes.status !== 'succeeded') continue;

      const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${pending.token}` } }
      });
      const credited = await recordCashIn(userClient, pending);
      if (credited) {
        pendingQrphIntents.delete(intentId);
        console.log('Background check: QR Ph cash in saved to FondlyCash');
      }
    } catch (err) {
      console.warn('Background cash in check failed:', err.message);
    }
  }
}, 5000);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
