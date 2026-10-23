(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + (c / 100).toFixed(2);

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // ---------- Cart (browser only; the server re-prices everything at checkout) ----------
  const Cart = {
    items() { return store.get('cart2', []); },
    save(items) { store.set('cart2', items); Cart.updateBadge(); },
    add(id, size, q = 1) {
      const items = Cart.items();
      const e = items.find((x) => x.id === id && x.size === size);
      if (e) e.qty = Math.min(20, e.qty + q); else items.push({ id, size, qty: q });
      Cart.save(items);
    },
    setQty(id, size, q) {
      let items = Cart.items();
      if (q < 1) items = items.filter((x) => !(x.id === id && x.size === size));
      else { const e = items.find((x) => x.id === id && x.size === size); if (e) e.qty = Math.min(20, q); }
      Cart.save(items);
    },
    clear() { Cart.save([]); },
    count() { return Cart.items().reduce((n, x) => n + x.qty, 0); },
    updateBadge() { document.querySelectorAll('.cart-count').forEach((el) => (el.textContent = Cart.count())); },
  };

  let config = null;
  let productsPromise = null;
  const byId = new Map();
  const getProducts = () => (productsPromise = productsPromise || fetch('/api/products').then((r) => r.json()).then((list) => { list.forEach((p) => byId.set(p.id, p)); return list; }));
  const getLocationId = () => store.get('locationId', '');
  const setLocationId = (id) => store.set('locationId', id);
  const isDeal = (p) => p.sizes.some((s) => s.compareAt && s.compareAt > s.price);
  const sizeOf = (p, sid) => p.sizes.find((s) => s.id === sid);
  const defaultSize = (p) => p.sizes.find((s) => s.id === '3.5g') || p.sizes[0];

  function locationSelect(id, selected) {
    return `<select id="${id}" aria-label="Pickup store"><option value="">Choose a store</option>` +
      config.locations.map((l) => `<option value="${esc(l.id)}"${l.id === selected ? ' selected' : ''}>${esc(l.name)}</option>`).join('') + '</select>';
  }

  function priceHtml(s) {
    return `${money(s.price)}${s.compareAt && s.compareAt > s.price ? `<s>${money(s.compareAt)}</s>` : ''}`;
  }

  function thumbHtml(p, extra) {
    const img = p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : esc(p.category);
    return `<div class="thumb">${img}${extra || ''}</div>`;
  }

  function productCard(p) {
    const def = defaultSize(p);
    const tags = [p.type, p.thc].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const sizePicker = p.sizes.length > 1
      ? `<select class="size" aria-label="Size for ${esc(p.name)}">${p.sizes.map((s) => `<option value="${esc(s.id)}"${s.id === def.id ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select>`
      : `<div class="meta">${esc(def.label)}</div>`;
    return `<article class="card${p.inStock ? '' : ' soldout'}" data-pid="${esc(p.id)}">
      ${thumbHtml(p, (isDeal(p) ? '<span class="badge">Sale</span>' : '') + (p.inStock ? '' : '<span class="badge out">Out of stock</span>'))}
      <div class="card-body">
        <h3>${esc(p.name)}</h3>
        <div class="meta">${esc(p.brand)}</div>
        <div>${tags}</div>
        <p class="meta">${esc(p.description)}</p>
        ${sizePicker}
        <div class="card-foot">
          <span class="price">${priceHtml(def)}</span>
          ${p.inStock ? `<button class="btn small" data-add="${esc(p.id)}">Add to cart</button>` : '<button class="btn small" disabled>Out of stock</button>'}
        </div>
      </div></article>`;
  }

  function bindCards(root) {
    root.addEventListener('change', (e) => {
      if (!e.target.classList.contains('size')) return;
      const card = e.target.closest('.card');
      const p = byId.get(card.dataset.pid);
      $('.price', card).innerHTML = priceHtml(sizeOf(p, e.target.value));
    });
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-add]');
      if (!btn) return;
      const card = btn.closest('.card');
      const p = byId.get(btn.dataset.add);
      const sel = $('.size', card);
      Cart.add(p.id, sel ? sel.value : p.sizes[0].id);
      const old = btn.textContent;
      btn.textContent = 'Added';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 900);
    });
  }

  // Broken image links fall back to the category label instead of a broken icon
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.closest('.thumb')) {
      const cat = img.closest('.card, .line');
      const p = cat && byId.get((cat.dataset && cat.dataset.pid) || '');
      img.replaceWith(document.createTextNode(p ? p.category : ''));
    }
  }, true);

  // ---------- Header, footer, age gate ----------
  function renderChrome() {
    const page = document.body.dataset.page;
    const link = (href, label, key) => `<a href="${href}"${page === key ? ' aria-current="page"' : ''}>${label}</a>`;
    $('#site-header').outerHTML = `<header class="site-header"><div class="wrap">
      <a class="brand" href="/">${esc(config.businessName)}</a>
      <button class="menu-btn" aria-expanded="false" aria-controls="nav">Menu</button>
      <nav class="nav" id="nav" aria-label="Main">
        ${link('/shop', 'Shop', 'shop')}${link('/deals', 'Deals', 'deals')}${link('/locations', 'Locations', 'locations')}${link('/about', 'About', 'about')}
        <a class="cart-link" href="/cart"${page === 'cart' ? ' aria-current="page"' : ''}>Cart <span class="cart-count">0</span></a>
      </nav></div></header>`;
    const btn = $('.menu-btn');
    btn.addEventListener('click', () => {
      const open = $('#nav').classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
    $('#site-footer').outerHTML = `<footer class="site-footer"><div class="wrap">
      <div class="footer-grid">
        <div><h3>${esc(config.businessName)}</h3><p>${esc(config.tagline)}</p><p>${esc(config.phone)}<br><a href="mailto:${esc(config.email)}">${esc(config.email)}</a></p></div>
        <div><h3>Company</h3><p><a href="/about">About us</a><br><a href="/locations">Locations</a><br><a href="/shop">Shop</a><br><a href="/deals">Deals</a></p></div>
        <div><h3>Stores</h3>${config.locations.map((l) => `<p><strong>${esc(l.name)}</strong><br>${esc(l.address)}</p>`).join('')}</div>
      </div>
      <p class="legal" style="border:0;margin:0;padding-top:8px">&copy; ${new Date().getFullYear()} ${esc(config.businessName)}</p>
    </div></footer>`;
    Cart.updateBadge();
    document.title = document.title.replace('{{name}}', config.businessName);
  }

  function ageGate() {
    if (store.get('ageOk', false)) return;
    const g = document.createElement('div');
    g.className = 'gate';
    g.setAttribute('role', 'dialog');
    g.setAttribute('aria-modal', 'true');
    g.innerHTML = `<div class="gate-box"><h2>Are you ${config.minAge} or older?</h2>
      <p>You must be ${config.minAge}+ to view this site and to purchase cannabis products.</p>
      <div class="actions"><button class="btn" id="age-yes">Yes, I am ${config.minAge}+</button><button class="btn ghost" id="age-no">No</button></div></div>`;
    document.body.appendChild(g);
    $('#age-yes').focus();
    $('#age-yes').onclick = () => { store.set('ageOk', true); g.remove(); };
    $('#age-no').onclick = () => { window.location.href = 'https://www.google.com'; };
  }

  function storeCards(root) {
    root.innerHTML = config.locations.map((l) => `<div class="feature"><h3>${esc(l.name)}</h3><p>${esc(l.address)}<br>${esc(l.phone)}<br>${esc(l.hours)}</p><button class="btn small" data-store="${esc(l.id)}">Shop this store</button></div>`).join('');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-store]');
      if (b) { setLocationId(b.dataset.store); window.location.href = '/shop'; }
    });
  }

  // ---------- Payment screen (crypto) ----------
  function showPayment(root, d) {
    const p = d.payment;
    root.innerHTML = `<div class="pay">
      <h2>Order ${esc(d.orderId)}: send your payment</h2>
      <p>${d.fulfillment === 'delivery' ? `We will deliver to <strong>${esc(d.deliveryAddress)}</strong> (free delivery) once your payment is confirmed.` : `Pick up at <strong>${esc(d.location)}</strong> once your payment is confirmed.`} Order total: <strong>${money(d.total)}</strong>.</p>
      <div class="pay-box">
        <div class="field"><label>Amount to send (${esc(p.label)})</label>
          <div class="copy-row"><code id="p-amt">${esc(p.amount)}</code><button class="btn small ghost" data-copy="p-amt">Copy</button></div></div>
        <div class="field"><label>To this address (${esc(p.network)} network)</label>
          <div class="copy-row"><code id="p-addr">${esc(p.address)}</code><button class="btn small ghost" data-copy="p-addr">Copy</button></div></div>
        <p class="alert error">Send only on the <strong>${esc(p.network)}</strong> network. Funds sent on a different network cannot be recovered. Send within 30 minutes of placing your order, because the crypto amount is based on the price when you ordered.</p>
      </div>
      <form id="tx-form" novalidate>
        <div class="field"><label for="txid">After sending, paste your transaction ID (hash)</label><input id="txid" autocomplete="off" required></div>
        <div id="tx-msg" role="alert"></div>
        <button class="btn" type="submit">I have sent the payment</button>
      </form>
      <p class="meta">Keep this page's order number (${esc(d.orderId)}). We will confirm your payment and ${d.fulfillment === 'delivery' ? 'send your order out for delivery' : 'have your order ready for pickup'}.</p></div>`;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-copy]');
      if (!b) return;
      navigator.clipboard.writeText($('#' + b.dataset.copy).textContent).then(() => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); });
    });
    $('#tx-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#tx-msg');
      msg.innerHTML = '';
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(d.orderId)}/payment`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txid: $('#txid').value.trim(), token: d.token }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not submit.');
        store.del('pendingPay');
        root.innerHTML = `<div class="alert ok"><h2>Payment submitted</h2><p>Thanks! We are confirming order <strong>${esc(d.orderId)}</strong> on the blockchain. ${d.fulfillment === 'delivery'  `Bring a valid ID to <strong>${esc(d.location)}</strong> for pickup.`}</p></div><a class="btn" href="/shop">Keep shopping</a>`;
      } catch (err) {
        msg.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      }
    });
  }

  // ---------- Pages ----------
  const pages = {
    async home() {
      const products = await getProducts();
      const deals = products.filter(isDeal).slice(0, 4);
      $('#home-deals').innerHTML = deals.map(productCard).join('');
      bindCards($('#home-deals'));
      storeCards($('#home-stores'));
    },

    async shop() {
      const products = await getProducts();
      $('#store-bar').innerHTML = `<strong>Pickup store:</strong> ${locationSelect('store-select', getLocationId())}`;
      $('#store-select').addEventListener('change', (e) => setLocationId(e.target.value));

      const cats = ['all', ...new Set(products.map((p) => p.category))];
      const params = new URLSearchParams(location.search);
      let cat = cats.includes(params.get('category')) ? params.get('category') : 'all';
      $('#chips').innerHTML = cats.map((c) => `<button class="chip" data-cat="${esc(c)}" aria-pressed="${c === cat}">${esc(c)}</button>`).join('');

      const grid = $('#grid');
      function draw() {
        const q = $('#search').value.trim().toLowerCase();
        const sort = $('#sort').value;
        const low = (p) => Math.min(...p.sizes.map((s) => s.price));
        let list = products.filter((p) => (cat === 'all' || p.category === cat) && `${p.name} ${p.brand} ${p.type}`.toLowerCase().includes(q));
        if (sort === 'low') list = [...list].sort((a, b) => low(a) - low(b));
        if (sort === 'high') list = [...list].sort((a, b) => low(b) - low(a));
        grid.innerHTML = list.length ? list.map(productCard).join('') : '<p class="empty">No products match. Try a different search or category.</p>';
      }
      $('#chips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-cat]');
        if (!b) return;
        cat = b.dataset.cat;
        document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.cat === cat)));
        draw();
      });
      $('#search').addEventListener('input', draw);
      $('#sort').addEventListener('change', draw);
      bindCards(grid);
      draw();
    },

    async deals() {
      const products = (await getProducts()).filter(isDeal);
      const grid = $('#grid');
      grid.innerHTML = products.length ? products.map(productCard).join('') : '<p class="empty">No deals right now. Check back soon.</p>';
      bindCards(grid);
    },

    locations() { storeCards($('#loc-list')); },
    about() { $('#contact-info').innerHTML = `${esc(config.phone)}<br><a href="mailto:${esc(config.email)}">${esc(config.email)}</a>`; },

    async cart() {
      await getProducts();
      const root = $('#cart-root');
      function draw() {
        const items = Cart.items().filter((i) => byId.has(i.id) && sizeOf(byId.get(i.id), i.size));
        if (!items.length) {
          root.innerHTML = '<div class="empty"><h2>Your cart is empty</h2><p>Add something from the menu to get started.</p><a class="btn" href="/shop">Browse the menu</a></div>';
          return;
        }
        let subtotal = 0;
        let anyOut = false;
        const rows = items.map((i) => {
          const p = byId.get(i.id);
          const s = sizeOf(p, i.size);
          subtotal += s.price * i.qty;
          if (!p.inStock) anyOut = true;
          return `<div class="line" data-pid="${esc(p.id)}">
            ${thumbHtml(p)}
            <div><strong>${esc(p.name)}</strong><div class="meta">${esc(s.label)}${p.inStock ? '' : ', <strong>out of stock</strong>'}</div>
              <div class="qty" role="group" aria-label="Quantity for ${esc(p.name)}"><button data-dec data-id="${esc(p.id)}" data-size="${esc(s.id)}" aria-label="Decrease">&minus;</button><span>${i.qty}</span><button data-inc data-id="${esc(p.id)}" data-size="${esc(s.id)}" aria-label="Increase">+</button></div><br>
              <button class="link-btn" data-rm data-id="${esc(p.id)}" data-size="${esc(s.id)}">Remove</button></div>
            <div class="price">${money(s.price * i.qty)}</div></div>`;
        }).join('');
        const tax = Math.round(subtotal * (config.taxRate || 0));
        root.innerHTML = `<div class="layout"><div>${rows}</div>
          <aside class="summary"><h2>Order summary</h2>
            <div class="row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
            <div class="row"><span>Estimated tax</span><span>${money(tax)}</span></div>
            <div class="row total"><span>Total</span><span>${money(subtotal + tax)}</span></div>
            <p class="meta">Free delivery or store pickup. Pay with crypto at checkout.</p>
            ${anyOut ? '<p class="alert error">Remove out-of-stock items to continue.</p>' : '<a class="btn" href="/checkout" style="width:100%;text-align:center">Continue to checkout</a>'}</aside></div>`;
      }
      root.addEventListener('click', (e) => {
        const d = e.target.dataset;
        if (!d.id) return;
        const cur = (Cart.items().find((x) => x.id === d.id && x.size === d.size) || { qty: 0 }).qty;
        if ('inc' in d) Cart.setQty(d.id, d.size, cur + 1);
        else if ('dec' in d) Cart.setQty(d.id, d.size, cur - 1);
        else if ('rm' in d) Cart.setQty(d.id, d.size, 0);
        else return;
        draw();
      });
      draw();
    },

    async checkout() {
      const products = await getProducts();
      const root = $('#checkout-root');
      const pending = store.get('pendingPay', null);
      const items = Cart.items().filter((i) => byId.has(i.id) && sizeOf(byId.get(i.id), i.size) && byId.get(i.id).inStock);
      if (!items.length) {
        if (pending) return showPayment(root, pending);
        root.innerHTML = '<div class="empty"><h2>Your cart is empty</h2><a class="btn" href="/shop">Browse the menu</a></div>';
        return;
      }
      const methods = await fetch('/api/payment-methods').then((r) => r.json()).catch(() => []);
      let subtotal = 0;
      const lines = items.map((i) => { const p = byId.get(i.id); const s = sizeOf(p, i.size); subtotal += s.price * i.qty; return `<div class="row"><span>${i.qty} x ${esc(p.name)} (${esc(s.label)})</span><span>${money(s.price * i.qty)}</span></div>`; }).join('');
      const tax = Math.round(subtotal * (config.taxRate || 0));
      const pay = methods.length
        ? methods.map((m, n) => `<label class="radio"><input type="radio" name="coin" value="${esc(m.code)}"${n === 0 ? ' checked' : ''}> ${esc(m.label)}</label>`).join('')
        : '<p class="alert error">Crypto payments are not set up yet. Please check back soon.</p>';
      root.innerHTML = `<div class="layout">
        <form id="order-form" novalidate>
          <fieldset class="field"><legend><strong>How do you want your order?</strong></legend>
            <label class="radio"><input type="radio" name="ful" value="delivery" checked> Delivery (free)</label>
            <label class="radio"><input type="radio" name="ful" value="pickup"> Store pickup</label></fieldset>
          <div class="field"><label for="name">Full name</label><input id="name" autocomplete="name" required></div>
          <div class="field"><label for="phone">Phone</label><input id="phone" type="tel" autocomplete="tel" required></div>
          <div class="field"><label for="email">Email (optional)</label><input id="email" type="email" autocomplete="email"></div>
          <div class="field" id="addr-field"><label for="addr">Delivery address</label><textarea id="addr" rows="3" maxlength="300" autocomplete="street-address" placeholder="Street, apartment, city, ZIP"></textarea></div>
          <div class="field" id="store-field" hidden><label for="locationId">Pickup store</label>${locationSelect('locationId', getLocationId())}</div>
          <div class="field"><label for="note">Notes (gate code, delivery instructions, etc.)</label><textarea id="note" rows="3" maxlength="300"></textarea></div>
          <fieldset class="field"><legend><strong>Pay with</strong></legend>${pay}</fieldset>
          <div class="field check"><input id="age" type="checkbox"><label for="age">I am ${config.minAge} or older and will show a valid government ID at delivery or pickup.</label></div>
          <div id="msg" role="alert"></div>
          <button class="btn" id="submit" type="submit"${methods.length ? '' : ' disabled'}>Place order</button>
        </form>
        <aside class="summary"><h2>Your order</h2>${lines}
          <div class="row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
          <div class="row"><span>Estimated tax</span><span>${money(tax)}</span></div>
          <div class="row" id="del-row"><span>Delivery</span><span>Free</span></div>
          <div class="row total"><span>Total</span><span>${money(subtotal + tax)}</span></div>
          <p class="meta">You will get the exact crypto amount and wallet address on the next step.</p></aside></div>`;

      const fulfillment = () => $('input[name=ful]:checked').value;
      document.querySelectorAll('input[name=ful]').forEach((r) => r.addEventListener('change', () => {
        const del = fulfillment() === 'delivery';
        $('#addr-field').hidden = !del;
        $('#store-field').hidden = del;
        $('#del-row').hidden = !del;
      }));

      $('#order-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = $('#msg');
        const btn = $('#submit');
        msg.innerHTML = '';
        btn.disabled = true;
        btn.textContent = 'Placing order...';
        const coin = ($('input[name=coin]:checked') || {}).value;
        try {
          const res = await fetch('/api/orders', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fulfillment: fulfillment(), deliveryAddress: $('#addr').value, locationId: $('#locationId').value, name: $('#name').value, phone: $('#phone').value, email: $('#email').value,
              pickupNote: $('#note').value, ageConfirmed: $('#age').checked, coin,
              items: items.map((i) => ({ id: i.id, size: i.size, qty: i.qty })),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not place your order.');
          if ($('#locationId').value) setLocationId($('#locationId').value);
          Cart.clear();
          store.set('pendingPay', data);
          showPayment(root, data);
          window.scrollTo(0, 0);
        } catch (err) {
          msg.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
          btn.disabled = false;
          btn.textContent = 'Place order';
        }
      });
    },
  };

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      config = await fetch('/api/config').then((r) => r.json());
    } catch (e) {
      document.body.insertAdjacentHTML('afterbegin', '<p class="alert error">Could not load the site. Please refresh.</p>');
      return;
    }
    renderChrome();
    ageGate();
    const run = pages[document.body.dataset.page];
    if (run) run();
  });
})();
