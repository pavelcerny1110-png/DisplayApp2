/* Pure durable-queue state machine, shared by the browser and Node tests. */
(() => {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const data = item => typeof item?.data_json === 'string' ? JSON.parse(item.data_json || '{}') : item?.data_json || {};
  const generation = item => data(item).counter_generation;
  const parent = item => data(item).parent_order_id || '';
  const terminal = status => ['served','completed','cancelled','canceled','done','closed','resolved','finished','hotovo','storno','zruseno'].includes(String(status).toLowerCase());
  const writable = (item, items) => item?.type === 'counter' && !terminal(item.status) && (!parent(item) || items.some(p => p.id === parent(item) && p.type === 'order' && !terminal(p.status)));
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const empty = () => ({ schema: 1, snapshot: null, queues: {} });
  const value = q => q.recoveryValue ?? q.ops.reduce((n, op) => op.action === 'counter_delta' ? n + op.delta : op.action === 'counter_set' ? op.value : n, data(q.anchor).value);
  function accept(state, snapshot) {
    if (snapshot && Array.isArray(snapshot.items) && (!state.snapshot || Number(snapshot.syncState?.revision) >= Number(state.snapshot.syncState?.revision))) state.snapshot = clone(snapshot);
  }
  function project(state, source = state.snapshot?.items || []) {
    return source.flatMap(item => {
      const q = state.queues[generation(item)];
      if (!q) return [item];
      if (!q.issue && q.ops.some(op => op.action === 'counter_delete')) return [];
      return [{ ...item, data_json: JSON.stringify({ ...data(item), value: value(q), counter_revision: data(q.anchor).counter_revision + q.ops.length }) }];
    });
  }
  function enqueue(state, id, action, amount, operationId, expectedRevision) {
    const item = project(state).find(i => i.id === id);
    if (!writable(item, state.snapshot?.items || [])) throw new Error('Počítadlo je uzamčené nebo už neexistuje.');
    const gen = generation(item);
    const q = state.queues[gen] || { anchor: clone(state.snapshot.items.find(i => i.id === id)), ops: [], issue: null };
    if (q.issue) throw new Error('Nejprve vyřešte neodeslané změny počítadla.');
    if (q.ops.length >= 10000) throw new Error('Fronta je plná. Počkejte na připojení.');
    const op = { action, item_id: id, generation: gen, operation_id: operationId };
    if (action === 'counter_delta') {
      if (![1, -1].includes(amount) || !integer(value(q) + amount)) throw new Error('Počítadlo nemůže překročit povolený rozsah.');
      op.delta = amount;
    } else if (action === 'counter_set') {
      if (!integer(amount) || !integer(expectedRevision)) throw new Error('Zadejte nezáporné celé číslo.');
      op.value = amount; op.expected_counter_revision = expectedRevision;
    } else if (action !== 'counter_delete') throw new Error('Neznámá akce počítadla.');
    q.ops.push(op); state.queues[gen] = q;
    return op;
  }
  function acknowledge(state, operation, reply) {
    const q = state.queues[operation.generation];
    if (!q || q.ops[0]?.operation_id !== operation.operation_id) return;
    accept(state, reply.data);
    if (!reply.ok) {
      q.issue = { code: reply.code || 'invalid', message: reply.message || 'Server změnu odmítl.' };
      return;
    }
    const localValue = value(q);
    q.ops.shift();
    if (!q.ops.length) { delete state.queues[operation.generation]; return; }
    const anchor = reply.data?.items?.find(i => generation(i) === operation.generation);
    if (anchor) {
      q.anchor = clone(anchor);
      if (!integer(value(q))) {
        q.recoveryValue = localValue;
        q.issue = { code: 'range', message: 'Změny na jiném zařízení by zbývající kroky posunuly mimo povolený rozsah. Vyberte hodnotu, kterou chcete zachovat.' };
      }
    } else {
      q.recoveryValue = localValue;
      q.issue = { code: 'missing', message: 'Počítadlo bylo odstraněno. Neodeslané změny zůstaly v zařízení.' };
    }
  }
  function resolve(state, gen, keepLocal, operationId) {
    const q = state.queues[gen];
    if (!q?.issue) return;
    const local = value(q);
    const item = state.snapshot?.items.find(i => generation(i) === gen);
    if (keepLocal && (!writable(item, state.snapshot.items) || !integer(local))) throw new Error('Toto počítadlo nelze obnovit. Údaj můžete použít při vytvoření nové karty přes ChatGPT.');
    delete state.queues[gen];
    if (keepLocal) enqueue(state, item.id, 'counter_set', local, operationId, data(item).counter_revision);
  }
  globalThis.DisplayCounterCore = { empty, data, generation, writable, integer, value, accept, project, enqueue, acknowledge, resolve };
})();
