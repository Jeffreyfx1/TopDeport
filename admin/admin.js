(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, method, body) => {
    const res = await fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };
  const STATUSES = ['awaiting_payment', 'payment_submitted', 'paid', 'ready', 'completed', 'cancelled'];

  // Tabs
  function tab(which) {
    $('#orders-view').hidden = which !== 'orders';
    $('#products-view').hidden = which !== 'products';
    $('#tab-orders').setAttribute('aria-pressed', which === 'orders');
    $('#tab-products').setAttribute('aria-pressed', which === 'products');
    if (which === 'products') loadProducts();
  }
  $('#tab-orders').onclick = () => tab('orders');
  $('#tab-products').onclick = () => tab('products');

  // Orders
  const rows = $('#rows');
  async function loadOrders() {
    const orders = await api('/admin/api/orders');
    rows.innerHTML = orders.length ? orders.map((o) => `<tr>
      <td><strong>${esc(o.id)}</strong></td>
      <td>${esc(new Date(o.createdAt).toLocaleString())}</td>
      <td>${o.fulfillment === 'delivery' ? '<strong>DELIVERY</strong><br>' + esc(o.deliveryAddress) : esc(o.location.name)}</td>
      <td>${esc(o.customer.name)}<br>${esc(o.customer.phone)}<br>${esc(o.customer.email)}${o.pickupNote ? '<br><em>' + esc(o.pickupNote) + '</em>' : ''}</td>
      <td>${o.items.map((i) => `${i.qty} x ${esc(i.name)} (${esc(i.size)})`).join('<br>')}<br><strong>$${(o.total / 100).toFixed(2)}</strong></td>
      <td>${esc(o.payment.label)}<br>${esc(o.payment.amount)}<br><small style="word-break:break-all">${o.txid ? 'TX: ' + esc(o.txid) : 'No TX yet'}</small></td>
      <td><select data-id="${esc(o.id)}">${STATUSES.map((s) => `<option value="${s}"${s === o.status ? ' selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select></td></tr>`).join('') : '<tr><td colspan="7">No orders yet.</td></tr>';
  }
  rows.addEventListener('change', async (e) => {
    if (e.target.dataset.id) await api('/admin/api/orders/' + encodeURIComponent(e.target.dataset.id), 'PATCH', { status: e.target.value });
  });
  loadOrders();
  setInterval(() => { if (!$('#orders-view').hidden) loadOrders(); }, 30000);

  // Products
  async function loadProducts() {
    const list = await api('/admin/api/products');
    $('#plist').innerHTML = list.map((p) => `<div class="prod" data-id="${esc(p.id)}">
      <div><strong>${esc(p.name)}</strong><div class="meta">${esc(p.category)}</div>
        <label class="radio"><input type="checkbox" class="stock"${p.inStock ? ' checked' : ''}> In stock</label></div>
      <div><input class="img" placeholder="Image URL (https://...)" value="${esc(p.image || '')}">
        ${p.sizes.map((s) => `<div class="sz" data-sid="${esc(s.id)}" data-label="${esc(s.label)}"><span>${esc(s.label)}</span><input class="price" type="number" step="0.01" min="0.01" value="${(s.price / 100).toFixed(2)}" aria-label="Price for ${esc(s.label)}"><input class="was" type="number" step="0.01" min="0" placeholder="Was (sale)" value="${s.compareAt ? (s.compareAt / 100).toFixed(2) : ''}" aria-label="Original price for ${esc(s.label)}"></div>`).join('')}</div>
      <div><button class="btn small save">Save</button><br><button class="link-btn del">Delete</button><div class="meta st"></div></div></div>`).join('');
  }
  $('#plist').addEventListener('change', async (e) => {
    if (!e.target.classList.contains('stock')) return;
    const row = e.target.closest('.prod');
    try { await api('/admin/api/products/' + row.dataset.id, 'PATCH', { inStock: e.target.checked }); $('.st', row).textContent = e.target.checked ? 'Marked in stock' : 'Marked out of stock'; }
    catch (err) { $('.st', row).textContent = err.message; e.target.checked = !e.target.checked; }
  });
  $('#plist').addEventListener('click', async (e) => {
    const row = e.target.closest('.prod');
    if (!row) return;
    const st = $('.st', row);
    try {
      if (e.target.classList.contains('save')) {
        const sizes = [...row.querySelectorAll('.sz')].map((z) => ({
          id: z.dataset.sid, label: z.dataset.label,
          price: Math.round(parseFloat($('.price', z).value) * 100),
          compareAt: Math.round(parseFloat($('.was', z).value || '0') * 100),
        }));
        await api('/admin/api/products/' + row.dataset.id, 'PATCH', { image: $('.img', row).value, sizes });
        st.textContent = 'Saved';
      } else if (e.target.classList.contains('del')) {
        if (!confirm('Delete this product?')) return;
        await api('/admin/api/products/' + row.dataset.id, 'DELETE');
        row.remove();
      }
    } catch (err) { st.textContent = err.message; }
  });
  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#add-msg');
    try {
      const sizes = $('#n-sizes').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [label, price] = l.split('|').map((x) => x.trim());
        return { label, price: Math.round(parseFloat(price) * 100) };
      });
      await api('/admin/api/products', 'POST', {
        name: $('#n-name').value, brand: $('#n-brand').value, category: $('#n-cat').value, type: $('#n-type').value,
        thc: $('#n-thc').value, description: $('#n-desc').value, image: $('#n-img').value, sizes,
      });
      msg.innerHTML = '<div class="alert ok">Product added.</div>';
      e.target.reset();
      loadProducts();
    } catch (err) { msg.innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
  });
})();
