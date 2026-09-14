import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestKitchen } from './sqlite.js';
import { KitchenStore } from '../src/store.js';
import { KitchenApi } from '../src/api.js';
import { handleApi } from '../src/http.js';
const cmd = (api, action, payload = {}, target) => api.commands({ action, payload, target, command_id: crypto.randomUUID() });
const add = (api, item) => cmd(api, 'upsert_item', { item });
const item = (api, id = 'c') => api.snapshot().items.find(i => i.id === id);
const data = (api, id = 'c') => JSON.parse(item(api, id).data_json);
function setup(value = 0, parent = '') {
  const kitchen = createTestKitchen();
  if (parent) add(kitchen.api, { id: parent, type: 'order', body: 'Palačinka' });
  assert.equal(add(kitchen.api, { id: 'c', type: 'counter', title: 'Palačinky', body: 'Dnešní příprava', data: { value, parent_order_id: parent } }).ok, true);
  return kitchen;
}
const op = (api, action = 'counter_delta', extra = {}) => ({ action, item_id: 'c', generation: data(api).counter_generation, operation_id: crypto.randomUUID(), delta: 1, ...extra });
test('independent integer counters default to zero and do not create order logs', () => {
  const { api } = setup();
  assert.equal(data(api).value, 0);
  add(api, { id: 'b', type: 'counter', title: 'Vejce', data: { value: 8 } });
  assert.equal(api.action(op(api)).ok, true);
  assert.equal(data(api).value, 1); assert.equal(data(api, 'b').value, 8);
  assert.deepEqual(api.log().orders, []); assert.deepEqual(api.log().events, []);
  for (const value of [-1, 1.2, '3', Number.MAX_SAFE_INTEGER + 1]) assert.equal(add(api, { id: 'bad', type: 'counter', title: 'X', data: { value } }).ok, false);
});
test('offline relative operations merge with ChatGPT and survive restart and receipt age', () => {
  const { api, storage, store } = setup(10);
  const pending = [op(api), op(api), op(api)];
  assert.equal(cmd(api, 'counter_delta', { generation: data(api).counter_generation, delta: 2 }, 'c').ok, true);
  pending.forEach(input => assert.equal(api.action(input).ok, true));
  assert.equal(data(api).value, 15);
  store.sql.exec('DELETE FROM commands'); // Old command cleanup must not remove counter receipts.
  const resumed = new KitchenApi(new KitchenStore(storage));
  pending.forEach(input => { const response = resumed.action(input); assert.equal(response.ok, true); assert.equal(response.duplicate, true); });
  assert.equal(data(resumed).value, 15); assert.equal(data(resumed).counter_revision, 4);
  const reused = resumed.action({ ...pending[0], delta: 2 });
  assert.equal(reused.code, 'operation_reused'); assert.equal(data(resumed).value, 15);
});
test('absolute offline writes accept own predecessors, but conflict with another writer', () => {
  const { api } = setup(10);
  const step = op(api), set = op(api, 'counter_set', { value: 40, expected_counter_revision: 1 });
  api.action(step); assert.equal(api.action(set).ok, true);
  const stale = op(api, 'counter_set', { value: 70, expected_counter_revision: 2 });
  api.action(op(api));
  assert.equal(api.action(stale).code, 'stale'); assert.equal(data(api).value, 41);
  assert.equal(api.action(stale).code, 'stale');
  assert.equal(api.action(op(api, 'counter_set', { value: 70, expected_counter_revision: data(api).counter_revision })).ok, true);
  assert.equal(data(api).value, 70);
});
test('underflow and overflow are explicit conflicts, never clamped or silently applied later', () => {
  const { api } = setup();
  const minus = op(api, 'counter_delta', { delta: -1 });
  assert.equal(api.action(minus).code, 'range'); api.action(op(api));
  assert.equal(api.action(minus).code, 'range'); assert.equal(data(api).value, 1);
  api.action(op(api, 'counter_set', { value: Number.MAX_SAFE_INTEGER, expected_counter_revision: 1 }));
  assert.equal(api.action(op(api)).code, 'range');
});
test('clear and deletion prevent resurrection, including reuse of a card ID', () => {
  const { api } = setup(10);
  const pending = op(api);
  cmd(api, 'clear_display');
  assert.equal(api.action(pending).code, 'missing'); assert.equal(api.snapshot().items.length, 0);
  add(api, { id: 'c', type: 'counter', title: 'Nové počítadlo' });
  assert.notEqual(data(api).counter_generation, pending.generation);
  assert.equal(api.action(pending).code, 'missing'); assert.equal(data(api).value, 0);
  const deletion = op(api, 'counter_delete');
  assert.equal(api.action(deletion).ok, true); assert.equal(api.snapshot().items.length, 0);
  assert.equal(api.action(deletion).ok, true);
});
test('counter command retry uses lifetime receipts even after normal command retention expires', () => {
  const { api, store } = setup(10);
  const command = { expected_revision: api.snapshot().syncState.revision, command_id:'long-offline-chat-retry', action:'counter_delta', target:'c', payload:{ generation:data(api).counter_generation, delta:2 } };
  assert.equal(api.commands(command).ok, true);
  store.sql.exec('DELETE FROM commands');
  assert.equal(api.commands(command).ok, true); assert.equal(data(api).value, 12);
});
test('pinned counter follows the order, locks on terminal state, never leaks into archive or undo', async () => {
  const { api, store } = setup(9, 'o');
  cmd(api, 'complete_order', {}, 'o');
  assert.equal(api.action(op(api)).code, 'locked');
  assert.equal(cmd(api, 'detach_card', {}, 'c').ok, false);
  assert.ok(!JSON.stringify(api.log()).includes('counter_generation'));
  assert.deepEqual(store.attachmentSnapshot('o'), []);
  const history = await (await handleApi(new Request('https://example.test/api/history'), api)).json();
  assert.deepEqual(history.orders[0].attachedCards, []);
  cmd(api, 'reopen_order', {}, 'o'); assert.equal(api.action(op(api)).ok, true);
  cmd(api, 'cancel_order', {}, 'o'); assert.equal(api.action(op(api)).code, 'locked');
  cmd(api, 'delete_item', {}, 'o'); assert.equal(item(api), undefined);
});
test('generic writes cannot replace counter identity or bypass numeric conflict checks', () => {
  const { api } = setup(4);
  const before = data(api);
  for (const patch of [{ type: 'info' }, { id: 'replacement' }, { data_json: { value: 800 } }]) assert.equal(cmd(api, 'patch_item', { patch }, 'c').ok, false);
  assert.equal(add(api, { id: 'c', type: 'counter', title: 'Overwrite', data: { value: 700 } }).ok, false);
  assert.equal(cmd(api, 'set_status', { status: 'completed' }, 'c').ok, false);
  assert.equal(api.action({ action: 'swipe_item', item_id: 'c' }).ok, false);
  assert.equal(cmd(api, 'patch_item', { patch: { title: 'Těsto', body: 'Příprava' } }, 'c').ok, true);
  assert.deepEqual(data(api), before);
});
