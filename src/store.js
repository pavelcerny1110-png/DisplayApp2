// SQLite-backed Durable Object storage. All mutations run synchronously inside
// storage.transactionSync: no awaiting or in-memory authority across requests.
import { updateOrderArchiveRecord_ } from './engine.js';

const OPERATIONAL_TYPES = new Set(['reminder', 'tip', 'info', 'alert']);
function parseData(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function parentOrderId(item) {
  const data = parseData(item && item.data_json);
  return String(data.parent_order_id || data.parentOrderId || data.pinned_to_order_id || data.pinnedToOrderId ||
    data.attached_to_order_id || data.attachedToOrderId || data.order_id || data.orderId || '').trim();
}

export class KitchenStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    storage.transactionSync(() => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS live_items (id TEXT PRIMARY KEY, item_json TEXT NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS order_archive (order_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, received_at TEXT NOT NULL, record_json TEXT NOT NULL)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS archive_service ON order_archive(service_id, received_at)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS order_events (event_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, occurred_at TEXT NOT NULL, record_json TEXT NOT NULL)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS events_service ON order_events(service_id, occurred_at)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS commands (command_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL, result_json TEXT NOT NULL)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS commands_time ON commands(processed_at)');
      // v18 keeps the last complete snapshot of cards attached to each live order.
      // The snapshot deliberately survives removal from live_items so cancellation
      // and later history reads cannot lose an instruction that was pinned to it.
      this.sql.exec('CREATE TABLE IF NOT EXISTS order_attachment_snapshots (order_id TEXT PRIMARY KEY, cards_json TEXT NOT NULL)');
      this.sql.exec('CREATE TABLE IF NOT EXISTS counter_receipts (generation TEXT NOT NULL, operation_id TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(generation, operation_id))');
      const schema = this.getMeta('schema_version', 0);
      if (schema > 2) throw new Error('Úložiště má novější schéma; downgrade byl bezpečně odmítnut.');
      if (schema < 2) this.setMeta('schema_version', 2);
    });
  }
  atomic(callback) { return this.storage.transactionSync(callback); }
  rows(query, ...bindings) { return Array.from(this.sql.exec(query, ...bindings)); }
  getMeta(key, fallback = null) {
    const rows = this.rows('SELECT value FROM meta WHERE key = ?', key);
    return rows.length ? JSON.parse(rows[0].value) : fallback;
  }
  setMeta(key, value) {
    this.sql.exec('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }
  // A unique, server-authoritative version timestamp also protects changes that
  // happen within the same millisecond. This clock is persistent across eviction.
  nextTimestamp() {
    const next = Math.max(Date.now(), Number(this.getMeta('last_timestamp', 0)) + 1);
    this.setMeta('last_timestamp', next);
    return new Date(next).toISOString();
  }
  items() { return this.rows('SELECT item_json FROM live_items ORDER BY rowid').map(row => JSON.parse(row.item_json)); }
  writeItems(items) {
    const existing = new Map(this.rows('SELECT id,item_json FROM live_items').map(row => [row.id, row.item_json]));
    for (const item of items) {
      const text = JSON.stringify(item);
      if (existing.get(item.id) !== text) {
        this.sql.exec('INSERT INTO live_items(id,item_json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET item_json=excluded.item_json', item.id, text);
      }
      existing.delete(item.id);
    }
    for (const id of existing.keys()) this.sql.exec('DELETE FROM live_items WHERE id = ?', id);
    this.captureAttachmentSnapshots(items);
    // Generation UUIDs are never client supplied. Removed generations cannot be
    // resurrected by retries, even if a new card later reuses the same item ID.
    const generations = new Set(items.filter(i => i.type === 'counter').map(i => parseData(i.data_json).counter_generation));
    for (const row of this.rows('SELECT DISTINCT generation FROM counter_receipts')) {
      if (!generations.has(row.generation)) this.sql.exec('DELETE FROM counter_receipts WHERE generation = ?', row.generation);
    }
  }
  counterReceipt(generation, operationId) {
    const rows = this.rows('SELECT receipt_json FROM counter_receipts WHERE generation = ? AND operation_id = ?', generation, operationId);
    return rows.length ? JSON.parse(rows[0].receipt_json) : null;
  }
  rememberCounterReceipt(generation, operationId, receipt) {
    this.sql.exec('INSERT INTO counter_receipts(generation,operation_id,receipt_json) VALUES (?,?,?)', generation, operationId, JSON.stringify(receipt));
  }
  captureAttachmentSnapshots(items) {
    const source = Array.isArray(items) ? items : [];
    const orders = source.filter(item => String(item && item.type || '').toLowerCase() === 'order');
    for (const order of orders) {
      const orderId = String(order.id || '');
      if (!orderId) continue;
      const cards = source.filter(item => OPERATIONAL_TYPES.has(String(item && item.type || '').toLowerCase()) && parentOrderId(item) === orderId);
      this.sql.exec('INSERT INTO order_attachment_snapshots(order_id,cards_json) VALUES (?,?) ON CONFLICT(order_id) DO UPDATE SET cards_json=excluded.cards_json', orderId, JSON.stringify(cards));
    }
  }
  attachmentSnapshot(orderId) {
    const rows = this.rows('SELECT cards_json FROM order_attachment_snapshots WHERE order_id = ?', String(orderId || ''));
    if (!rows.length) return [];
    try {
      const cards = JSON.parse(rows[0].cards_json);
      return Array.isArray(cards) ? cards : [];
    } catch { return []; }
  }
  audit(mutations) {
    for (const mutation of mutations) {
      for (const update of mutation.archiveUpdates || []) {
        const id = String(update.item.id);
        const prior = this.rows('SELECT record_json FROM order_archive WHERE order_id = ?', id);
        const record = updateOrderArchiveRecord_(prior.length ? JSON.parse(prior[0].record_json) : {}, update);
        // History needs the full pinned-card snapshot, not just the child IDs kept
        // for completion undo. The snapshot is read here at the same atomic write.
        record.attached_cards_json = JSON.stringify(this.attachmentSnapshot(id));
        this.sql.exec('INSERT INTO order_archive(order_id,service_id,received_at,record_json) VALUES (?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET service_id=excluded.service_id,received_at=excluded.received_at,record_json=excluded.record_json', id, record.service_id, record.received_at, JSON.stringify(record));
      }
      for (const event of mutation.events || []) {
        this.sql.exec('INSERT INTO order_events(event_id,service_id,occurred_at,record_json) VALUES (?,?,?,?)', event.event_id, event.service_id, event.occurred_at, JSON.stringify(event));
      }
    }
  }
  readLog(serviceId) {
    return {
      orders: this.rows('SELECT record_json FROM order_archive WHERE service_id = ? ORDER BY received_at, rowid', serviceId).map(row => JSON.parse(row.record_json)),
      events: this.rows('SELECT record_json FROM order_events WHERE service_id = ? ORDER BY occurred_at, rowid', serviceId).map(row => JSON.parse(row.record_json))
    };
  }
  clearLog(serviceId) {
    const suffix = serviceId === undefined ? '' : ' WHERE service_id = ?';
    const args = serviceId === undefined ? [] : [serviceId];
    const orderIds = this.rows('SELECT order_id FROM order_archive' + suffix, ...args).map(row => String(row.order_id || '')).filter(Boolean);
    const clearedArchiveOrders = this.rows('SELECT COUNT(*) AS n FROM order_archive' + suffix, ...args)[0].n;
    const clearedEvents = this.rows('SELECT COUNT(*) AS n FROM order_events' + suffix, ...args)[0].n;
    this.sql.exec('DELETE FROM order_archive' + suffix, ...args);
    this.sql.exec('DELETE FROM order_events' + suffix, ...args);
    for (const orderId of orderIds) this.sql.exec('DELETE FROM order_attachment_snapshots WHERE order_id = ?', orderId);
    return { clearedArchiveOrders, clearedEvents };
  }
  command(id) {
    const rows = this.rows('SELECT result_json FROM commands WHERE command_id = ?', id);
    return rows.length ? JSON.parse(rows[0].result_json) : null;
  }
  rememberCommand(result) {
    this.sql.exec('INSERT INTO commands(command_id,processed_at,result_json) VALUES (?,?,?)', result.commandId, result.processedAt, JSON.stringify(result));
  }
  bumpRevision(at, manual = false) {
    this.setMeta('revision', Number(this.getMeta('revision', 0)) + 1);
    if (manual) {
      this.setMeta('manual_revision', Number(this.getMeta('manual_revision', 0)) + 1);
      this.setMeta('last_manual_event_at', at);
    }
  }
  cleanupCommands() {
    const now = Date.now();
    if (now - Number(this.getMeta('last_command_cleanup', 0)) < 3600000) return;
    this.sql.exec('DELETE FROM commands WHERE processed_at < ?', new Date(now - 86400000).toISOString());
    this.setMeta('last_command_cleanup', now);
  }
}
