// Display App v17.0. Pure command/gesture/audit logic ported from v16.5.
// Source SHA-256: d47b90fe0d758cf877a44eb9ef40f6ff2590eba940b6afca7a78fb10eed0bc46
// No Google APIs, networking or persistence in this module.
const DISPLAY_TIME_ZONE = 'Europe/Prague';
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
function formatPrague(date, pattern) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(date).map(p => [p.type, p.value]));
  return pattern === 'HH:mm' ? `${parts.hour}:${parts.minute}` : `${parts.year}-${parts.month}-${parts.day}`;
}
const ITEM_HEADERS = [
  'id',
  'channel',
  'type',
  'title',
  'subtitle',
  'body',
  'status',
  'priority',
  'sort',
  'created_at',
  'updated_at',
  'expires_at',
  'data_json'
];

const ORDER_ARCHIVE_HEADERS = [
  'order_id',
  'service_id',
  'order_number',
  'title',
  'subtitle',
  'body',
  'status',
  'received_at',
  'first_completed_at',
  'last_completed_at',
  'cancelled_at',
  'updated_at',
  'hidden_from_display_at',
  'total_price',
  'customer_or_table',
  'served_items_json',
  'pending_items_json',
  'item_json',
  'last_source'
];

function canonicalCommandAction_(value) {
  const action = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  const aliases = {
    add_item: 'upsert_item',
    create_item: 'upsert_item',
    new_item: 'upsert_item',
    add_items: 'upsert_items',
    create_items: 'upsert_items',
    update_item: 'patch_item',
    edit_item: 'patch_item',
    serve_order: 'complete_order',
    finish_order: 'complete_order',
    complete_operational: 'complete_card',
    finish_card: 'complete_card',
    remove_item: 'delete_item',
    pin_card: 'attach_card',
    unpin_card: 'detach_card',
    partial_serve: 'serve_order_items',
    issue_order_items: 'serve_order_items',
    clear: 'clear_display',
    undo_order: 'reopen_order',
    reopen: 'reopen_order',
    set_served_items: 'set_order_item_states',
    update_order_items: 'set_order_item_states',
    clear_today_log: 'clear_current_service_log',
    clear_log: 'clear_current_service_log',
    clear_everything_today: 'clear_display_and_current_service_log'
  };

  return aliases[action] || action;
}

function isOrderLogClearAction_(action) {
  return action === 'clear_current_service_log' ||
    action === 'clear_all_order_logs' ||
    action === 'clear_display_and_current_service_log';
}

function applyCommandToItems_(items, command, payload, nowIso, activeChannel, ss) {
  const action = canonicalCommandAction_(command.action);

  switch (action) {
    case 'upsert_item':
      return upsertOneItem_(items, payload.item || payload, command.commandId, nowIso, activeChannel);

    case 'upsert_items': {
      const source = Array.isArray(payload.items) ? payload.items : [];
      if (!source.length) throw new Error('upsert_items vyžaduje neprázdné pole payload.items.');

      const ids = [];
      let changed = false;
      source.forEach((item, index) => {
        const result = upsertOneItem_(items, item, command.commandId + '-' + (index + 1), nowIso, activeChannel);
        ids.push(result.itemId);
        changed = changed || result.changed;
      });
      return { changed, itemIds: ids };
    }

    case 'patch_item':
      return patchOneItem_(items, command.target, payload, nowIso);

    case 'set_status':
      return setOneItemStatus_(items, command.target, payload, nowIso);

    case 'complete_order':
      return completeOrderCommand_(items, command.target, payload, nowIso);

    case 'reopen_order':
      return reopenOrderCommand_(items, command.target, payload, nowIso);

    case 'set_order_item_states':
      return setOrderItemStatesCommand_(items, command.target, payload, nowIso);

    case 'cancel_order':
      return cancelOrderCommand_(items, command.target, payload, nowIso);

    case 'serve_order_items':
      return serveOrderItemsCommand_(items, command.target, payload, nowIso);

    case 'complete_card':
      return completeCardCommand_(items, command.target, payload, nowIso);

    case 'delete_item':
      return deleteItemCommand_(items, command.target, payload);

    case 'attach_card':
      return attachCardCommand_(items, command.target, payload, nowIso);

    case 'detach_card':
      return detachCardCommand_(items, command.target, payload, nowIso);

    case 'clear_display':
      return clearDisplayCommand_(items, command.target, payload, activeChannel);

    case 'clear_channel':
      return clearChannelCommand_(items, command.target, payload, activeChannel);

    case 'clear_current_service_log':
      return clearCurrentServiceLogCommand_(ss, payload, nowIso);

    case 'clear_all_order_logs':
      return clearAllOrderLogsCommand_(ss, payload, nowIso);

    case 'clear_display_and_current_service_log': {
      const clearResult = clearDisplayCommand_(items, command.target, payload, activeChannel);
      const logResult = clearCurrentServiceLogCommand_(ss, payload, nowIso);
      return {
        changed: clearResult.changed,
        cleared: clearResult.cleared,
        channel: clearResult.channel,
        clearedArchiveOrders: logResult.clearedArchiveOrders,
        clearedEvents: logResult.clearedEvents,
        serviceId: logResult.serviceId,
        skipOrderAudit: true
      };
    }

    default:
      throw new Error('Neznámá command action: ' + (command.action || '(prázdná)'));
  }
}

function upsertOneItem_(items, source, fallbackId, nowIso, activeChannel) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('upsert_item vyžaduje objekt payload.item.');
  }

  const requestedId = String(source.id || '').trim();
  const itemId = requestedId || ('item-' + sanitizeIdPart_(fallbackId));
  const existingIndex = items.findIndex(item => String(item.id || '') === itemId);
  const existing = existingIndex >= 0 ? items[existingIndex] : {};
  const merged = Object.assign({}, existing, source, { id: itemId });

  if (!merged.type) throw new Error('Nová položka musí mít type.');

  const type = String(merged.type).trim().toLowerCase();
  merged.type = type;
  merged.channel = String(merged.channel || activeChannel || 'main');
  merged.title = String(merged.title || '');
  merged.subtitle = String(merged.subtitle || '');
  merged.body = String(merged.body || '');
  merged.status = String(merged.status || defaultStatusForType_(type));
  merged.priority = finiteNumberOr_(merged.priority, 0);
  merged.sort = finiteNumberOr_(merged.sort, nextSortValue_(items));
  if (type === 'order' && existingIndex < 0) {
    // V16: přesný čas přijetí určuje backend v okamžiku skutečného provedení.
    merged.created_at = nowIso;
    merged.updated_at = nowIso;
  } else {
    merged.created_at = Object.prototype.hasOwnProperty.call(source, 'created_at')
      ? (normalizeDateCell_(source.created_at) || existing.created_at || nowIso)
      : (existing.created_at || nowIso);
    merged.updated_at = Object.prototype.hasOwnProperty.call(source, 'updated_at')
      ? (normalizeDateCell_(source.updated_at) || nowIso)
      : nowIso;
  }
  merged.expires_at = normalizeDateCell_(merged.expires_at);

  if (Object.prototype.hasOwnProperty.call(source, 'data') && !Object.prototype.hasOwnProperty.call(source, 'data_json')) {
    merged.data_json = source.data;
  }
  merged.data_json = normalizeDataJsonCell_(merged.data_json);

  if (type === 'order') {
    const orderData = parseDataObject_(merged.data_json);
    if (existingIndex < 0) {
      orderData.received_at = nowIso;
      orderData.service_id = getPragueServiceId_(new Date(nowIso));
      // Čas přijetí už nepřipravuje ChatGPT. Backend ho vytvoří sám a
      // případný kontext (stůl, jméno, box) zachová za oddělovačem.
      merged.subtitle = buildOrderReceiptSubtitle_(merged.subtitle, orderData, nowIso);
    }
    ensureOrderItemStateArrays_(merged, orderData);
    merged.data_json = safeJsonStringify_(orderData);
  }

  const normalized = normalizeItemRecord_(merged);
  if (existingIndex >= 0) items[existingIndex] = normalized;
  else items.push(normalized);

  return {
    changed: true,
    itemId,
    operation: existingIndex >= 0 ? 'updated' : 'created'
  };
}

function patchOneItem_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const index = resolveSingleItemIndex_(items, selector, {
    expectedTypes: payload.expected_types || payload.expectedTypes || payload.expected_type || payload.expectedType,
    allowFuzzy: Boolean(payload.allow_fuzzy || payload.allowFuzzy)
  });

  const patch = payload.patch || payload.fields;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch_item vyžaduje objekt payload.patch.');
  }

  const item = Object.assign({}, items[index]);
  const allowed = new Set(ITEM_HEADERS);
  Object.keys(patch).forEach(key => {
    if (!allowed.has(key)) return;
    item[key] = patch[key];
  });

  if (patch.data_json && typeof patch.data_json === 'object') {
    item.data_json = safeJsonStringify_(patch.data_json);
  }

  const dataPatch = payload.data_json_patch || payload.dataJsonPatch;
  if (dataPatch && typeof dataPatch === 'object' && !Array.isArray(dataPatch)) {
    const data = parseDataObject_(item.data_json);
    Object.keys(dataPatch).forEach(key => {
      if (dataPatch[key] === null) delete data[key];
      else data[key] = dataPatch[key];
    });
    item.data_json = safeJsonStringify_(data);
  }

  const clearFields = Array.isArray(payload.clear_fields) ? payload.clear_fields : [];
  clearFields.forEach(key => {
    if (allowed.has(key) && key !== 'id') item[key] = '';
  });

  item.updated_at = normalizeDateCell_(patch.updated_at) || nowIso;
  items[index] = normalizeItemRecord_(item);

  return { changed: true, itemId: items[index].id };
}

function setOneItemStatus_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const index = resolveSingleItemIndex_(items, selector, {
    expectedTypes: payload.expected_types || payload.expectedTypes || payload.expected_type || payload.expectedType,
    allowFuzzy: Boolean(payload.allow_fuzzy || payload.allowFuzzy)
  });
  const status = String(payload.status || '').trim().toLowerCase();
  if (!status) throw new Error('set_status vyžaduje payload.status.');

  const type = String(items[index].type || '').toLowerCase();
  if (type === 'order') {
    if (isCompletedLikeStatus_(status) || status === 'served') {
      return completeOrderAtIndex_(items, index, nowIso);
    }
    if (isCancelledLikeStatus_(status)) {
      return cancelOrderAtIndex_(items, index, nowIso);
    }
  }

  if (isOperationalType_(type) && (isCompletedLikeStatus_(status) || status === 'served')) {
    return completeCardAtIndex_(items, index, nowIso, false);
  }

  const item = Object.assign({}, items[index]);
  const data = parseDataObject_(item.data_json);
  item.status = status;
  item.updated_at = nowIso;

  if (status === 'waiting' || status === 'active') {
    delete data.served_at;
    delete data.cancelled_at;
    delete data.canceled_at;
    delete data.completed_at;
    delete data.completed_by_parent;
  }

  item.data_json = safeJsonStringify_(data);
  items[index] = normalizeItemRecord_(item);
  return { changed: true, itemId: item.id, status };
}

function completeOrderCommand_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const index = resolveSingleItemIndex_(items, selector, { expectedTypes: ['order'] });
  return completeOrderAtIndex_(items, index, nowIso);
}

function cancelOrderCommand_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const index = resolveSingleItemIndex_(items, selector, { expectedTypes: ['order'] });
  return cancelOrderAtIndex_(items, index, nowIso);
}

function completeOrderAtIndex_(items, index, nowIso, options) {
  const opts = options || {};
  const item = Object.assign({}, items[index]);
  const data = parseDataObject_(item.data_json);

  const pending = getPendingOrderItems_(item, data);
  const currentStatus = String(item.status || '').toLowerCase();
  if ((currentStatus === 'served' || isCompletedLikeStatus_(currentStatus)) && pending.length === 0) {
    return { changed: false, itemId: item.id, status: 'served', completedChildIds: [] };
  }

  const undoSnapshot = opts.undoSnapshot || createOrderCompletionUndoSnapshot_(items, index);
  const served = getServedOrderItems_(data);
  data.served_items = uniqueStrings_(served.concat(pending));
  data.pending_items = [];
  data.served_at = nowIso;
  data.completed_at = nowIso;
  data._completion_undo = undoSnapshot;

  item.status = 'served';
  item.updated_at = nowIso;
  item.data_json = safeJsonStringify_(data);
  items[index] = normalizeItemRecord_(item);

  const completedChildren = completeActiveChildrenForOrder_(items, item.id, nowIso);
  const finalData = parseDataObject_(items[index].data_json);
  if (finalData._completion_undo && typeof finalData._completion_undo === 'object') {
    finalData._completion_undo.completed_child_ids = completedChildren.slice();
    items[index].data_json = safeJsonStringify_(finalData);
  }

  return {
    changed: true,
    itemId: item.id,
    status: 'served',
    completedChildIds: completedChildren
  };
}

function reopenOrderCommand_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const index = resolveSingleItemIndex_(items, selector, { expectedTypes: ['order'] });
  return reopenOrderAtIndex_(items, index, nowIso);
}

function reopenOrderAtIndex_(items, index, nowIso) {
  const item = Object.assign({}, items[index]);
  const data = parseDataObject_(item.data_json);
  const snapshot = data._completion_undo && typeof data._completion_undo === 'object'
    ? data._completion_undo
    : null;

  if (getMainOrderStatusForAudit_(item.status) === 'waiting') {
    return { changed: false, itemId: item.id, status: 'waiting', restoredChildIds: [] };
  }

  let restoredData;
  let restoredStatus = 'waiting';
  const restoredChildIds = [];

  if (snapshot && snapshot.order && typeof snapshot.order === 'object') {
    restoredStatus = String(snapshot.order.status || 'waiting');
    restoredData = parseDataObject_(snapshot.order.data_json);
    const completedChildIds = new Set(
      Array.isArray(snapshot.completed_child_ids) ? snapshot.completed_child_ids.map(String) : []
    );
    const childSnapshots = Array.isArray(snapshot.children) ? snapshot.children : [];

    childSnapshots.forEach(childSnapshot => {
      const childId = String(childSnapshot && childSnapshot.id || '');
      if (!childId || !completedChildIds.has(childId)) return;
      const childIndex = items.findIndex(value => String(value.id || '') === childId);
      if (childIndex < 0) return;

      const currentChildData = parseDataObject_(items[childIndex].data_json);
      if (!currentChildData.completed_by_parent) return;

      const restoredChild = Object.assign({}, items[childIndex], {
        status: String(childSnapshot.status || 'active'),
        data_json: normalizeDataJsonCell_(childSnapshot.data_json),
        updated_at: nowIso
      });
      items[childIndex] = normalizeItemRecord_(restoredChild);
      restoredChildIds.push(childId);
    });
  } else {
    restoredData = Object.assign({}, data);
    const allItems = getAllOrderItems_(item, restoredData);
    restoredData.served_items = [];
    restoredData.pending_items = allItems;
  }

  delete restoredData.served_at;
  delete restoredData.completed_at;
  delete restoredData.cancelled_at;
  delete restoredData.canceled_at;
  delete restoredData._completion_undo;

  item.status = restoredStatus;
  item.updated_at = nowIso;
  item.data_json = safeJsonStringify_(restoredData);
  items[index] = normalizeItemRecord_(item);

  return {
    changed: true,
    itemId: item.id,
    status: 'waiting',
    restoredChildIds
  };
}

function setOrderItemStatesCommand_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const index = resolveSingleItemIndex_(items, selector, { expectedTypes: ['order'] });
  const item = Object.assign({}, items[index]);

  if (getMainOrderStatusForAudit_(item.status) !== 'waiting') {
    throw new Error('Jednotlivé položky lze měnit jen u čekající objednávky.');
  }

  const data = parseDataObject_(item.data_json);
  const allItems = getAllOrderItems_(item, data);
  const requested = Array.isArray(payload.served_items)
    ? payload.served_items
    : (Array.isArray(payload.servedItems) ? payload.servedItems : []);
  const selectedKeys = new Set(requested.map(normalizeOrderItemStateKey_).filter(Boolean));
  const nextServed = [];
  const nextPending = [];

  allItems.forEach(value => {
    if (selectedKeys.has(normalizeOrderItemStateKey_(value))) nextServed.push(value);
    else nextPending.push(value);
  });

  const previousServed = getServedOrderItems_(data);
  const previousPending = getPendingOrderItems_(item, data);
  if (sameStringSet_(previousServed, nextServed) && sameStringSet_(previousPending, nextPending)) {
    return { changed: false, itemId: item.id, status: 'waiting' };
  }

  const undoSnapshot = createOrderCompletionUndoSnapshot_(items, index);
  data.served_items = uniqueStrings_(nextServed);
  data.pending_items = uniqueStrings_(nextPending);
  item.updated_at = nowIso;
  item.data_json = safeJsonStringify_(data);
  items[index] = normalizeItemRecord_(item);

  if (!nextPending.length && payload.complete_when_empty !== false && payload.completeWhenEmpty !== false) {
    return completeOrderAtIndex_(items, index, nowIso, { undoSnapshot });
  }

  return {
    changed: true,
    itemId: item.id,
    status: 'waiting',
    servedItems: nextServed,
    remainingItems: nextPending
  };
}

function cancelOrderAtIndex_(items, index, nowIso) {
  const item = Object.assign({}, items[index]);
  const data = parseDataObject_(item.data_json);
  if (isCancelledLikeStatus_(item.status)) {
    return { changed: false, itemId: item.id, status: 'cancelled', completedChildIds: [] };
  }
  data.cancelled_at = nowIso;

  item.status = 'cancelled';
  item.updated_at = nowIso;
  item.data_json = safeJsonStringify_(data);
  items[index] = normalizeItemRecord_(item);

  const completedChildren = completeActiveChildrenForOrder_(items, item.id, nowIso);
  return {
    changed: true,
    itemId: item.id,
    status: 'cancelled',
    completedChildIds: completedChildren
  };
}

function serveOrderItemsCommand_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const index = resolveSingleItemIndex_(items, selector, { expectedTypes: ['order'] });
  const requestedSource = payload.items || payload.served_items || payload.servedItems;
  const requested = normalizeRequestedItems_(requestedSource);

  if (!requested.length) throw new Error('serve_order_items vyžaduje payload.items.');

  const item = Object.assign({}, items[index]);
  const undoSnapshot = createOrderCompletionUndoSnapshot_(items, index);
  const data = parseDataObject_(item.data_json);
  const pending = getPendingOrderItems_(item, data);
  const served = getServedOrderItems_(data);
  const workingPending = pending.slice();
  const newlyServed = [];

  requested.forEach(request => {
    for (let count = 0; count < request.quantity; count += 1) {
      const matchIndex = findRequestedOrderItemIndex_(workingPending, request.name);
      if (matchIndex < 0) {
        throw new Error('Položka nebyla v čekající části objednávky nalezena: ' + request.name);
      }
      newlyServed.push(workingPending[matchIndex]);
      workingPending.splice(matchIndex, 1);
    }
  });

  data.served_items = uniqueStrings_(served.concat(newlyServed));
  data.pending_items = workingPending;
  item.updated_at = nowIso;
  item.data_json = safeJsonStringify_(data);
  items[index] = normalizeItemRecord_(item);

  if (!workingPending.length && payload.complete_when_empty !== false && payload.completeWhenEmpty !== false) {
    return completeOrderAtIndex_(items, index, nowIso, { undoSnapshot });
  }

  return {
    changed: true,
    itemId: item.id,
    servedItems: newlyServed,
    remainingItems: workingPending
  };
}

function completeCardCommand_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const index = resolveSingleItemIndex_(items, selector, {
    expectedTypes: ['reminder', 'tip', 'info', 'alert'],
    allowFuzzy: Boolean(payload.allow_fuzzy || payload.allowFuzzy)
  });
  return completeCardAtIndex_(items, index, nowIso, false);
}

function completeCardAtIndex_(items, index, nowIso, completedByParent) {
  const item = Object.assign({}, items[index]);
  const data = parseDataObject_(item.data_json);
  if (isCompletedLikeStatus_(item.status) || String(item.status || '').toLowerCase() === 'served') {
    return { changed: false, itemId: item.id, status: 'completed' };
  }
  data.completed_at = nowIso;
  if (completedByParent) data.completed_by_parent = true;
  else delete data.completed_by_parent;

  item.status = 'completed';
  item.updated_at = nowIso;
  item.data_json = safeJsonStringify_(data);
  items[index] = normalizeItemRecord_(item);

  return { changed: true, itemId: item.id, status: 'completed' };
}

function deleteItemCommand_(items, commandTarget, payload) {
  const selector = payload.selector || payload.target || commandTarget;
  const allowMissing = Boolean(payload.allow_missing || payload.allowMissing);
  const index = resolveSingleItemIndex_(items, selector, {
    expectedTypes: payload.expected_types || payload.expectedTypes || payload.expected_type || payload.expectedType,
    allowFuzzy: Boolean(payload.allow_fuzzy || payload.allowFuzzy),
    allowMissing
  });

  if (index < 0) return { changed: false, itemId: '', missing: true };
  const removed = items.splice(index, 1)[0];

  // Při odstranění objednávky odstraň i její podřízené karty, aby se nikdy
  // samostatně znovu neobjevily.
  if (String(removed.type || '').toLowerCase() === 'order') {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (getParentOrderId_(items[i]) === String(removed.id || '')) items.splice(i, 1);
    }
  }

  return { changed: true, itemId: removed.id };
}

function attachCardCommand_(items, commandTarget, payload, nowIso) {
  const cardSelector = payload.card_selector || payload.cardSelector || payload.selector || commandTarget;
  const orderSelector = payload.parent_order_selector || payload.parentOrderSelector ||
    payload.parent_order_id || payload.parentOrderId || payload.order_selector || payload.orderSelector;

  if (!orderSelector) throw new Error('attach_card vyžaduje parent_order_selector nebo parent_order_id.');

  const cardIndex = resolveSingleItemIndex_(items, cardSelector, {
    expectedTypes: ['reminder', 'tip', 'info', 'alert'],
    allowFuzzy: Boolean(payload.allow_fuzzy || payload.allowFuzzy)
  });
  const orderIndex = resolveSingleItemIndex_(items, orderSelector, { expectedTypes: ['order'] });

  const card = Object.assign({}, items[cardIndex]);
  const data = parseDataObject_(card.data_json);
  const nextParentId = String(items[orderIndex].id || '');
  if (getParentOrderId_(card) === nextParentId) {
    return { changed: false, itemId: card.id, parentOrderId: nextParentId };
  }
  data.parent_order_id = nextParentId;
  card.data_json = safeJsonStringify_(data);
  card.updated_at = nowIso;
  items[cardIndex] = normalizeItemRecord_(card);

  return { changed: true, itemId: card.id, parentOrderId: data.parent_order_id };
}

function detachCardCommand_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const cardIndex = resolveSingleItemIndex_(items, selector, {
    expectedTypes: ['reminder', 'tip', 'info', 'alert'],
    allowFuzzy: Boolean(payload.allow_fuzzy || payload.allowFuzzy)
  });

  const card = Object.assign({}, items[cardIndex]);
  const data = parseDataObject_(card.data_json);
  if (!getParentOrderId_(card)) {
    return { changed: false, itemId: card.id };
  }
  delete data.parent_order_id;
  delete data.parentOrderId;
  delete data.pinned_to_order_id;
  delete data.pinnedToOrderId;
  delete data.attached_to_order_id;
  delete data.attachedToOrderId;
  delete data.order_id;
  delete data.orderId;
  card.data_json = safeJsonStringify_(data);
  card.updated_at = nowIso;
  items[cardIndex] = normalizeItemRecord_(card);

  return { changed: true, itemId: card.id };
}

function clearDisplayCommand_(items, commandTarget, payload, activeChannel) {
  const channel = String(payload.channel || commandTarget || '').trim();

  if (channel && channel !== '*' && channel.toLowerCase() !== 'all') {
    const before = items.length;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (String(items[i].channel || activeChannel || 'main') === channel) items.splice(i, 1);
    }
    return { changed: before !== items.length, cleared: before - items.length, channel };
  }

  const cleared = items.length;
  items.splice(0, items.length);
  return { changed: cleared > 0, cleared, channel: 'all' };
}

function clearChannelCommand_(items, commandTarget, payload, activeChannel) {
  const channel = String(payload.channel || commandTarget || activeChannel || 'main').trim();
  const before = items.length;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (String(items[i].channel || 'main') === channel) items.splice(i, 1);
  }
  return { changed: before !== items.length, cleared: before - items.length, channel };
}

function applyDisplaySwipe_(items, index, nowIso, auditMutations) {
  const current = items[index];
  const type = canonicalItemTypeForServer_(current.type);

  if (type === 'order') {
    const status = getMainOrderStatusForAudit_(current.status);
    if (status === 'waiting') {
      const beforeCancel = cloneItems_(items);
      cancelOrderAtIndex_(items, index, nowIso);
      const afterCancel = cloneItems_(items);
      const cancelMutation = deriveOrderAuditMutation_(beforeCancel, afterCancel, {
        action: 'swipe_cancel_order',
        source: 'display',
        occurredAt: nowIso,
        commandId: '',
        details: { itemId: current.id }
      });
      if (cancelMutation.events.length || cancelMutation.archiveUpdates.length) auditMutations.push(cancelMutation);
    }
  }

  const beforeRemove = cloneItems_(items);
  const removed = items.splice(index, 1)[0];
  if (type === 'order') {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (getParentOrderId_(items[i]) === String(removed.id || '')) items.splice(i, 1);
    }
    const removeMutation = deriveOrderAuditMutation_(beforeRemove, items, {
      action: 'swipe_hide_order',
      source: 'display',
      occurredAt: nowIso,
      commandId: '',
      details: { itemId: removed.id }
    });
    if (removeMutation.events.length || removeMutation.archiveUpdates.length) auditMutations.push(removeMutation);
  }

  return {
    changed: true,
    itemId: String(removed.id || ''),
    type,
    operation: type === 'order' && getMainOrderStatusForAudit_(removed.status) === 'cancelled'
      ? 'cancelled_and_hidden'
      : 'hidden_from_display'
  };
}

function resolveSingleItemIndex_(items, selector, options) {
  const opts = options || {};
  const expectedTypes = normalizeExpectedTypes_(opts.expectedTypes);
  const filteredIndexes = items
    .map((item, index) => ({ item, index }))
    .filter(entry => !expectedTypes.length || expectedTypes.includes(String(entry.item.type || '').toLowerCase()));

  if (!(selector && typeof selector === 'object')) {
    const directId = String(selector === null || selector === undefined ? '' : selector).trim();
    if (directId) {
      const directMatches = filteredIndexes.filter(entry => String(entry.item.id || '') === directId);
      if (directMatches.length === 1) return directMatches[0].index;
      if (directMatches.length > 1) {
        throw new Error('Cíl není jednoznačný (' + directMatches.length + ' shod): ' + directId);
      }
    }
  }

  const normalizedSelector = normalizeSelector_(selector);
  let matches = [];

  if (normalizedSelector.id) {
    matches = filteredIndexes.filter(entry => String(entry.item.id || '') === normalizedSelector.id);
  } else if (normalizedSelector.orderNumber !== null) {
    matches = filteredIndexes.filter(entry =>
      String(entry.item.type || '').toLowerCase() === 'order' &&
      extractOrderNumber_(entry.item) === normalizedSelector.orderNumber
    );
  } else if (normalizedSelector.title) {
    const wanted = normalizeTextKey_(normalizedSelector.title);
    matches = filteredIndexes.filter(entry => normalizeTextKey_(entry.item.title) === wanted);

    if (!matches.length && opts.allowFuzzy) {
      matches = filteredIndexes.filter(entry => {
        const current = normalizeTextKey_(entry.item.title);
        return current && wanted && (current.includes(wanted) || wanted.includes(current));
      });
    }
  }

  if (!matches.length) {
    if (opts.allowMissing) return -1;
    throw new Error('Cílová položka nebyla nalezena: ' + selectorDescription_(selector));
  }
  if (matches.length > 1) {
    throw new Error('Cíl není jednoznačný (' + matches.length + ' shod): ' + selectorDescription_(selector));
  }
  return matches[0].index;
}

function normalizeSelector_(selector) {
  if (selector && typeof selector === 'object' && !Array.isArray(selector)) {
    const id = String(selector.id || selector.item_id || selector.itemId || '').trim();
    const rawOrderNumber = selector.order_number !== undefined ? selector.order_number :
      selector.orderNumber !== undefined ? selector.orderNumber :
      selector.number !== undefined ? selector.number : null;
    const orderNumber = rawOrderNumber === null || rawOrderNumber === '' ? null : Number(rawOrderNumber);
    const title = String(selector.title || selector.name || '').trim();
    return {
      id,
      orderNumber: Number.isFinite(orderNumber) ? orderNumber : null,
      title
    };
  }

  const value = String(selector === null || selector === undefined ? '' : selector).trim();
  if (!value) return { id: '', orderNumber: null, title: '' };

  // Přímé ID má vždy přednost. Rozhodnutí, zda opravdu existuje, proběhne
  // v resolveSingleItemIndex_. Čistě číselná hodnota znamená provozní číslo.
  if (/^\d+$/.test(value)) {
    return { id: '', orderNumber: Number(value), title: '' };
  }
  if (/^(order|info|tip|alert|reminder|item)-/i.test(value)) {
    return { id: value, orderNumber: null, title: '' };
  }
  return { id: '', orderNumber: null, title: value };
}

function extractOrderNumber_(item) {
  const data = parseDataObject_(item.data_json);
  const candidates = [
    data.order_number,
    data.orderNumber,
    data.display_order_number,
    data.displayOrderNumber,
    data.operational_number,
    data.operationalNumber,
    data.provozni_cislo,
    data.cislo_objednavky,
    data.number
  ];

  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }

  const fallback = Number(item.sort);
  return Number.isFinite(fallback) ? fallback : null;
}

function completeActiveChildrenForOrder_(items, orderId, nowIso) {
  const completed = [];
  items.forEach((item, index) => {
    if (!isOperationalType_(item.type)) return;
    if (getParentOrderId_(item) !== String(orderId || '')) return;
    if (isCompletedLikeStatus_(item.status) || isCancelledLikeStatus_(item.status) || String(item.status || '').toLowerCase() === 'served') return;

    completeCardAtIndex_(items, index, nowIso, true);
    completed.push(String(items[index].id || ''));
  });
  return completed.filter(Boolean);
}

function getParentOrderId_(item) {
  const data = parseDataObject_(item && item.data_json);
  return String(
    data.parent_order_id || data.parentOrderId || data.pinned_to_order_id || data.pinnedToOrderId ||
    data.attached_to_order_id || data.attachedToOrderId || data.order_id || data.orderId || ''
  ).trim();
}

function getPendingOrderItems_(item, data) {
  if (Object.prototype.hasOwnProperty.call(data, 'pending_items') && Array.isArray(data.pending_items)) {
    return data.pending_items.map(orderItemText_).filter(Boolean);
  }

  if (Array.isArray(data.items)) {
    const pending = data.items
      .filter(value => {
        if (!value || typeof value !== 'object') return true;
        const status = String(value.status || '').toLowerCase();
        return !isCompletedLikeStatus_(status) && status !== 'served';
      })
      .map(orderItemText_)
      .filter(Boolean);
    if (pending.length) return pending;
  }

  return String(item.body || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(stripOrderLineQuantity_)
    .filter(Boolean);
}

function getServedOrderItems_(data) {
  if (Array.isArray(data.served_items)) {
    return data.served_items.map(orderItemText_).filter(Boolean);
  }

  if (Array.isArray(data.items)) {
    return data.items
      .filter(value => value && typeof value === 'object' &&
        (String(value.status || '').toLowerCase() === 'served' || isCompletedLikeStatus_(value.status)))
      .map(orderItemText_)
      .filter(Boolean);
  }

  return [];
}

function orderItemText_(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return String(value.text || value.title || value.name || value.label || '').trim();
}

function normalizeRequestedItems_(source) {
  const values = Array.isArray(source) ? source : (source ? [source] : []);
  return values.map(value => {
    if (typeof value === 'string') {
      const match = value.trim().match(/^(\d+)\s*[×x]\s*(.+)$/i);
      return match
        ? { name: match[2].trim(), quantity: Math.max(1, Number(match[1]) || 1) }
        : { name: value.trim(), quantity: 1 };
    }

    if (value && typeof value === 'object') {
      return {
        name: String(value.name || value.text || value.title || '').trim(),
        quantity: Math.max(1, Number(value.quantity || value.qty || 1) || 1)
      };
    }

    return { name: '', quantity: 0 };
  }).filter(value => value.name && value.quantity > 0);
}

function findRequestedOrderItemIndex_(pending, requestedName) {
  const wanted = normalizeOrderItemKey_(requestedName);
  const exact = [];
  const fuzzy = [];

  pending.forEach((value, index) => {
    const current = normalizeOrderItemKey_(value);
    if (current === wanted) exact.push(index);
    else if (current && wanted && (current.includes(wanted) || wanted.includes(current))) fuzzy.push(index);
  });

  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return exact[0];
  if (fuzzy.length === 1) return fuzzy[0];
  return -1;
}

function normalizeOrderItemKey_(value) {
  return normalizeTextKey_(stripOrderLineQuantity_(String(value || ''))
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+[–—-]\s*\d+(?:[.,]\d+)?\s*kč\s*$/i, ''));
}

function normalizeOrderItemStateKey_(value) {
  return normalizeTextKey_(stripOrderLineQuantity_(String(value || ''))
    .replace(/\s*\(\s*\d+(?:[.,]\d+)?\s*kč\s*\)\s*$/i, '')
    .replace(/\s+[–—-]\s*\d+(?:[.,]\d+)?\s*kč\s*$/i, ''));
}

function stripOrderLineQuantity_(value) {
  return String(value || '')
    .replace(/^\s*\d+\s*[×x]\s*/i, '')
    .trim();
}

function createOrderCompletionUndoSnapshot_(items, orderIndex) {
  const order = items[orderIndex] || {};
  const data = parseDataObject_(order.data_json);
  const cleanData = Object.assign({}, data);
  delete cleanData._completion_undo;

  const children = items
    .filter(item => isOperationalType_(item.type) && getParentOrderId_(item) === String(order.id || ''))
    .map(item => ({
      id: String(item.id || ''),
      status: String(item.status || ''),
      data_json: normalizeDataJsonCell_(item.data_json)
    }));

  return {
    order: {
      status: String(order.status || 'waiting'),
      data_json: safeJsonStringify_(cleanData)
    },
    children,
    completed_child_ids: []
  };
}

function ensureOrderItemStateArrays_(item, data) {
  if (!Array.isArray(data.served_items)) data.served_items = [];
  const shouldDerivePending = !Array.isArray(data.pending_items) ||
    (data.pending_items.length === 0 && data.served_items.length === 0 && String(item.body || '').trim());
  if (shouldDerivePending) {
    data.pending_items = String(item.body || '')
      .split('\n')
      .map(value => value.trim())
      .filter(Boolean)
      .map(stripOrderLineQuantity_)
      .filter(Boolean);
  }
  data.served_items = uniqueStrings_(data.served_items);
  data.pending_items = uniqueStrings_(data.pending_items);
}

function getAllOrderItems_(item, data) {
  const values = [];
  const bodyValues = String(item.body || '')
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean)
    .map(stripOrderLineQuantity_)
    .filter(Boolean);

  values.push.apply(values, bodyValues);
  if (Array.isArray(data.pending_items)) values.push.apply(values, data.pending_items);
  if (Array.isArray(data.served_items)) values.push.apply(values, data.served_items);

  // Jedna logická položka má jeden stav/checkbox i při odlišnosti v zápisu
  // množství nebo ceny. Text z body má přednost, protože je obvykle nejúplnější.
  const byKey = new Map();
  values.forEach(value => {
    const text = orderItemText_(value);
    const key = normalizeOrderItemStateKey_(text);
    if (key && !byKey.has(key)) byKey.set(key, text);
  });
  return Array.from(byKey.values());
}

function sameStringSet_(a, b) {
  const first = Array.from(new Set((Array.isArray(a) ? a : []).map(normalizeOrderItemStateKey_).filter(Boolean))).sort();
  const second = Array.from(new Set((Array.isArray(b) ? b : []).map(normalizeOrderItemStateKey_).filter(Boolean))).sort();
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function canonicalItemTypeForServer_(value) {
  const normalized = normalizeTextKey_(value).replace(/\s+/g, '_');
  const aliases = {
    objednavka: 'order', order: 'order',
    reminder: 'reminder', pripominka: 'reminder',
    tip: 'tip', info: 'info', informace: 'info',
    alert: 'alert', upozorneni: 'alert'
  };
  return aliases[normalized] || String(value || '').trim().toLowerCase();
}

function getMainOrderStatusForAudit_(status) {
  const value = String(status || '').toLowerCase();
  if (isCancelledLikeStatus_(value)) return 'cancelled';
  if (value === 'served' || isCompletedLikeStatus_(value)) return 'completed';
  return 'waiting';
}

function getCommandSource_(payload) {
  const meta = payload && payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  return String((payload && payload.source) || meta.source || 'chatgpt').trim() || 'chatgpt';
}

function normalizeServiceId_(value, fallback) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? normalizeServiceId_(fallback) : getPragueServiceId_(value);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 200000) {
    // A Sheets date serial has a calendar-day meaning (epoch 1899-12-30).
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10);
  }
  const text = String(value === null || value === undefined ? '' : value).trim().replace(/^'/, '');
  if (!text) return fallback === undefined ? '' : normalizeServiceId_(fallback);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const date = new Date(text);
    if (!isNaN(date.getTime())) return getPragueServiceId_(date);
  }
  return text;
}

function deriveOrderAuditMutation_(beforeItems, afterItems, meta) {
  const before = orderMapFromItems_(beforeItems);
  const after = orderMapFromItems_(afterItems);
  const events = [];
  const archiveUpdates = [];
  const action = String(meta.action || 'unknown');
  const source = String(meta.source || 'system');
  const occurredAt = String(meta.occurredAt || new Date().toISOString());
  const skipRemovalAudit = action === 'clear_display' || action === 'clear_channel' ||
    action === 'clear_display_and_current_service_log';
  const ids = new Set([].concat(Array.from(before.keys()), Array.from(after.keys())));

  ids.forEach(orderId => {
    const beforeItem = before.get(orderId) || null;
    const afterItem = after.get(orderId) || null;

    if (!beforeItem && afterItem) {
      events.push(makeOrderEvent_(afterItem, null, afterItem, 'created', source, occurredAt, '', {
        action,
        command_id: meta.commandId || ''
      }));
      archiveUpdates.push(makeArchiveUpdate_(afterItem, 'created', source, occurredAt));
      return;
    }

    if (beforeItem && !afterItem) {
      if (skipRemovalAudit) return;
      events.push(makeOrderEvent_(beforeItem, beforeItem, null, 'removed_from_display', source, occurredAt, '', {
        action,
        command_id: meta.commandId || ''
      }));
      archiveUpdates.push(makeArchiveUpdate_(beforeItem, 'removed_from_display', source, occurredAt));
      return;
    }

    if (!beforeItem || !afterItem) return;

    const beforeStatus = getMainOrderStatusForAudit_(beforeItem.status);
    const afterStatus = getMainOrderStatusForAudit_(afterItem.status);
    if (beforeStatus !== afterStatus) {
      let eventType = 'status_changed';
      if (afterStatus === 'completed') eventType = 'completed';
      else if (afterStatus === 'cancelled') eventType = 'cancelled';
      else if (afterStatus === 'waiting') eventType = 'reopened';

      events.push(makeOrderEvent_(afterItem, beforeItem, afterItem, eventType, source, occurredAt, '', {
        action,
        from: beforeStatus,
        to: afterStatus,
        command_id: meta.commandId || ''
      }));
      archiveUpdates.push(makeArchiveUpdate_(afterItem, eventType, source, occurredAt));
    }

    const beforeData = parseDataObject_(beforeItem.data_json);
    const afterData = parseDataObject_(afterItem.data_json);
    const beforeServed = orderItemKeyMap_(getServedOrderItems_(beforeData));
    const afterServed = orderItemKeyMap_(getServedOrderItems_(afterData));

    afterServed.forEach((value, key) => {
      if (beforeServed.has(key)) return;
      events.push(makeOrderEvent_(afterItem, beforeItem, afterItem, 'item_served', source, occurredAt, value, {
        action,
        command_id: meta.commandId || ''
      }));
    });
    beforeServed.forEach((value, key) => {
      if (afterServed.has(key)) return;
      events.push(makeOrderEvent_(afterItem, beforeItem, afterItem, 'item_reopened', source, occurredAt, value, {
        action,
        command_id: meta.commandId || ''
      }));
    });

    if (orderEditableFingerprint_(beforeItem) !== orderEditableFingerprint_(afterItem)) {
      events.push(makeOrderEvent_(afterItem, beforeItem, afterItem, 'edited', source, occurredAt, '', {
        action,
        command_id: meta.commandId || ''
      }));
    }

    if (beforeStatus === afterStatus &&
        (beforeServed.size !== afterServed.size ||
         Array.from(beforeServed.keys()).some(key => !afterServed.has(key)))) {
      archiveUpdates.push(makeArchiveUpdate_(afterItem, 'items_updated', source, occurredAt));
    } else if (orderEditableFingerprint_(beforeItem) !== orderEditableFingerprint_(afterItem)) {
      archiveUpdates.push(makeArchiveUpdate_(afterItem, 'edited', source, occurredAt));
    }
  });

  return { events, archiveUpdates };
}

function orderMapFromItems_(items) {
  const map = new Map();
  (Array.isArray(items) ? items : []).forEach(item => {
    if (canonicalItemTypeForServer_(item && item.type) !== 'order') return;
    const id = String(item && item.id || '');
    if (id) map.set(id, Object.assign({}, item));
  });
  return map;
}

function orderItemKeyMap_(values) {
  const map = new Map();
  (Array.isArray(values) ? values : []).forEach(value => {
    const text = orderItemText_(value);
    const key = normalizeOrderItemStateKey_(text);
    if (key && !map.has(key)) map.set(key, text);
  });
  return map;
}

function orderEditableFingerprint_(item) {
  const data = parseDataObject_(item && item.data_json);
  const copy = Object.assign({}, data);
  delete copy.served_items;
  delete copy.pending_items;
  delete copy.served_at;
  delete copy.completed_at;
  delete copy.cancelled_at;
  delete copy.canceled_at;
  delete copy._completion_undo;
  return safeJsonStringify_({
    title: String(item && item.title || ''),
    subtitle: String(item && item.subtitle || ''),
    body: String(item && item.body || ''),
    priority: finiteNumberOr_(item && item.priority, 0),
    sort: finiteNumberOr_(item && item.sort, 0),
    data: copy
  });
}

function makeOrderEvent_(referenceItem, beforeItem, afterItem, eventType, source, occurredAt, itemName, details) {
  const item = referenceItem || beforeItem || afterItem || {};
  const data = parseDataObject_(item.data_json);
  return {
    event_id: 'evt-' + crypto.randomUUID(),
    service_id: normalizeServiceId_(data.service_id, getPragueServiceId_(new Date(item.created_at || occurredAt))),
    order_id: String(item.id || ''),
    order_number: extractOrderNumber_(item),
    event_type: String(eventType || 'changed'),
    source: String(source || 'system'),
    occurred_at: String(occurredAt || new Date().toISOString()),
    item_name: String(itemName || ''),
    details_json: safeJsonStringify_(details || {}),
    before_json: beforeItem ? safeJsonStringify_(normalizeItemRecord_(beforeItem)) : '',
    after_json: afterItem ? safeJsonStringify_(normalizeItemRecord_(afterItem)) : ''
  };
}

function makeArchiveUpdate_(item, eventType, source, occurredAt) {
  return {
    item: Object.assign({}, item),
    eventType: String(eventType || 'changed'),
    source: String(source || 'system'),
    occurredAt: String(occurredAt || new Date().toISOString())
  };
}

function updateOrderArchiveRecord_(existing, update) {
  const item = normalizeItemRecord_(update.item || {});
  const data = parseDataObject_(item.data_json);
  const status = getMainOrderStatusForAudit_(item.status);
  const at = String(update.occurredAt || new Date().toISOString());
  const eventType = String(update.eventType || 'changed');
  const receivedAt = String(existing.received_at || data.received_at || item.created_at || at);
  const serviceId = normalizeServiceId_(existing.service_id || data.service_id, getPragueServiceId_(new Date(receivedAt)));

  const record = Object.assign({}, existing, {
    order_id: String(item.id || existing.order_id || ''),
    service_id: serviceId,
    order_number: extractOrderNumber_(item),
    title: String(item.title || ''),
    subtitle: String(item.subtitle || ''),
    body: String(item.body || ''),
    status,
    received_at: receivedAt,
    updated_at: at,
    total_price: extractOrderTotalPrice_(item, data),
    customer_or_table: extractOrderCustomerOrTable_(item, data),
    served_items_json: safeJsonStringify_(getServedOrderItems_(data)),
    pending_items_json: safeJsonStringify_(getPendingOrderItems_(item, data)),
    item_json: safeJsonStringify_(item),
    last_source: String(update.source || 'system')
  });

  if (eventType === 'completed') {
    if (!record.first_completed_at) record.first_completed_at = at;
    record.last_completed_at = at;
  }
  if (eventType === 'cancelled') record.cancelled_at = at;
  if (eventType === 'removed_from_display') record.hidden_from_display_at = at;

  ORDER_ARCHIVE_HEADERS.forEach(header => {
    if (record[header] === undefined || record[header] === null) record[header] = '';
  });
  return record;
}

function extractOrderTotalPrice_(item, data) {
  const candidates = [
    data.total_price, data.totalPrice, data.price_total, data.priceTotal,
    data.price, data.cena, data.total
  ];
  for (const value of candidates) {
    if (value === null || value === undefined || value === '') continue;
    return String(value);
  }

  const text = [item.subtitle, item.body].filter(Boolean).join('\n');
  const matches = Array.from(String(text).matchAll(/(\d+(?:[.,]\d+)?)\s*kč/gi));
  if (!matches.length) return '';
  const sum = matches.reduce((total, match) => total + Number(String(match[1]).replace(',', '.')), 0);
  return Number.isFinite(sum) ? String(sum) : '';
}

function extractOrderCustomerOrTable_(item, data) {
  const explicit = data.table || data.table_name || data.tableName || data.customer || data.customer_name ||
    data.customerName || data.person || data.name || data.customer_or_table || data.customerOrTable;
  return String(explicit || stripOrderReceiptSubtitlePrefix_(item.subtitle) || '');
}

function buildOrderReceiptSubtitle_(subtitle, data, nowIso) {
  let context = stripOrderReceiptSubtitlePrefix_(subtitle);
  if (!context) {
    context = String(
      data.table || data.table_name || data.tableName || data.customer || data.customer_name ||
      data.customerName || data.person || data.name || data.customer_or_table || data.customerOrTable || ''
    ).trim();
  }
  const receivedLabel = 'Přijato v ' + formatPrague(new Date(nowIso), 'HH:mm');
  return context ? receivedLabel + ' · ' + context : receivedLabel;
}

function stripOrderReceiptSubtitlePrefix_(value) {
  return String(value || '')
    .replace(/^\s*Přijato\s+v\s+\d{1,2}:\d{2}\s*(?:[·•|—–-]\s*)?/i, '')
    .trim();
}

function getPragueServiceId_(date) {
  return formatPrague(date instanceof Date ? date : new Date(date), 'yyyy-MM-dd');
}

function cloneItems_(items) {
  return items.map(item => Object.assign({}, item));
}

function normalizeItemRecord_(item) {
  const result = {};
  ITEM_HEADERS.forEach(header => {
    result[header] = item[header] === null || item[header] === undefined ? '' : item[header];
  });

  result.id = String(result.id || '').trim();
  result.channel = String(result.channel || 'main');
  result.type = String(result.type || '').trim().toLowerCase();
  result.title = String(result.title || '');
  result.subtitle = String(result.subtitle || '');
  result.body = String(result.body || '');
  result.status = String(result.status || '');
  result.priority = finiteNumberOr_(result.priority, 0);
  result.sort = finiteNumberOr_(result.sort, 0);
  result.created_at = normalizeDateCell_(result.created_at);
  result.updated_at = normalizeDateCell_(result.updated_at);
  result.expires_at = normalizeDateCell_(result.expires_at);
  result.data_json = normalizeDataJsonCell_(result.data_json);
  return result;
}

function defaultStatusForType_(type) {
  if (type === 'order') return 'waiting';
  if (isOperationalType_(type)) return 'active';
  return 'active';
}

function nextSortValue_(items) {
  return items.reduce((max, item) => Math.max(max, finiteNumberOr_(item.sort, 0)), 0) + 1;
}

function normalizeExpectedTypes_(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => String(item || '').trim().toLowerCase()).filter(Boolean);
}

function parsePayloadObject_(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'object' && !(value instanceof Date)) {
    if (Array.isArray(value)) throw new Error('payload_json musí být JSON objekt, ne pole.');
    return value;
  }

  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('payload_json musí obsahovat JSON objekt.');
    }
    return parsed;
  } catch (error) {
    throw new Error('Neplatný payload_json: ' + formatErrorMessage_(error));
  }
}

function parseDataObject_(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return Object.assign({}, value);

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function normalizeDataJsonCell_(value) {
  if (!value) return '{}';
  if (typeof value === 'object') return safeJsonStringify_(value);
  const text = String(value).trim();
  if (!text) return '{}';

  try {
    const parsed = JSON.parse(text);
    return safeJsonStringify_(parsed && typeof parsed === 'object' ? parsed : {});
  } catch (error) {
    // Zachovej původní text kvůli zpětné kompatibilitě; frontend umí
    // neplatný JSON bezpečně ignorovat.
    return text;
  }
}

function safeJsonStringify_(value) {
  try {
    return JSON.stringify(value === undefined ? {} : value);
  } catch (error) {
    return '{}';
  }
}

function normalizeDateCell_(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeValue_(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return '';
  return value;
}

function parseDateMs_(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return isNaN(time) ? 0 : time;
}

function finiteNumberOr_(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function uniqueStrings_(values) {
  const result = [];
  const seen = new Set();
  values.map(orderItemText_).filter(Boolean).forEach(value => {
    const key = normalizeOrderItemKey_(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(value);
  });
  return result;
}

function isOperationalType_(type) {
  return ['reminder', 'tip', 'info', 'alert'].includes(String(type || '').toLowerCase());
}

function isCompletedLikeStatus_(status) {
  return ['completed', 'done', 'resolved', 'closed', 'hotovo'].includes(String(status || '').toLowerCase());
}

function isCancelledLikeStatus_(status) {
  return ['cancelled', 'canceled', 'zruseno', 'zrušeno'].includes(String(status || '').toLowerCase());
}

function normalizeTextKey_(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function selectorDescription_(selector) {
  if (selector && typeof selector === 'object') return safeJsonStringify_(selector);
  return String(selector === null || selector === undefined ? '' : selector);
}

function sanitizeIdPart_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || String(Date.now());
}

function formatErrorMessage_(error) {
  if (!error) return 'Neznámá chyba.';
  return String(error.message || error).slice(0, 1000);
}

function clearCurrentServiceLogCommand_(store, payload, nowIso) {
  const serviceId = normalizeServiceId_(payload.service_id || payload.serviceId, getPragueServiceId_(new Date(nowIso)));
  return { changed: false, skipOrderAudit: true, serviceId, ...store.clearLog(serviceId) };
}
function clearAllOrderLogsCommand_(store, payload, nowIso) {
  if (!(payload && (payload.confirm === true || payload.confirm_all === true || payload.confirmAll === true))) {
    throw new Error('clear_all_order_logs vyžaduje explicitní payload.confirm = true.');
  }
  return { changed: false, skipOrderAudit: true, ...store.clearLog(), clearedAt: nowIso };
}

export { canonicalCommandAction_, isOrderLogClearAction_, applyCommandToItems_, upsertOneItem_, patchOneItem_, setOneItemStatus_, completeOrderCommand_, cancelOrderCommand_, completeOrderAtIndex_, reopenOrderCommand_, reopenOrderAtIndex_, setOrderItemStatesCommand_, cancelOrderAtIndex_, serveOrderItemsCommand_, completeCardCommand_, completeCardAtIndex_, deleteItemCommand_, attachCardCommand_, detachCardCommand_, clearDisplayCommand_, clearChannelCommand_, applyDisplaySwipe_, resolveSingleItemIndex_, normalizeSelector_, extractOrderNumber_, completeActiveChildrenForOrder_, getParentOrderId_, getPendingOrderItems_, getServedOrderItems_, orderItemText_, normalizeRequestedItems_, findRequestedOrderItemIndex_, normalizeOrderItemKey_, normalizeOrderItemStateKey_, stripOrderLineQuantity_, createOrderCompletionUndoSnapshot_, ensureOrderItemStateArrays_, getAllOrderItems_, sameStringSet_, canonicalItemTypeForServer_, getMainOrderStatusForAudit_, getCommandSource_, normalizeServiceId_, deriveOrderAuditMutation_, orderMapFromItems_, orderItemKeyMap_, orderEditableFingerprint_, makeOrderEvent_, makeArchiveUpdate_, updateOrderArchiveRecord_, extractOrderTotalPrice_, extractOrderCustomerOrTable_, buildOrderReceiptSubtitle_, stripOrderReceiptSubtitlePrefix_, getPragueServiceId_, cloneItems_, normalizeItemRecord_, defaultStatusForType_, nextSortValue_, normalizeExpectedTypes_, parsePayloadObject_, parseDataObject_, normalizeDataJsonCell_, safeJsonStringify_, normalizeDateCell_, normalizeValue_, parseDateMs_, finiteNumberOr_, uniqueStrings_, isOperationalType_, isCompletedLikeStatus_, isCancelledLikeStatus_, normalizeTextKey_, selectorDescription_, sanitizeIdPart_, formatErrorMessage_, ITEM_HEADERS, ORDER_ARCHIVE_HEADERS };
