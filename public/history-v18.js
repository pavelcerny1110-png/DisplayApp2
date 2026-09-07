(() => {
  'use strict';

  const VERSION = '18.0';
  const MODE_DISPLAY = 'display';
  const MODE_HISTORY = 'history';
  const HISTORY_POLL_MS = 3000;
  const PRAGUE_ZONE = 'Europe/Prague';
  const clock = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: PRAGUE_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const style = document.createElement('style');
  style.textContent = `
    .display-mode-toggle {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      min-width: 78px;
      padding: 9px 13px;
      border: 1px solid #3b414c;
      border-radius: 12px;
      background: #20242b;
      color: #e8eaed;
      font: inherit;
      font-size: 13px;
      font-weight: 900;
      line-height: 1;
      cursor: pointer;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .display-mode-toggle:active { transform: scale(.97); }
    body.light .display-mode-toggle { background:#fff; border-color:#cfd3da; color:#25272b; }
    #historyContent {
      display: none;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: var(--content-gap);
      align-items: start;
    }
    body.history-mode #content { display:none !important; }
    body.history-mode #historyContent { display:grid; }
    body.history-mode #topVisibilityIndicators,
    body.history-mode #bottomVisibilityIndicators,
    body.history-mode #alertViewportPulse,
    body.history-mode #reminderViewportPulse,
    body.history-mode #orderDetailOverlay,
    body.history-mode #displayActionToast { display:none !important; }
    .history-empty {
      grid-column:1 / -1;
      min-height:65vh;
      display:flex;
      align-items:center;
      justify-content:center;
      text-align:center;
      color:#d9dce1;
      font-size:clamp(28px,5vw,54px);
      font-weight:850;
    }
    body.light .history-empty { color:#25272b; }
    .history-error { color:#ff5d5d; }
    .history-order-wrap { min-width:0; }
    .history-order {
      background:#1b1e24;
      border:3px solid #48c774;
      border-radius:var(--card-radius);
      padding:var(--card-padding);
      overflow:hidden;
      overflow-wrap:anywhere;
    }
    body.light .history-order { background:#fff; }
    .history-order.cancelled { border-color:#ff5d5d; }
    .history-header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    .history-title { min-width:0; font-size:clamp(23px,3.5vw,38px); font-weight:850; line-height:1.12; }
    .history-subtitle { margin-top:7px; color:#aeb3bc; font-size:clamp(15px,2vw,21px); line-height:1.35; }
    body.light .history-subtitle { color:#666b74; }
    .history-badge { flex-shrink:0; padding:8px 13px; border-radius:999px; font-size:12px; font-weight:900; letter-spacing:.04em; }
    .history-badge.completed { background:#195333; color:#aaf0c4; }
    .history-badge.cancelled { background:#5a2929; color:#ffb3b3; }
    .history-lines { margin-top:16px; display:flex; flex-direction:column; gap:6px; font-size:clamp(17px,2.4vw,25px); line-height:1.45; }
    .history-line { white-space:pre-wrap; }
    .history-line.served { text-decoration:line-through; text-decoration-thickness:2px; text-decoration-color:#7fe3a2; opacity:.52; }
    .history-times { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-top:20px; font-size:clamp(25px,4vw,40px); font-weight:900; font-variant-numeric:tabular-nums; letter-spacing:.02em; }
    .history-received { color:#f3bb3f; }
    body.light .history-received { color:#8c6200; }
    .history-terminal.completed { color:#48c774; }
    .history-terminal.cancelled { color:#ff5d5d; }
    .history-arrow { color:#8f949d; font-size:.72em; }
    .history-attached-list {
      margin-top:10px;
      margin-left:clamp(10px,2.2vw,22px);
      padding-left:17px;
      border-left:3px solid rgba(126,164,215,.45);
      display:flex;
      flex-direction:column;
      gap:10px;
    }
    .history-attached {
      background:#1b1e24;
      border:2px solid #57d6c7;
      border-radius:14px;
      padding:clamp(16px,2.2vw,24px);
    }
    body.light .history-attached { background:#fff; }
    .history-attached.tip { border-color:#4d9cff; }
    .history-attached.reminder { border-color:#4d9cff; }
    .history-attached.alert { border-color:#ff4f55; }
    .history-attached-title { font-size:clamp(21px,3vw,33px); font-weight:850; line-height:1.12; }
    .history-attached-subtitle { margin-top:6px; color:#aeb3bc; font-size:clamp(14px,1.8vw,19px); }
    .history-attached-body { margin-top:10px; font-size:clamp(16px,2.15vw,23px); line-height:1.4; white-space:pre-wrap; }
    @media (max-width:620px) {
      .display-mode-toggle { min-width:76px; height:40px; border-radius:10px; padding:0 10px; }
      .history-order-wrap { grid-column:span 12 !important; }
    }
  `;
  document.head.appendChild(style);

  const live = document.getElementById('content');
  const topbarMain = document.querySelector('.topbar-main');
  const title = document.getElementById('screenTitle');
  if (!live || !topbarMain || !title) return;

  const history = document.createElement('main');
  history.id = 'historyContent';
  history.setAttribute('aria-live', 'polite');
  live.insertAdjacentElement('afterend', history);

  const modeButton = document.createElement('button');
  modeButton.type = 'button';
  modeButton.className = 'display-mode-toggle';
  modeButton.id = 'displayModeToggle';
  modeButton.textContent = 'Displej';
  modeButton.title = 'Přepnout režim';
  modeButton.setAttribute('aria-label', 'Aktuální režim Displej. Klepnutím přepnete do Historie.');
  const fullscreen = document.getElementById('fullscreenToggle');
  topbarMain.insertBefore(modeButton, fullscreen || null);

  let mode = MODE_DISPLAY;
  let timer = null;
  let requestToken = 0;
  let savedTitle = '';

  function parseObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(String(value || ''));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  function canonicalType(value) {
    const key = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    if (key === 'informace' || key === 'information') return 'info';
    if (key === 'pripominka') return 'reminder';
    if (key === 'upozorneni' || key === 'warning') return 'alert';
    return key;
  }
  function text(value) { return value === null || value === undefined ? '' : String(value); }
  function time(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? clock.format(date) : '--:--';
  }
  function cleanSubtitle(value) {
    return text(value).replace(/^\s*Přijato\s+v\s+\d{1,2}:\d{2}\s*(?:[·•|—–-]\s*)?/i, '').trim();
  }
  function stripServed(value) {
    return text(value).replace(/\s*[—–-]\s*(vydan[áa]|served|hotov[áa])\s*$/i, '').trim();
  }
  function key(value) {
    return stripServed(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/^\s*\d+\s*[×x]\s*/i, '').replace(/\s+/g, ' ').trim();
  }
  function orderLines(item) {
    const data = parseObject(item.data_json || item.data);
    const structured = Array.isArray(data.order_items) ? data.order_items : [];
    const body = text(item.body).split('\n').map(v => v.trim()).filter(Boolean);
    if (structured.length) return structured.map((raw, index) => {
      const line = parseObject(raw);
      const name = text(line.name);
      const quantity = Math.max(1, Number(line.quantity) || 1);
      const label = body[index] || (quantity > 1 ? `${quantity}× ${name}` : name);
      const status = text(line.status).toLowerCase();
      return { label: stripServed(label), served: status === 'served' || ['completed','done','finished','hotovo'].includes(status) };
    });
    const served = new Set((Array.isArray(data.served_items) ? data.served_items : []).map(value => key(typeof value === 'string' ? value : value && (value.text || value.title || value.name))));
    return body.map(label => ({ label: stripServed(label), served: served.has(key(label)) || stripServed(label) !== label.trim() }));
  }
  function appendText(parent, className, value) {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }
  function attachedCard(card) {
    const kind = canonicalType(card.type);
    const node = document.createElement('div');
    node.className = `history-attached ${kind}`;
    const cardTitle = text(card.title).trim() || ({ info:'Informace', tip:'Tip', reminder:'Připomínka', alert:'Upozornění' }[kind] || 'Informace');
    appendText(node, 'history-attached-title', cardTitle);
    if (text(card.subtitle).trim()) appendText(node, 'history-attached-subtitle', text(card.subtitle).trim());
    if (text(card.body).trim()) appendText(node, 'history-attached-body', text(card.body).trim());
    return node;
  }
  function orderCard(order) {
    const status = order.status === 'cancelled' ? 'cancelled' : 'completed';
    const item = order.item && typeof order.item === 'object' ? order.item : {};
    const wrap = document.createElement('section');
    wrap.className = 'history-order-wrap';
    wrap.style.gridColumn = 'span 6';

    const card = document.createElement('div');
    card.className = `history-order ${status}`;
    const header = document.createElement('div');
    header.className = 'history-header';
    const heading = document.createElement('div');
    heading.style.minWidth = '0';
    appendText(heading, 'history-title', text(item.title).trim() || (order.orderNumber ? `Objednávka ${order.orderNumber}` : 'Objednávka'));
    const subtitle = cleanSubtitle(item.subtitle);
    if (subtitle) appendText(heading, 'history-subtitle', subtitle);
    header.appendChild(heading);
    appendText(header, `history-badge ${status}`, status === 'cancelled' ? 'ZRUŠENO' : 'HOTOVO');
    card.appendChild(header);

    const lines = document.createElement('div');
    lines.className = 'history-lines';
    orderLines(item).forEach(line => appendText(lines, `history-line${line.served ? ' served' : ''}`, line.label));
    card.appendChild(lines);

    const times = document.createElement('div');
    times.className = 'history-times';
    appendText(times, 'history-received', time(order.receivedAt));
    appendText(times, 'history-arrow', '→');
    appendText(times, `history-terminal ${status}`, time(status === 'cancelled' ? order.cancelledAt : order.completedAt));
    card.appendChild(times);
    wrap.appendChild(card);

    const cards = Array.isArray(order.attachedCards) ? order.attachedCards : [];
    if (cards.length) {
      const list = document.createElement('div');
      list.className = 'history-attached-list';
      cards.forEach(value => list.appendChild(attachedCard(value)));
      wrap.appendChild(list);
    }
    return wrap;
  }
  function render(data) {
    history.replaceChildren();
    const orders = data && Array.isArray(data.orders) ? data.orders.filter(order => order.status === 'completed' || order.status === 'cancelled') : [];
    if (!orders.length) {
      appendText(history, 'history-empty', 'Historie je zatím prázdná');
      return;
    }
    orders.forEach(order => history.appendChild(orderCard(order)));
  }
  function renderError() {
    history.replaceChildren();
    appendText(history, 'history-empty history-error', 'Historii se nepodařilo načíst');
  }
  async function refreshHistory() {
    if (mode !== MODE_HISTORY) return;
    const token = ++requestToken;
    try {
      const response = await fetch('/api/history', { cache:'no-store', headers:{ Accept:'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (mode !== MODE_HISTORY || token !== requestToken) return;
      render(data);
    } catch {
      if (mode === MODE_HISTORY && token === requestToken) renderError();
    } finally {
      if (mode === MODE_HISTORY && token === requestToken) {
        clearTimeout(timer);
        timer = setTimeout(refreshHistory, HISTORY_POLL_MS);
      }
    }
  }
  function setMode(next) {
    if (next === mode) return;
    clearTimeout(timer);
    requestToken++;
    mode = next;
    const inHistory = mode === MODE_HISTORY;
    document.body.classList.toggle('history-mode', inHistory);
    modeButton.textContent = inHistory ? 'Historie' : 'Displej';
    modeButton.setAttribute('aria-label', inHistory
      ? 'Aktuální režim Historie. Klepnutím přepnete na Displej.'
      : 'Aktuální režim Displej. Klepnutím přepnete do Historie.');
    if (inHistory) {
      savedTitle = title.textContent || `Display App v${VERSION}`;
      title.textContent = 'Historie dnešní služby';
      refreshHistory();
    } else {
      title.textContent = savedTitle || `Display App v${VERSION}`;
    }
  }

  modeButton.addEventListener('click', () => setMode(mode === MODE_DISPLAY ? MODE_HISTORY : MODE_DISPLAY));

  // The legacy v17.2 HTML shell is intentionally retained for regression parity.
  // The v18 Worker supplies the current backend version; show it immediately on an empty screen.
  if (/Display App v17\.2/.test(title.textContent || '')) title.textContent = `Display App v${VERSION}`;
})();
