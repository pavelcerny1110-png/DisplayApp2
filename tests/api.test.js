import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestKitchen } from './sqlite.js';
import { KitchenStore } from '../src/store.js';
import { KitchenApi } from '../src/api.js';
import { handleApi } from '../src/http.js';
import * as E from '../src/engine.js';
const order = (id = 'order-1', data = {}) => ({ id, type: 'order', title: '#1 stůl T5', body: 'Kuřecí řízek – 160 Kč\nHranolky – 55 Kč', data });
const command = (action, payload = {}, target) => ({ command_id: crypto.randomUUID(), action, payload, target });
const add = (api, item = order()) => api.commands(command('upsert_item', { item }));
const current = (api, id = 'order-1') => api.snapshot().items.find(item => item.id === id);
const manual = (api, action, id = 'order-1', extra = {}) => {
  const item = current(api, id);
  return api.action({ action, item_id: id, expected_updated_at: item.updated_at, expected_status: item.status, ...extra });
};

test('empty schema and defaults, GET polling does not write', () => {
  const { api, store, db } = createTestKitchen();
  const before = db.prepare('SELECT total_changes() n').get().n;
  for (let i = 0; i < 10; i++) {
    const snap = api.snapshot();
    assert.equal(snap.version, '17.2'); assert.equal(snap.settings.poll_seconds, 3);
    assert.equal(snap.syncState.manualRevision, 0); assert.deepEqual(snap.items, []);
  }
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(store.getMeta('schema_version'), 1);
});
test('order receipt and service date are server authoritative', () => {
  const { api } = createTestKitchen();
  const before = Date.now();
  assert.equal(add(api, { ...order(), created_at: '1900-01-01', subtitle: 'Přijato v 09:00 · stůl T5', data: { received_at: '1900-01-01', service_id: '1900-01-01' } }).ok, true);
  const item = current(api), data = JSON.parse(item.data_json);
  assert.ok(Date.parse(item.created_at) >= before); assert.equal(data.received_at, item.created_at);
  assert.equal(data.service_id, E.getPragueServiceId_(new Date(item.created_at)));
  assert.match(item.subtitle, /^Přijato v \d\d:\d\d · stůl T5$/);
  const log = api.log(data.service_id);
  assert.equal(log.orders[0].received_at, item.created_at); assert.equal(log.orders[0].total_price, '215');
  assert.equal(log.orders[0].customer_or_table, 'stůl T5'); assert.equal(log.events[0].event_type, 'created');
});
test('deduplication survives new object instances and produces no extra archive events', () => {
  const { api, storage } = createTestKitchen();
  const cmd = command('upsert_item', { item: order() });
  api.commands(cmd);
  const resumed = new KitchenApi(new KitchenStore(storage));
  const response = resumed.commands(cmd);
  assert.equal(response.ok, true); assert.equal(response.commandReport.processed, 0);
  assert.equal(response.results[0].status, 'duplicate'); assert.equal(resumed.log().orders.length, 1);
  assert.equal(resumed.log().events.length, 1);
});
test('failed upsert_items is all-or-nothing', () => {
  const { api } = createTestKitchen();
  const response = api.commands(command('upsert_items', { items: [order(), { id: 'bad' }] }));
  assert.equal(response.ok, false); assert.equal(api.snapshot().items.length, 0); assert.equal(api.log().orders.length, 0);
});
test('partial serving then completion and undo restore exact partial state and attached cards', () => {
  const { api } = createTestKitchen();
  add(api);
  add(api, { id: 'info-1', type: 'info', body: 'Bez soli', data: { parent_order_id: 'order-1' } });
  const partial = manual(api, 'set_order_item_states', 'order-1', { served_items: ['Kuřecí řízek – 160 Kč'] });
  assert.equal(partial.ok, true);
  const before = JSON.parse(current(api).data_json);
  assert.equal(manual(api, 'toggle_order_completion').ok, true);
  assert.equal(current(api).status, 'served'); assert.equal(current(api, 'info-1').status, 'completed');
  assert.equal(manual(api, 'toggle_order_completion').ok, true);
  assert.deepEqual(JSON.parse(current(api).data_json), before);
  assert.equal(current(api, 'info-1').status, 'active');
  assert.equal(api.snapshot().syncState.manualRevision, 3);
  const types = api.log().events.map(event => event.event_type);
  for (const type of ['created', 'item_served', 'completed', 'reopened', 'item_reopened']) assert.ok(types.includes(type));
  assert.ok(api.log().orders[0].first_completed_at); assert.ok(api.log().events.some(event => event.source === 'display'));
});
test('manual completion last item can undo to pre-change selection', () => {
  const { api } = createTestKitchen(); add(api);
  const before = JSON.parse(current(api).data_json);
  manual(api, 'set_order_item_states', 'order-1', { served_items: ['Kuřecí řízek – 160 Kč', 'Hranolky – 55 Kč'] });
  assert.equal(current(api).status, 'served'); manual(api, 'toggle_order_completion');
  assert.deepEqual(JSON.parse(current(api).data_json), before);
});
test('stale manual action returns a current snapshot without toggling twice', () => {
  const { api } = createTestKitchen(); add(api);
  const original = current(api);
  const request = { action: 'toggle_order_completion', item_id: original.id, expected_updated_at: original.updated_at, expected_status: original.status };
  assert.equal(api.action(request).ok, true);
  const response = api.action(request);
  assert.equal(response.ok, false); assert.equal(response.conflict, true); assert.equal(current(api).status, 'served');
  assert.equal(response.data.items[0].status, 'served'); assert.equal(api.snapshot().syncState.manualRevision, 1);
});
test('waiting-order swipe cancels, hides children and preserves archive/events', () => {
  const { api } = createTestKitchen(); add(api); add(api, { id: 'tip-1', type: 'tip', data: { parent_order_id: 'order-1' } });
  assert.equal(manual(api, 'swipe_item').ok, true); assert.equal(api.snapshot().items.length, 0);
  const log = api.log(); assert.equal(log.orders[0].status, 'cancelled'); assert.ok(log.orders[0].hidden_from_display_at);
  assert.deepEqual(log.events.map(event => event.event_type), ['created', 'cancelled', 'removed_from_display']);
});
test('served-order swipe hides without changing historical completion', () => {
  const { api } = createTestKitchen(); add(api); manual(api, 'toggle_order_completion');
  const completed = api.log().orders[0].last_completed_at;
  manual(api, 'swipe_item'); assert.equal(api.log().orders[0].status, 'completed');
  assert.equal(api.log().orders[0].last_completed_at, completed);
  assert.equal(api.log().events.filter(event => event.event_type === 'cancelled').length, 0);
});
test('reminder completion and alert swipe work without order archive records', () => {
  const { api } = createTestKitchen();
  add(api, { id: 'reminder-1', type: 'reminder', data: { remind_at: new Date().toISOString() } });
  assert.equal(manual(api, 'complete_reminder', 'reminder-1').ok, true);
  assert.equal(current(api, 'reminder-1').status, 'completed');
  add(api, { id: 'alert-1', type: 'alert', body: 'Pozor' });
  assert.equal(manual(api, 'swipe_item', 'alert-1').ok, true); assert.equal(current(api, 'alert-1'), undefined);
  assert.equal(api.log().orders.length, 0);
});
test('clear_display preserves logs; clear_display_and_current_service_log clears both', () => {
  const { api } = createTestKitchen(); add(api);
  api.commands(command('clear_display')); assert.equal(api.snapshot().items.length, 0); assert.equal(api.log().orders.length, 1);
  add(api, order('order-2'));
  api.commands(command('clear_display_and_current_service_log'));
  assert.equal(api.snapshot().items.length, 0); assert.equal(api.log().orders.length, 0); assert.equal(api.log().events.length, 0);
});
test('clear_current_service_log does not touch live cards and requires no archive migration', () => {
  const { api } = createTestKitchen(); add(api);
  const response = api.commands(command('clear_current_service_log'));
  assert.equal(response.ok, true); assert.equal(api.snapshot().items.length, 1); assert.equal(api.log().orders.length, 0);
});
test('clear_all_order_logs requires explicit confirmation', () => {
  const { api } = createTestKitchen(); add(api);
  assert.equal(api.commands(command('clear_all_order_logs')).ok, false); assert.equal(api.log().orders.length, 1);
  assert.equal(api.commands(command('clear_all_order_logs', { confirm: true })).ok, true); assert.equal(api.log().orders.length, 0);
});
test('barrier supersedes old pending batch entries, not later commands', () => {
  const { api } = createTestKitchen();
  const old = command('upsert_item', { item: order('old') });
  const batch = [old, command('clear_display'), command('upsert_item', { item: order('new') })];
  const response = api.commands({ commands: batch });
  assert.deepEqual(response.results.map(r => r.status), ['superseded', 'processed', 'processed']);
  assert.deepEqual(api.snapshot().items.map(i => i.id), ['new']);
  api.commands(old); assert.deepEqual(api.snapshot().items.map(i => i.id), ['new']);
});
test('retrying duplicate clear never supersedes unrelated new commands', () => {
  const { api } = createTestKitchen(); const clear = command('clear_display'); api.commands(clear);
  api.commands({ commands: [command('upsert_item', { item: order() }), clear] });
  assert.equal(api.snapshot().items.length, 1);
});
test('duplicate rejected command does not claim success', () => {
  const { api } = createTestKitchen(); const bad = command('nonexistent');
  assert.equal(api.commands(bad).ok, false); const response = api.commands(bad);
  assert.equal(response.ok, false); assert.equal(response.results[0].originalStatus, 'error');
});
test('batch contains individual results and continues after a rejected command', () => {
  const { api } = createTestKitchen();
  const response = api.commands({ commands: [command('upsert_item', { item: order() }), command('cancel_order', {}, 'missing'), command('complete_order', {}, 'order-1')] });
  assert.equal(response.ok, false); assert.equal(response.commandReport.processed, 2); assert.equal(current(api).status, 'served');
});
test('channels and expires_at preserve filtering without deleting archive', () => {
  const { api } = createTestKitchen();
  add(api, { ...order('past'), expires_at: '2020-01-01T00:00:00Z' });
  add(api, { ...order('other'), channel: 'other' });
  add(api, order('visible'));
  assert.deepEqual(api.snapshot().items.map(item => item.id), ['visible']);
  api.commands(command('clear_channel', { channel: 'other' }));
  assert.equal(api.log().orders.length, 3);
});
test('all non-operational card types retain their JSON unchanged', () => {
  const { api } = createTestKitchen();
  for (const type of ['message','media','table','gallery','checklist']) add(api, { id: type, type, data: { body: [1,2,3] } });
  assert.equal(api.snapshot().items.length, 5);
  assert.deepEqual(JSON.parse(current(api, 'gallery').data_json), { body: [1,2,3] });
});
test('pin, unpin, patch, aliases and exact targeting', () => {
  const { api } = createTestKitchen(); add(api);
  add(api, { id: 'tip-1', type: 'tip', body: 'Tip' });
  assert.equal(api.commands(command('pin_card', { parent_order_id: 'order-1' }, 'tip-1')).ok, true);
  assert.equal(JSON.parse(current(api, 'tip-1').data_json).parent_order_id, 'order-1');
  assert.equal(api.commands(command('unpin_card', {}, 'tip-1')).ok, true);
  assert.equal(JSON.parse(current(api, 'tip-1').data_json).parent_order_id, undefined);
  assert.equal(api.commands(command('update_item', { patch: { body: 'Změna' } }, 'tip-1')).ok, true);
  assert.equal(current(api, 'tip-1').body, 'Změna');
  assert.equal(api.commands(command('finish_order', {}, 'order-1')).ok, true);
  assert.equal(api.commands(command('undo_order', {}, 'order-1')).ok, true);
});
test('all command IDs omitted are generated and returned', () => {
  const { api } = createTestKitchen(); const result = api.commands({ action:'upsert_item', payload: { item:order() } });
  assert.match(result.results[0].commandId, /^cmd-/); assert.equal(result.ok, true);
});
test('Prague dates, summer/winter and midnight boundaries match calendar-day meaning', () => {
  for (const [input, expected] of [
    ['2026-09-05T22:15:00Z','2026-09-06'], ['2026-01-05T23:15:00Z','2026-01-06'],
    ['2026-03-29T00:59:00Z','2026-03-29'], ['2026-10-25T01:30:00Z','2026-10-25']
  ]) assert.equal(E.getPragueServiceId_(new Date(input)), expected);
  assert.equal(E.normalizeServiceId_('2026-09-05'), '2026-09-05');
});
test('HTTP endpoints, no-store, CORS, invalid JSON, limits and method rejection', async () => {
  const { api } = createTestKitchen();
  const request = (path, method = 'GET', body, headers = {}) => new Request('https://test.invalid'+path, { method, headers, body });
  let res = await handleApi(request('/api/display'), api); assert.equal(res.status, 200); assert.match(res.headers.get('cache-control'), /no-store/);
  res = await handleApi(request('/api/display', 'OPTIONS'), api); assert.equal(res.status, 204); assert.equal(res.headers.get('access-control-allow-origin'), '*');
  res = await handleApi(request('/api/command'), api); assert.equal(res.status, 405);
  res = await handleApi(request('/api/command','POST','{'), api); assert.equal(res.status, 415);
  res = await handleApi(request('/api/command','POST','{', { 'Content-Type':'application/json' }),api); assert.equal(res.status,400);
  res = await handleApi(request('/api/command','POST','{}', { 'Content-Type':'application/json','Content-Length':'99999999' }),api); assert.equal(res.status,413);
  res = await handleApi(request('/api/action','POST',JSON.stringify({ action:'swipe_item',item_id:'missing' }), { 'Content-Type':'application/json' }),api); assert.equal(res.status,409);
  res = await handleApi(request('/api/not-found'),api); assert.equal(res.status,404);
  res = await handleApi(request('/api/health'),api); assert.equal((await res.json()).version,'17.2');
});
test('100 rapid updates receive distinct expected_updated_at tokens', () => {
  const { api } = createTestKitchen(); add(api); const times = new Set([current(api).updated_at]);
  for (let i = 0; i < 100; i++) { api.commands(command('patch_item', { patch: { title: '#1 '+i } }, 'order-1')); times.add(current(api).updated_at); }
  assert.equal(times.size, 101);
});
test('archive/current-state/receipt writes roll back together on storage failure', () => {
  const { api, store } = createTestKitchen();
  const audit = store.audit.bind(store);
  store.audit = mutations => { audit(mutations); throw new Error('Simulated disk failure after audit'); };
  const response = add(api);
  assert.equal(response.ok, false); assert.equal(api.snapshot().items.length, 0); assert.equal(api.log().orders.length, 0); assert.equal(api.log().events.length, 0);
});

test('server assigns operational series numbers and preserves reopened historical numbers', () => {
  const { api } = createTestKitchen();
  const create = id => api.commands(command('upsert_item', { item: {
    id, type: 'order', title: 'client title ignored',
    data: {
      order_number: 99,
      recipient: { type: 'person', value: id.toUpperCase() },
      order_items: [{ name: 'Jídlo', quantity: 1, pricing_status: 'known', unit_price: 100 }]
    }
  }}));
  const numberOf = id => JSON.parse(current(api, id).data_json).order_number;

  assert.equal(create('a').results[0].result.orderNumber, 1);
  assert.equal(create('b').results[0].result.orderNumber, 2);
  assert.equal(current(api, 'a').title, 'Objednávka 1 - A');
  api.commands(command('complete_order', {}, 'a'));
  assert.equal(create('c').results[0].result.orderNumber, 3);
  api.commands(command('complete_order', {}, 'b'));
  api.commands(command('complete_order', {}, 'c'));
  assert.equal(create('d').results[0].result.orderNumber, 1);

  // Reopening an older order keeps its historical number even when that creates
  // two waiting #1 cards; stable IDs remain authoritative for later mutations.
  api.commands(command('reopen_order', {}, 'a'));
  assert.equal(numberOf('a'), 1);
  assert.equal(numberOf('d'), 1);
  assert.equal(create('e').results[0].result.orderNumber, 2);
});

test('expected_revision rejects stale new writes before the batch and permits duplicate-only retry', () => {
  const { api } = createTestKitchen();
  const first = { ...command('upsert_item', { item: order('one') }), expected_revision: 0 };
  const accepted = api.commands(first);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.syncState.revision, 1);

  const stale = { command_id: 'stale-new', action: 'upsert_item', payload: { item: order('two') }, expected_revision: 0 };
  const conflict = api.commands(stale);
  assert.equal(conflict.ok, false); assert.equal(conflict.conflict, true);
  assert.equal(conflict.currentRevision, 1); assert.equal(conflict.data.syncState.revision, 1);
  assert.equal(current(api, 'two'), undefined);

  // The rejected command_id was never accepted, so it can be rebuilt against
  // the returned revision and then processed normally.
  stale.expected_revision = 1;
  assert.equal(api.commands(stale).results[0].status, 'processed');
  assert.equal(api.snapshot().syncState.revision, 2);

  // Safe network retry of an already processed ID returns duplicate even though
  // its original expected revision is now stale.
  const duplicateRetry = api.commands({ ...stale, expected_revision: 1 });
  assert.equal(duplicateRetry.ok, true);
  assert.equal(duplicateRetry.results[0].status, 'duplicate');

  const before = api.snapshot().items.length;
  const batchConflict = api.commands({
    expected_revision: 0,
    commands: [command('upsert_item', { item: order('three') }), command('upsert_item', { item: order('four') })]
  });
  assert.equal(batchConflict.conflict, true);
  assert.equal(api.snapshot().items.length, before);
});

test('structured order items keep quantity, pricing semantics and order-level override', () => {
  const { api } = createTestKitchen();
  const response = api.commands(command('upsert_item', { item: {
    id: 'structured', type: 'order',
    data: {
      recipient: { type: 'table', value: 'T5' },
      fulfillment: { type: 'box' },
      order_items: [
        { name: 'Kuřecí směs', quantity: 2, pricing_status: 'known', price_basis: 'unit', unit_price: 155 },
        { name: 'Medailonky', quantity: 2, pricing_status: 'known', price_basis: 'total', total_price: 300 },
        { name: 'Kečup', quantity: 1, pricing_status: 'free' },
        { name: 'Speciál', quantity: 1, pricing_status: 'unknown' }
      ]
    }
  }}));
  assert.equal(response.ok, true);
  const item = current(api, 'structured');
  const data = JSON.parse(item.data_json);
  assert.equal(item.title, 'Objednávka 1 - stůl T5');
  assert.match(item.subtitle, /^Přijato v \d\d:\d\d · stůl T5 · do boxu$/);
  assert.equal(data.order_items[0].total_price, 310);
  assert.equal(data.order_items[1].total_price, 300); // explicit total is not multiplied by quantity
  assert.equal(data.order_items[2].total_price, 0);
  assert.equal(data.order_items[3].total_price, null);
  assert.equal(new Set(data.order_items.map(value => value.id)).size, 4);
  assert.deepEqual(data.pricing, { status: 'unknown', total_price: null, known_subtotal: 610, source: 'calculated' });
  assert.match(item.body, /2× Kuřecí směs – 310 Kč/);
  assert.match(item.body, /2× Medailonky – 300 Kč/);
  assert.match(item.body, /Speciál – cena neznámá/);

  let log = api.log();
  assert.equal(log.orders[0].pricing_status, 'unknown');
  assert.equal(log.orders[0].known_subtotal, '610');
  assert.equal(log.orders[0].total_price, '');
  assert.equal(log.orders[0].recipient_type, 'table');
  assert.equal(log.orders[0].recipient_value, 'T5');
  assert.equal(log.orders[0].fulfillment_type, 'box');

  api.commands(command('patch_item', { data_json_patch: { pricing_override: { status: 'known', total_price: 590 } } }, 'structured'));
  const overridden = JSON.parse(current(api, 'structured').data_json);
  assert.deepEqual(overridden.pricing, { status: 'known', total_price: 590, known_subtotal: 590, source: 'override' });
  log = api.log();
  assert.equal(log.orders[0].total_price, '590');
});

test('structured partial serving updates stable item state and price edits preserve that state', () => {
  const { api } = createTestKitchen();
  api.commands(command('upsert_item', { item: {
    id: 'partial-structured', type: 'order',
    data: { order_items: [
      { name: 'Vývar', quantity: 3, pricing_status: 'known', price_basis: 'unit', unit_price: 50 },
      { name: 'Řízek', quantity: 1, pricing_status: 'known', unit_price: 160 }
    ] }
  }}));
  let item = current(api, 'partial-structured');
  let data = JSON.parse(item.data_json);
  const firstId = data.order_items[0].id;
  assert.equal(manual(api, 'set_order_item_states', 'partial-structured', { served_items: [data.pending_items[0]] }).ok, true);
  item = current(api, 'partial-structured'); data = JSON.parse(item.data_json);
  assert.equal(data.order_items.find(value => value.id === firstId).status, 'served');
  assert.equal(item.status, 'waiting');
  assert.deepEqual(api.log().events.map(value => value.event_type), ['created', 'item_served']);

  const changedItems = structuredClone(data.order_items);
  changedItems[0].unit_price = 55;
  changedItems[0].total_price = 165;
  assert.equal(api.commands(command('patch_item', { data_json_patch: { order_items: changedItems } }, 'partial-structured')).ok, true);
  item = current(api, 'partial-structured'); data = JSON.parse(item.data_json);
  assert.equal(data.order_items[0].id, firstId);
  assert.equal(data.order_items[0].status, 'served');
  assert.equal(data.order_items[0].total_price, 165);
  assert.deepEqual(data.served_items, ['Vývar – 165 Kč']);
  assert.match(item.body, /3× Vývar – 165 Kč/);
  assert.equal(api.log().events.at(-1).event_type, 'edited');
});

test('stale expected_revision is HTTP 409 with the current snapshot', async () => {
  const { api } = createTestKitchen();
  api.commands({ ...command('upsert_item', { item: order('existing') }), expected_revision: 0 });
  const request = new Request('https://test.invalid/api/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...command('upsert_item', { item: order('stale-http') }), expected_revision: 0 })
  });
  const response = await handleApi(request, api);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.conflict, true); assert.equal(body.data.syncState.revision, 1);
});
