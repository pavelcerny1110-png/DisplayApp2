(() => {
  'use strict';
  const C = DisplayCounterCore;
  let state = C.empty(), ready = false, draining = false, timer = null, connectedOnce = !!authoritativeData;
  let dialog = null;
  const broadcast = typeof BroadcastChannel === 'function' ? new BroadcastChannel('displayapp-counters-v19') : null;
  const db = new Promise((resolve, reject) => {
    const request = indexedDB.open('displayapp-counters', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // Each transaction reads the latest state, including changes in another tab.
  // Display acknowledgement is issued only after the durable write completes.
  async function transaction(change) {
    const database = await db;
    const next = await new Promise((resolve, reject) => {
      const tx = database.transaction('state', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('state');
      let value;
      const request = store.get('current');
      request.onsuccess = () => {
        try { value = request.result || C.empty(); if (value.schema !== 1) throw new Error('Neznámá verze offline fronty.'); if (change) { change(value); store.put(value, 'current'); } }
        catch (error) { reject(error); tx.abort(); }
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Změnu se nepodařilo uložit v zařízení.'));
    });
    state = next; ready = true;
    if (change) broadcast?.postMessage('changed');
    redraw();
  }
  function error(error) { showDisplayActionToast(String(error?.message || error)); }
  function redraw() {
    renderCurrentDisplayState();
    const qs = Object.values(state.queues), count = qs.reduce((n, q) => n + q.ops.length, 0), issues = qs.filter(q => q.issue);
    banner.hidden = !count && connectedOnce;
    banner.textContent = issues.length ? `Počítadla: ${issues.length} změn vyžaduje kontrolu — otevřít` : count ? `Počítadla: ${count} změn čeká na odeslání` : 'Offline — poslední uložený stav';
  }
  function blocked(item) {
    return !ready || document.body.classList.contains('history-mode') || isBatteryWarningActive() || manualActionInFlight.has(item.id) || manualActionInFlight.has(C.data(item).parent_order_id) ||
      !C.writable(item, latestData?.items || []) || !!state.queues[C.generation(item)]?.issue;
  }
  async function enqueue(item, action, amount, revision) {
    if (blocked(item)) return;
    try {
      await transaction(s => C.enqueue(s, item.id, action, amount, crypto.randomUUID(), revision));
      if (action === 'counter_delta') clickSound();
      drain();
    } catch (e) { error(e); }
  }
  async function drain() {
    if (draining || !ready || document.hidden) return;
    draining = true; clearTimeout(timer);
    try {
      // A second tab may send the same head. Backend receipts and the atomic
      // head check make both the network write and local removal idempotent.
      while (!document.hidden) {
        await transaction();
        const op = Object.values(state.queues).find(q => !q.issue && q.ops.length)?.ops[0];
        if (!op) break;
        const reply = await displayApiRequest('/api/action', { method: 'POST', body: op, timeoutMs: 30000 });
        if (!reply || typeof reply.ok !== 'boolean' || !Array.isArray(reply.data?.items)) throw new Error('Neplatná odpověď počítadla.');
        await transaction(s => C.acknowledge(s, op, reply));
        handleData(reply.data);
      }
    } catch { /* The exact durable request remains queued, including ambiguous outcomes. */ }
    finally { draining = false; if (Object.values(state.queues).some(q => !q.issue && q.ops.length)) timer = setTimeout(drain, 3000); }
  }
  function clickSound() {
    if (!soundEnabled || !audioUnlocked || !audioContext || audioContext.state !== 'running' || isBatteryWarningActive()) return;
    const tone = audioContext.createOscillator(), gain = audioContext.createGain(), now = audioContext.currentTime;
    tone.type = 'sine'; tone.frequency.value = 700;
    gain.gain.setValueAtTime(.055, now); gain.gain.exponentialRampToValueAtTime(.001, now + .045);
    tone.connect(gain); gain.connect(audioContext.destination); tone.start(now); tone.stop(now + .05);
    tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  }
  function text(tag, label, cls = '') { const node = document.createElement(tag); node.textContent = label; node.className = cls; return node; }
  function button(label, fn) { const node = text('button', label); node.type = 'button'; node.onclick = fn; return node; }
  function closeDialog() { dialog?.remove(); dialog = null; }
  function modal(title) {
    closeDialog(); dialog = document.createElement('dialog'); dialog.className = 'counter-dialog';
    dialog.append(text('h2', title)); document.body.append(dialog); dialog.addEventListener('cancel', closeDialog); dialog.showModal(); return dialog;
  }
  function edit(item) {
    if (blocked(item)) return;
    const d = modal(item.title), initialRevision = C.data(item).counter_revision;
    const label = text('label', 'Hodnota počítadla');
    const input = document.createElement('input'); input.inputMode = 'numeric'; input.type = 'text'; input.value = String(C.data(item).value); input.setAttribute('aria-label', 'Hodnota počítadla');
    label.append(input); d.append(label);
    const validation = text('p', '', 'counter-validation'); d.append(validation);
    const save = () => {
      const value = /^\d+$/.test(input.value.trim()) ? Number(input.value.trim()) : NaN;
      if (!C.integer(value)) { validation.textContent = 'Zadejte celé číslo od 0 do 9007199254740991.'; return; }
      closeDialog(); enqueue(item, 'counter_set', value, initialRevision);
    };
    d.append(button('Zrušit', closeDialog), button('Uložit', save));
    input.onkeydown = e => { if (e.key === 'Enter') save(); }; input.focus(); input.select();
  }
  function remove(item) {
    if (blocked(item)) return;
    const d = modal('Odstranit počítadlo?'); d.append(text('p', `${item.title}: ${C.data(item).value}`));
    d.append(button('Zrušit', closeDialog), button('Odstranit', () => { closeDialog(); enqueue(item, 'counter_delete'); }));
  }
  function resolve(gen) {
    const q = state.queues[gen]; if (!q?.issue) return;
    const current = state.snapshot?.items.find(i => C.generation(i) === gen);
    const d = modal(q.anchor.title);
    d.append(text('p', q.issue.message), text('p', `Místní hodnota: ${C.value(q)} · Nevyřízené změny: ${q.ops.length}`));
    if (current) d.append(text('p', `Hodnota na serveru: ${C.data(current).value}`));
    const choose = async keep => { try { await transaction(s => C.resolve(s, gen, keep, crypto.randomUUID())); closeDialog(); drain(); } catch (e) { error(e); } };
    d.append(button('Zavřít', closeDialog), button(current ? 'Ponechat server' : 'Vzít na vědomí', () => choose(false)));
    if (C.writable(current, state.snapshot?.items || [])) d.append(button('Použít místní hodnotu', () => choose(true)));
  }
  function gestures(card, item) {
    let start = null, hold = null;
    const reset = () => { clearTimeout(hold); start = null; card.style.transform = ''; };
    card.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || blocked(item) || e.button !== 0 || !e.isPrimary) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, held: false };
      card.setPointerCapture(e.pointerId);
      hold = setTimeout(() => { if (start && !start.moved) { start.held = true; edit(item); } }, 620);
    });
    card.addEventListener('pointermove', e => {
      if (!start || start.id !== e.pointerId) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 11) { start.moved = true; clearTimeout(hold); }
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 14) { reset(); return; }
      if (start.moved && !start.held) card.style.transform = `translateX(${dx * .7}px)`;
    });
    card.addEventListener('pointerup', e => {
      const finished = start;
      const swipe = finished && !finished.held && Math.abs(e.clientX - finished.x) >= Math.max(92, card.offsetWidth * .28);
      reset(); if (swipe) remove(item);
    });
    card.addEventListener('pointercancel', reset);
    card.addEventListener('lostpointercapture', reset);
    card.addEventListener('contextmenu', e => e.preventDefault());
    card.tabIndex = 0; card.setAttribute('aria-label', `${item.title}. Podržením nebo Enter upravíte hodnotu, Delete odstraní kartu.`);
    card.onkeydown = e => { if (e.target !== card) return; if (e.key === 'Enter') { e.preventDefault(); edit(item); } else if (e.key === 'Delete') { e.preventDefault(); remove(item); } };
  }
  function card(item, options = {}) {
    const node = document.createElement('article'); node.className = 'card counter-card'; node.dataset.itemId = item.id;
    const locked = blocked(item), q = state.queues[C.generation(item)], value = C.data(item).value;
    node.append(text('div', 'Počítadlo', 'counter-label'), text('h2', item.title, 'counter-title'));
    const row = text('div', '', 'counter-controls');
    const minus = button('−', () => enqueue(item, 'counter_delta', -1)), plus = button('+', () => enqueue(item, 'counter_delta', 1));
    minus.setAttribute('aria-label', 'Odečíst 1'); plus.setAttribute('aria-label', 'Přičíst 1');
    minus.disabled = locked || value === 0; plus.disabled = locked || value >= Number.MAX_SAFE_INTEGER;
    const number = text('output', String(value), 'counter-value'); number.setAttribute('aria-live', 'polite');
    row.append(minus, number, plus); node.append(row);
    if (item.body || item.subtitle) node.append(text('p', [item.subtitle, item.body].filter(Boolean).join('\n'), 'counter-description'));
    if (q?.issue) node.append(button('Vyřešit neodeslané změny', () => resolve(C.generation(item))));
    else if (q?.ops.length) node.append(text('div', `Čeká na odeslání: ${q.ops.length}`, 'counter-pending'));
    else if (options.displayStatus === 'completed' || !C.writable(item, latestData?.items || [])) node.append(text('div', 'Uzamčeno s objednávkou', 'counter-pending'));
    gestures(node, item); return node;
  }
  const style = document.createElement('style'); style.textContent = `
    .counter-card { border:3px solid #b18aff; background:linear-gradient(140deg,#b18aff18,var(--card-bg,#1b1e24)); touch-action:pan-y; user-select:none; }
    body.light .counter-card { border-color:#7144b8; background:#faf7ff; }
    .counter-label,.counter-pending { color:#bda0f3; font-size:14px; font-weight:700; }
    body.light .counter-label,body.light .counter-pending { color:#7144b8; }
    .counter-title { margin:8px 0 18px; font-size:clamp(23px,3.5vw,38px); overflow-wrap:anywhere; }
    .counter-controls { display:flex; align-items:center; gap:12px; }
    .counter-controls button { flex:0 0 56px; height:56px; font-size:34px; padding:0; }
    .counter-value { flex:1; min-width:0; text-align:center; font-size:clamp(32px,6vw,72px); font-weight:900; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
    .counter-card button,.counter-dialog button { border:1px solid #b18aff; border-radius:12px; color:inherit; background:#b18aff20; cursor:pointer; min-height:48px; padding:10px 16px; font:inherit; }
    .counter-card button:disabled { opacity:.3; cursor:default; }
    .counter-controls button { font-size:34px; }
    .counter-description { white-space:pre-wrap; font-size:clamp(16px,2vw,23px); }
    .counter-pending { margin-top:10px; }
    #counterQueueBanner { width:100%; margin:0 0 12px; padding:12px; background:#30243f; color:#e5d6ff; border:1px solid #b18aff; border-radius:10px; cursor:pointer; font:inherit; }
    #counterQueueBanner[hidden],body.history-mode #counterQueueBanner { display:none; }
    .counter-dialog { background:#1b1e24; color:#f5f5f5; border:2px solid #b18aff; border-radius:18px; max-width:min(480px,90vw); padding:24px; }
    .counter-dialog::backdrop { background:#0009; }
    body.light .counter-dialog { background:#fff; color:#18191c; }
    .counter-dialog button { margin:8px 8px 0 0; }
    .counter-dialog input { display:block; box-sizing:border-box; width:100%; margin-top:10px; padding:12px; border:1px solid #b18aff; border-radius:10px; background:transparent; color:inherit; font:inherit; font-size:28px; }
    .counter-validation { color:#ff8a8a; }
  `; document.head.append(style);
  const banner = button('', () => { const entry = Object.entries(state.queues).find(([,q]) => q.issue); if (entry) resolve(entry[0]); });
  banner.id = 'counterQueueBanner'; banner.hidden = true; document.getElementById('content').before(banner);
  window.counterDisplay = {
    card, project: items => C.project(state, items), cached: () => !connectedOnce,
    signature: () => [ready, Object.entries(state.queues).map(([gen,q]) => [gen,q.ops.length,q.issue])],
    accept(snapshot) { connectedOnce = true; transaction(s => C.accept(s, snapshot)).then(drain).catch(error); }
  };
  broadcast && (broadcast.onmessage = () => transaction().then(drain).catch(error));
  window.addEventListener('online', drain);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) drain(); });
  new MutationObserver(() => { if (document.body.classList.contains('history-mode') || isBatteryWarningActive()) closeDialog(); }).observe(document.body, { attributes:true, attributeFilter:['class'] });
  transaction().then(async () => {
    if (authoritativeData) await transaction(s => C.accept(s, authoritativeData));
    else if (state.snapshot) { authoritativeData = cloneDisplayValue(state.snapshot); setConnectionErrorState(true); redraw(); }
    drain();
  }).catch(error);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/counter-shell-v19.js').catch(() => {});
})();
