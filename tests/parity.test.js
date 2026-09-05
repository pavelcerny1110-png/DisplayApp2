import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as E from '../src/engine.js';
const golden = JSON.parse(fs.readFileSync(new URL('./parity-golden.json', import.meta.url)));
test('36 command/audit golden steps match execution of actual v16.5 source', () => {
  let items = [];
  for (const step of golden.fixtures) {
    const before = structuredClone(items), candidate = structuredClone(items);
    const cmd = { action: step.action, target: step.target, commandId: step.commandId };
    let result, error = '';
    try { result = E.applyCommandToItems_(candidate, cmd, structuredClone(step.payload), step.at, 'main', {}); items = candidate; }
    catch (e) { error = String(e.message); }
    const mutation = E.deriveOrderAuditMutation_(before, items, { action: E.canonicalCommandAction_(cmd.action), source: 'chatgpt', occurredAt: step.at, commandId: cmd.commandId, details: result });
    mutation.events.forEach(event => delete event.event_id);
    const hash = crypto.createHash('sha256').update(JSON.stringify({ items, result, error, mutation })).digest('hex');
    assert.equal(hash, step.sha256, step.commandId + ': ' + step.action);
  }
});
