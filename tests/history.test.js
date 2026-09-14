import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestKitchen } from './sqlite.js';
import { handleApi } from '../src/http.js';

const order = id => ({
  id,
  type: 'order',
  title: 'Objednávka 1',
  body: 'Kuřecí řízek – 160 Kč',
  data: { order_items: [{ name: 'Kuřecí řízek', quantity: 1, pricing_status: 'known', price_basis: 'total', total_price: 160 }] }
});
const command = (action, payload = {}, target) => ({ command_id: crypto.randomUUID(), action, payload, target });
const add = (api, item) => api.commands(command('upsert_item', { item }));
const current = (api, id) => api.snapshot().items.find(item => item.id === id);
const action = (api, kind, id) => {
  const item = current(api, id);
  return api.action({ action: kind, item_id: id, expected_updated_at: item.updated_at, expected_status: item.status });
};
const history = async api => {
  const response = await handleApi(new Request('https://test.invalid/api/history'), api);
  assert.equal(response.status, 200);
  return response.json();
};

test('v18 history is current-service, terminal-only and newest-terminal-first', async () => {
  const { api } = createTestKitchen();
  add(api, order('waiting'));
  add(api, order('completed'));
  action(api, 'toggle_order_completion', 'completed');
  add(api, order('cancelled'));
  action(api, 'swipe_item', 'cancelled');

  const data = await history(api);
  assert.equal(data.version, '19.0');
  assert.equal(data.serviceId, api.snapshot().syncState.currentServiceId);
  assert.deepEqual(data.orders.map(value => value.id), ['cancelled', 'completed']);
  assert.equal(data.orders[0].status, 'cancelled');
  assert.ok(data.orders[0].receivedAt);
  assert.ok(data.orders[0].cancelledAt);
  assert.equal(data.orders[0].completedAt, '');
  assert.equal(data.orders[1].status, 'completed');
  assert.ok(data.orders[1].receivedAt);
  assert.ok(data.orders[1].completedAt);
  assert.equal(data.orders[1].cancelledAt, '');
  assert.equal(data.orders.some(value => value.id === 'waiting'), false);
});

test('history preserves only cards actually attached to the terminal order', async () => {
  const { api } = createTestKitchen();
  add(api, order('order-1'));
  add(api, { id: 'info-pinned', type: 'info', title: 'Informace', body: 'Tatarka' });
  add(api, { id: 'alert-standalone', type: 'alert', title: 'Pozor', body: 'Samostatná karta' });
  api.commands(command('attach_card', { parent_order_id: 'order-1' }, 'info-pinned'));
  action(api, 'toggle_order_completion', 'order-1');

  const data = await history(api);
  assert.equal(data.orders.length, 1);
  assert.deepEqual(data.orders[0].attachedCards.map(card => card.id), ['info-pinned']);
  assert.equal(data.orders[0].attachedCards[0].body, 'Tatarka');
  assert.equal(data.orders[0].attachedCards.some(card => card.id === 'alert-standalone'), false);
});

test('waiting-order swipe keeps pinned-card snapshot after live removal', async () => {
  const { api } = createTestKitchen();
  add(api, order('order-1'));
  add(api, { id: 'reminder-pinned', type: 'reminder', title: 'Připomínka', body: 'Tatarka', data: { parent_order_id: 'order-1' } });
  action(api, 'swipe_item', 'order-1');
  assert.equal(api.snapshot().items.some(item => item.id === 'order-1'), false);
  assert.equal(api.snapshot().items.some(item => item.id === 'reminder-pinned'), false);

  const data = await history(api);
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].status, 'cancelled');
  assert.deepEqual(data.orders[0].attachedCards.map(card => card.id), ['reminder-pinned']);
});

test('history is read-only and archive clearing clears history', async () => {
  const { api } = createTestKitchen();
  add(api, order('order-1'));
  action(api, 'toggle_order_completion', 'order-1');
  assert.equal((await history(api)).orders.length, 1);

  const post = await handleApi(new Request('https://test.invalid/api/history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  }), api);
  assert.equal(post.status, 405);

  api.commands(command('clear_current_service_log'));
  assert.equal((await history(api)).orders.length, 0);
});
