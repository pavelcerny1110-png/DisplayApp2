import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/counter-core-v19.js';
import { createTestKitchen } from './sqlite.js';
const C = globalThis.DisplayCounterCore;
function setup(value = 10) {
  const kitchen = createTestKitchen();
  kitchen.api.commands({ action: 'upsert_item', payload: { id: 'c', type: 'counter', title: 'Palačinky', data: { value } } });
  const state = C.empty(); C.accept(state, kitchen.api.snapshot());
  return { ...kitchen, state };
}
const shown = state => C.data(C.project(state).find(i => i.id === 'c')).value;
const q = state => Object.values(state.queues)[0];
const enqueue = (state, action = 'counter_delta', value = 1, revision) => C.enqueue(state, 'c', action, value, crypto.randomUUID(), revision);
test('browser offline queue persists exact operations and combines with server changes', () => {
  const { api, state } = setup();
  enqueue(state); enqueue(state); enqueue(state);
  const restored = JSON.parse(JSON.stringify(state));
  api.commands({ action: 'counter_delta', target: 'c', payload: { generation: C.generation(api.snapshot().items[0]), delta: 2 } });
  while (q(restored)) { const op = q(restored).ops[0]; C.acknowledge(restored, op, api.action(op)); }
  assert.equal(shown(restored), 15); assert.equal(C.data(api.snapshot().items[0]).value, 15);
});
test('lost acknowledgement and an intervening poll never double a projected step', () => {
  const { api, state } = setup();
  const first = enqueue(state); enqueue(state);
  api.action(first); C.accept(state, api.snapshot());
  assert.equal(shown(state), 12);
  const restored = JSON.parse(JSON.stringify(state));
  C.acknowledge(restored, first, api.action(first)); assert.equal(shown(restored), 12);
  C.acknowledge(restored, first, api.action(first)); assert.equal(q(restored).ops.length, 1);
  C.acknowledge(restored, q(restored).ops[0], api.action(q(restored).ops[0])); assert.equal(shown(restored), 12);
});
test('absolute conflicts keep the local target across restarts and require explicit resolution', () => {
  const { api, state } = setup();
  enqueue(state);
  enqueue(state, 'counter_set', 40, C.data(C.project(state)[0]).counter_revision);
  const other = { ...q(state).ops[0], operation_id: 'another-device', delta: 2 }; api.action(other);
  C.acknowledge(state, q(state).ops[0], api.action(q(state).ops[0]));
  C.acknowledge(state, q(state).ops[0], api.action(q(state).ops[0]));
  assert.equal(q(state).issue.code, 'stale'); assert.equal(C.value(q(state)), 40);
  const restored = JSON.parse(JSON.stringify(state)); C.resolve(restored, other.generation, true, 'explicit-resolution');
  C.acknowledge(restored, q(restored).ops[0], api.action(q(restored).ops[0]));
  assert.equal(shown(restored), 40);
});
test('deleted generations cannot reappear, but recovery value remains available', () => {
  const { api, state } = setup(); const op = enqueue(state);
  api.commands({ action: 'clear_display' });
  C.acknowledge(state, op, api.action(op));
  assert.deepEqual(C.project(state), []); assert.equal(C.value(q(state)), 11);
  assert.throws(() => C.resolve(state, op.generation, true, 'cannot-resurrect'));
  C.resolve(state, op.generation, false, 'discard'); assert.equal(q(state), undefined);
});
test('invalid local steps do not alter the durable queue', () => {
  const { state } = setup(0);
  assert.throws(() => enqueue(state, 'counter_delta', -1)); assert.deepEqual(state.queues, {});
  for (const value of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => enqueue(state, 'counter_set', value, 0));
  assert.deepEqual(state.queues, {});
});
test('rebase never displays a negative value or loses the original local recovery target', () => {
  const { api, state } = setup(1);
  const first = enqueue(state); enqueue(state, 'counter_delta', -1); enqueue(state, 'counter_delta', -1);
  api.action({ ...first, operation_id:'other-device-minus', delta:-1 });
  C.acknowledge(state, first, api.action(first));
  assert.equal(shown(state), 0); assert.equal(q(state).issue.code, 'range');
  assert.equal(C.value(q(JSON.parse(JSON.stringify(state)))), 0);
  assert.equal(C.data(api.snapshot().items[0]).value, 1);
});
