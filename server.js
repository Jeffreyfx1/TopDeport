const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_DATA = path.join(__dirname, 'data');

function resolveStoreDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try {
    if (fs.existsSync('/var/data') && fs.statSync('/var/data').isDirectory()) {
      const st = fs.statSync('/var/data');
      const parent = fs.statSync('/var');
      if (st.dev !== parent.dev) return '/var/data';
    }
  } catch (e) { /* no Render disk mounted */ }
  return APP_DATA;
}

const STORE_DIR = resolveStoreDir();
const ORDERS_FILE = path.join(STORE_DIR, 'orders.json');
const PRODUCTS_FILE = path.join(STORE_DIR, 'products.json');
const IMAGES_FILE = path.join(STORE_DIR, 'image-links.json');
const RATES_FILE = path.join(STORE_DIR, 'rates.json');

const config = JSON.parse(fs.readFileSync(path.join(APP_DATA, 'config.json'), 'utf8'));

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function imageMap(list) {
  const map = {};
  for (const p of list || []) if (p && p.id && p.image) map[p.id] = p.image;
  return map;
}

let products = [];

function saveProducts() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const links = imageMap(products);
  writeJsonAtomic(PRODUCTS_FILE, products);
  writeJsonAtomic(IMAGES_FILE, links);
  return true;
}

function loadProducts() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const seed = JSON.parse(fs.readFileSync(path.join(APP_DATA, 'products.seed.json'), 'utf8'));
  const saved = readJsonFile(PRODUCTS_FILE);
  const list = Array.isArray(saved) && saved.length ? saved : seed.map((p) => ({ ...p }));
  const seedImages = imageMap(seed);
  const links = readJsonFile(IMAGES_FILE) || {};
  for (const p of list) {
    if (!p || !p.id) continue;
    if (seedImages[p.id]) p.image = seedImages[p.id];
    else if (links[p.id]) p.image = links[p.id];
  }
  products = list;
  writeJsonAtomic(PRODUCTS_FILE, products);
  writeJsonAtomic(IMAGES_FILE, imageMap(products));
  const withImages = products.filter((p) => p && p.image).length;
  console.log(`Catalog: ${products.length} products, ${withImages} image links (hardcoded in the product file)`);
}

// ---------- Crypto ----------
const COINS = {
  BTC: { label: 'Bitcoin (BTC)', geckoId: 'bitcoin', decimals: 8, wallet: 'WALLET_BTC', network: 'Bitcoin' },
  ETH: { label: 'Ethereum (ETH)', geckoId: 'ethereum', decimals: 6, wallet: 'WALLET_ETH', network: 'Ethereum (ERC-20)' },
  SOL: { label: 'Solana (SOL)', geckoId: 'solana', decimals: 4, wallet: 'WALLET_SOL', network: 'Solana' },
  USDT_TRC20: { label: 'USDT (TRC20)', geckoId: null, decimals: 2, wallet: 'WALLET_USDT_TRC20', network: 'Tron (TRC20)' },
};
const walletFor = (code) => String(process.env[COINS[code].wallet] || (config.wallets || {})[code] || '').trim();

let rateCache = { t: 0, data: null };
async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}
function ratesLookOk(data) {
  return data && data.bitcoin && data.bitcoin.usd > 0 && data.ethereum && data.ethereum.usd > 0 && data.solana && data.solana.usd > 0;
}
async function getRates() {
  if (rateCache.data && Date.now() - rateCache.t < 60000) return rateCache.data;
  const sources = [
    async () => fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd'),
    async () => {
      const [btc, eth, sol] = await Promise.all([
        fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
        fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT'),
        fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT'),
      ]);
      return { bitcoin: { usd: Number(btc.price) }, ethereum: { usd: Number(eth.price) }, solana: { usd: Number(sol.price) } };
    },
    async () => {
      const [btc, eth, sol] = await Promise.all([
        fetchJson('https://api.coinbase.com/v2/prices/BTC-USD/spot'),
        fetchJson('https://api.coinbase.com/v2/prices/ETH-USD/spot'),
        fetchJson('https://api.coinbase.com/v2/prices/SOL-USD/spot'),
      ]);
      return { bitcoin: { usd: Number(btc.data.amount) }, ethereum: { usd: Number(eth.data.amount) }, solana: { usd: Number(sol.data.amount) } };
    },
  ];
  for (const load of sources) {
    try {
      const data = await load();
      if (!ratesLookOk(data)) continue;
      rateCache = { t: Date.now(), data };
      try { writeJsonAtomic(RATES_FILE, rateCache); } catch (e) { /* disk optional for rates */ }
      return data;
    } catch (e) {
      console.error('Price source failed:', e.message);
    }
  }
  const disk = readJsonFile(RATES_FILE);
  if (disk && ratesLookOk(disk.data)) return disk.data;
  if (rateCache.data) return rateCache.data;
  throw new Error('no rate');
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
  const run = writeQueue.then(() => {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const orders = readOrders();
    const result = mutator(orders);
    writeJsonAtomic(ORDERS_FILE, orders);
    return result;
  });
  writeQueue = run.catch((e) => console.error('Order save failed:', e.message));
  return run;
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
    let location = (config.locations || []).find((l) => l.id === b.locationId);
    if (delivery) {
      if (deliveryAddress.length < 10) return res.status(400).json({ error: 'Enter your full delivery address (street, city, ZIP).' });
      location = { id: 'delivery', name: 'Free delivery' };
    } else if (!location) {
      return res.status(400).json({ error: 'Choose a store for pickup.' });
    }
    const name = clean(b.name, 80);
    const phone = clean(b.phone, 30);
    if (!name || phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Enter your name and a valid phone number.' });

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
    const message = e && e.message === 'no rate'
      ? 'Could not get a crypto price right now. Please try again in a moment.'
      : 'Could not create your order. Please try again in a moment.';
    res.status(503).json({ error: message });
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
app.patch('/admin/api/products/:id', adminAuth, async (req, res) => {
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
  try {
    saveProducts();
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save the product.' });
  }
});
app.post('/admin/api/products', adminAuth, async (req, res) => {
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
  try {
    saveProducts();
    res.status(201).json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save the product.' });
  }
});
app.delete('/admin/api/products/:id', adminAuth, async (req, res) => {
  const i = products.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  products.splice(i, 1);
  try {
    saveProducts();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save the product.' });
  }
});
app.use('/admin', adminAuth, express.static(path.join(__dirname, 'admin')));

// ---------- Static site ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

if (require.main === module) {
  try {
    loadProducts();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`${config.businessName} running on port ${PORT}`));
}
