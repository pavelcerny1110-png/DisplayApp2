// Counter values are live state, never order history. Receipts live as long as
// the counter generation, so an offline retry cannot apply a step twice.
export const COUNTER_MAX = Number.MAX_SAFE_INTEGER;
export const counterActions = new Set(['counter_delta', 'counter_set', 'counter_delete']);
export const counterData = item => typeof item.data_json === 'string' ? JSON.parse(item.data_json || '{}') : (item.data_json || {});
export const counterParent = item => {
  const d = counterData(item);
  return String(d.parent_order_id || d.parentOrderId || d.pinned_to_order_id || d.pinnedToOrderId || d.attached_to_order_id || d.attachedToOrderId || d.order_id || d.orderId || '');
};
const terminal = status => ['completed', 'served', 'done', 'finished', 'resolved', 'closed', 'hotovo', 'cancelled', 'canceled', 'storno', 'zruseno'].includes(String(status).toLowerCase());
export function counterWritable(item, items) {
  const parent = counterParent(item);
  return !terminal(item.status) && (!parent || items.some(order => order.id === parent && order.type === 'order' && !terminal(order.status)));
}
export function counterInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Počítadlo vyžaduje nezáporné celé číslo nejvýše ' + COUNTER_MAX + '.');
  return value;
}
export function initializeCounter(item, items) {
  const data = counterData(item);
  if (!item.title.trim()) throw new Error('Počítadlo musí mít název.');
  if (!counterWritable(item, items)) throw new Error('Počítadlo lze připnout pouze k čekající objednávce.');
  if (item.expires_at || terminal(item.status)) throw new Error('Počítadlo nemá expiraci ani ruční stav dokončení.');
  item.status = 'active';
  item.data_json = JSON.stringify({ value: counterInteger(data.value ?? 0), counter_generation: crypto.randomUUID(), counter_revision: 0,
    ...(counterParent(item) ? { parent_order_id: counterParent(item) } : {}) });
}
export function mutateCounter(store, items, input, now) {
  const action = input.action;
  const id = String(input.item_id || '');
  const generation = String(input.generation || '');
  const operationId = String(input.operation_id || '');
  if (!id || !generation || generation.length > 200 || !operationId || operationId.length > 200) throw new Error('Počítadlo vyžaduje item_id, generation a stabilní operation_id.');
  const request = { action, item_id: id, generation, operation_id: operationId };
  if (action === 'counter_delta') {
    if (typeof input.delta !== 'number' || !Number.isSafeInteger(input.delta) || input.delta === 0) throw new Error('delta musí být nenulové celé číslo.');
    request.delta = input.delta;
  } else if (action === 'counter_set') {
    request.value = counterInteger(input.value);
    request.expected_counter_revision = counterInteger(input.expected_counter_revision);
  } else if (action !== 'counter_delete') throw new Error('Neznámá akce počítadla.');
  const fingerprint = JSON.stringify(request);
  const prior = store.counterReceipt(generation, operationId);
  if (prior) {
    if (prior.request !== fingerprint) return { ok: false, conflict: true, code: 'operation_reused', message: 'Stejné operation_id už patří jiné změně.' };
    return { ...prior.reply, changed: false, duplicate: true };
  }
  const index = items.findIndex(item => item.id === id && item.type === 'counter' && counterData(item).counter_generation === generation);
  if (index < 0) return { ok: false, conflict: true, code: 'missing', message: 'Počítadlo bylo odstraněno. Neodeslané změny zůstaly v zařízení pro ruční obnovu.' };
  const item = items[index];
  const data = counterData(item);
  let reply;
  if (!counterWritable(item, items)) reply = { ok: false, conflict: true, code: 'locked', message: 'Objednávka už není čekající. Připnuté počítadlo je uzamčené.' };
  else if (action === 'counter_set' && request.expected_counter_revision !== data.counter_revision) reply = {
    ok: false, conflict: true, code: 'stale', message: 'Počítadlo se změnilo na jiném zařízení. Vyberte hodnotu, kterou chcete zachovat.'
  };
  else if (action === 'counter_delete') {
    items.splice(index, 1);
    reply = { ok: true, changed: true, result: { operationId, itemId: id, deleted: true } };
  } else {
    const value = action === 'counter_delta' ? data.value + request.delta : request.value;
    if (!Number.isSafeInteger(value) || value < 0) reply = { ok: false, conflict: true, code: 'range', message: 'Změna by překročila povolený rozsah počítadla. Zkontrolujte neodeslané změny.' };
    else {
      items[index] = { ...item, updated_at: now, data_json: JSON.stringify({ ...data, value, counter_revision: data.counter_revision + 1 }) };
      reply = { ok: true, changed: true, result: { operationId, itemId: id, value, counterRevision: data.counter_revision + 1 } };
    }
  }
  store.rememberCounterReceipt(generation, operationId, { request: fingerprint, reply });
  return reply;
}
