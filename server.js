const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_DATA = path.join(__dirname, 'data');
const STORE_DIR = process.env.DATA_DIR || APP_DATA;
const ORDERS_FILE = path.join(STORE_DIR, 'orders.json');
const PRODUCTS_FILE = path.join(STORE_DIR, 'products.json');

const config = JSON.parse(fs.readFileSync(path.join(APP_DATA, 'config.json'), 'utf8'));

// ---------- Products (live file is editable from /admin; seeded from data/products.seed.json) ----------
fs.mkdirSync(STORE_DIR, { recursive: true });
if (!fs.existsSync(PRODUCTS_FILE)) fs.copyFileSync(path.join(APP_DATA, 'products.seed.json'), PRODUCTS_FILE);
let products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
const saveProducts = () => fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));

// ---------- Crypto ----------
const COINS = {
  BTC: { label: 'Bitcoin (BTC)', geckoId: 'bitcoin', decimals: 8, wallet: 'WALLET_BTC', network: 'Bitcoin' },
  ETH: { label: 'Ethereum (ETH)', geckoId: 'ethereum', decimals: 6, wallet: 'WALLET_ETH', network: 'Ethereum (ERC-20)' },
  SOL: { label: 'Solana (SOL)', geckoId: 'solana', decimals: 4, wallet: 'WALLET_SOL', network: 'Solana' },
  USDT_TRC20: { label: 'USDT (TRC20)', geckoId: null, decimals: 2, wallet: 'WALLET_USDT_TRC20', network: 'Tron (TRC20)' },
};
const walletFor = (code) => String(process.env[COINS[code].wallet] || (config.wallets || {})[code] || '').trim();

let rateCache = { t: 0, data: null };
async function getRates() {
  if (rateCache.data && Date.now() - rateCache.t < 60000) return rateCache.data;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('rate http ' + r.status);
    rateCache = { t: Date.now(), data: await r.json() };
  } catch (e) {
    if (!rateCache.data || Date.now() - rateCache.t > 10 * 60000) throw e; // allow a stale quote for up to 10 min
  }
  return rateCache.data;
}

// ---------- Middleware ----------
app.set('trust proxy', 1);
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
  })
);
app.use(express.json({ limit: '100kb' }));
app.get('/health', (req, res) => res.send('ok'));

// ---------- Public API ----------
app.get('/api/config', (req, res) => {
  const { businessName, tagline, phone, email, taxRate, minAge, locations } = config;
  res.json({ businessName, tagline, phone, email, taxRate, minAge, locations });
});

app.get('/api/payment-methods', (req, res) => {
  res.json(Object.entries(COINS).filter(([code]) => walletFor(code)).map(([code, c]) => ({ code, label: c.label, network: c.network })));
});

app.get('/api/products', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(products);
});

// ---------- Orders ----------
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= 15) return res.status(429).json({ error: 'Too many requests. Try again later.' });
  list.push(now);
  hits.set(req.ip, list);
  next();
}

let writeQueue = Promise.resolve();
function readOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch (e) { return []; }
}
function withOrders(mutator) {
  writeQueue = writeQueue.then(() => {
    const orders = readOrders();
    const result = mutator(orders);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    return result;
  });
  return writeQueue;
}
function notify(text, order) {
  if (!process.env.ORDER_WEBHOOK_URL) return;
  fetch(process.env.ORDER_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text, order }),
  }).catch((e) => console.error('Webhook failed:', e.message));
}
const clean = (v, max) => String(v || '').trim().slice(0, max);
const publicPayment = (o) => ({ orderId: o.id, token: o.token, total: o.total, location: o.location.name, fulfillment: o.fulfillment, deliveryAddress: o.deliveryAddress, payment: o.payment });

app.post('/api/orders', rateLimit, async (req, res) => {
  try {
    const b = req.body || {};
    const delivery = b.fulfillment !== 'pickup';
    const deliveryAddress = clean(b.deliveryAddress, 300);
    let location = config.locations.find((l) => l.id === b.locationId);
    if (delivery) {
      if (deliveryAddress.length < 10) return res.status(400).json({ error: 'Enter your full delivery address (street, city, ZIP).' });
      location = { id: 'delivery', name: 'Free delivery' };
    } else if (!location) {
      return res.status(400).json({ error: 'Choose a store for pickup.' });
    }
    const name = clean(b.name, 80);
    const phone = clean(b.phone, 30);
    if (!name || phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Enter your name and a valid phone number.' });
    if (b.ageConfirmed !== true) return res.status(400).json({ error: `You must be ${config.minAge}+ and bring a valid ID.` });

    const coin = COINS[b.coin];
    if (!coin || !walletFor(b.coin)) return res.status(400).json({ error: 'Choose a payment method.' });
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) return res.status(400).json({ error: 'Your cart is empty.' });

    const lines = [];
    let subtotal = 0;
    for (const it of b.items) {
      const p = products.find((x) => x.id === it.id);
      const size = p && p.sizes.find((s) => s.id === it.size);
      const qty = Number(it.qty);
      if (!p || !size || !Number.isInteger(qty) || qty < 1 || qty > 20) return res.status(400).json({ error: 'One of the items in your cart is no longer valid. Please review your cart.' });
      if (!p.inStock) return res.status(400).json({ error: `${p.name} is out of stock. Remove it from your cart.` });
      lines.push({ id: p.id, name: p.name, size: size.label, qty, price: size.price });
      subtotal += size.price * qty;
    }
    const tax = Math.round(subtotal * (config.taxRate || 0));
    const total = subtotal + tax;

    let amount;
    let rate = 1;
    if (b.coin === 'USDT_TRC20') {
      amount = (total / 100).toFixed(coin.decimals);
    } else {
      const rates = await getRates();
      rate = rates[coin.geckoId] && rates[coin.geckoId].usd;
      if (!rate) throw new Error('no rate');
      amount = (total / 100 / rate).toFixed(coin.decimals);
    }

    const order = {
      id: 'TD-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      token: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
      status: 'awaiting_payment',
      location: { id: location.id, name: location.name },
      customer: { name, phone, email: clean(b.email, 120) },
      pickupNote: clean(b.pickupNote, 300),
      fulfillment: delivery ? 'delivery' : 'pickup',
      deliveryAddress: delivery ? deliveryAddress : '',
      deliveryFee: 0,
      items: lines,
      subtotal, tax, total,
      payment: {
        coin: b.coin, label: coin.label, network: coin.network,
        address: walletFor(b.coin), amount, usdRate: rate,
        quotedAt: new Date().toISOString(),
      },
      txid: '',
    };
    await withOrders((orders) => orders.push(order));
    notify(`New ${order.fulfillment} order ${order.id}${delivery ? ' to ' + deliveryAddress : ' (' + location.name + ')'}: ${name}, ${phone}, $${(total / 100).toFixed(2)} in ${coin.label} - awaiting payment`, { ...order, token: undefined });
    res.status(201).json(publicPayment(order));
  } catch (e) {
    console.error(e);
    res.status(503).json({ error: 'Could not create your order or get a crypto price. Please try again in a moment.' });
  }
});

app.post('/api/orders/:id/payment', rateLimit, async (req, res) => {
  const txid = clean(req.body && req.body.txid, 140);
  const token = clean(req.body && req.body.token, 64);
  if (!/^[A-Za-z0-9]{10,140}$/.test(txid)) return res.status(400).json({ error: 'Enter a valid transaction ID (hash).' });
  const result = await withOrders((orders) => {
    const o = orders.find((x) => x.id === req.params.id);
    if (!o) return 'missing';
    const a = Buffer.from(o.token);
    const b = Buffer.from(token.padEnd(o.token.length, ' ').slice(0, o.token.length));
    if (!crypto.timingSafeEqual(a, b) || token !== o.token) return 'forbidden';
    o.txid = txid;
    if (o.status === 'awaiting_payment') o.status = 'payment_submitted';
    return o;
  });
  if (result === 'missing') return res.status(404).json({ error: 'Order not found.' });
  if (result === 'forbidden') return res.status(403).json({ error: 'Not allowed.' });
  notify(`Payment submitted for ${result.id}: ${result.payment.label} tx ${txid}`, { ...result, token: undefined });
  res.json({ ok: true });
});

// ---------- Admin (password protected) ----------
function adminAuth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return res.status(503).send('Set the ADMIN_PASSWORD environment variable to enable /admin.');
  const [type, token] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && token) {
    const decoded = Buffer.from(token, 'base64').toString();
    const given = decoded.slice(decoded.indexOf(':') + 1);
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(pw).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Top Deport Admin"').status(401).send('Authentication required');
}

const STATUSES = ['awaiting_payment', 'payment_submitted', 'paid', 'ready', 'completed', 'cancelled'];
app.get('/admin/api/orders', adminAuth, (req, res) => res.json(readOrders().reverse().map((o) => ({ ...o, token: undefined }))));
app.patch('/admin/api/orders/:id', adminAuth, async (req, res) => {
  if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Bad status' });
  const ok = await withOrders((orders) => {
    const o = orders.find((x) => x.id === req.params.id);
    if (o) o.status = req.body.status;
    return !!o;
  });
  res.status(ok ? 200 : 404).json({ ok });
});

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
function cleanImage(v) {
  const s = clean(v, 500);
  if (!s) return null;
  return /^https:\/\//i.test(s) || s.startsWith('/images/') ? s : undefined; // undefined = invalid
}
function cleanSizes(arr) {
  if (!Array.isArray(arr) || !arr.length || arr.length > 8) return null;
  const out = [];
  for (const s of arr) {
    const price = Math.round(Number(s.price));
    const label = clean(s.label, 40);
    const id = slug(s.id || label);
    if (!label || !id || !(price > 0) || price > 10000000) return null;
    const o = { id, label, price };
    const ca = Math.round(Number(s.compareAt));
    if (ca > price) o.compareAt = ca;
    out.push(o);
  }
  return out;
}

app.get('/admin/api/products', adminAuth, (req, res) => res.json(products));
app.patch('/admin/api/products/:id', adminAuth, (req, res) => {
  const p = products.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if ('inStock' in b) p.inStock = !!b.inStock;
  if ('image' in b) {
    const img = cleanImage(b.image);
    if (img === undefined) return res.status(400).json({ error: 'Image must be an https:// URL.' });
    p.image = img;
  }
  if ('name' in b && clean(b.name, 80)) p.name = clean(b.name, 80);
  if ('sizes' in b) {
    const sizes = cleanSizes(b.sizes);
    if (!sizes) return res.status(400).json({ error: 'Invalid sizes/prices.' });
    p.sizes = sizes;
  }
  saveProducts();
  res.json(p);
});
app.post('/admin/api/products', adminAuth, (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 80);
  const sizes = cleanSizes(b.sizes);
  const img = cleanImage(b.image);
  if (!name || !sizes || img === undefined) return res.status(400).json({ error: 'Name, sizes/prices, and a valid https image URL (or blank) are required.' });
  let id = slug(name);
  while (products.some((x) => x.id === id)) id += '-' + crypto.randomBytes(1).toString('hex');
  const p = {
    id, name, brand: clean(b.brand, 60), category: slug(clean(b.category, 30)) || 'flower', type: clean(b.type, 20).toLowerCase(),
    thc: clean(b.thc, 30), description: clean(b.description, 300), image: img, inStock: true, sizes,
  };
  products.push(p);
  saveProducts();
  res.status(201).json(p);
});
app.delete('/admin/api/products/:id', adminAuth, (req, res) => {
  const i = products.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  products.splice(i, 1);
  saveProducts();
  res.json({ ok: true });
});
app.use('/admin', adminAuth, express.static(path.join(__dirname, 'admin')));

// ---------- Static site ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

app.listen(PORT, () => console.log(`${config.businessName} running on port ${PORT}`));
