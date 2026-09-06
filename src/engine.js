// Display App v17.2. V16.5 command/gesture/audit parity plus server numbering and structured orders.
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
  'pricing_status',
  'known_subtotal',
  'customer_or_table',
  'recipient_type',
  'recipient_value',
  'fulfillment_type',
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
      return upsertOneItem_(items, payload.item || payload, command.commandId, nowIso, activeChannel, ss);

    case 'upsert_items': {
      const source = Array.isArray(payload.items) ? payload.items : [];
      if (!source.length) throw new Error('upsert_items vyžaduje neprázdné pole payload.items.');

      const ids = [];
      const itemResults = [];
      let changed = false;
      source.forEach((item, index) => {
        const result = upsertOneItem_(items, item, command.commandId + '-' + (index + 1), nowIso, activeChannel, ss);
        ids.push(result.itemId);
        itemResults.push(result);
        changed = changed || result.changed;
      });
      const response = { changed, itemIds: ids };
      if (itemResults.some(result => Number.isFinite(result.orderNumber))) response.items = itemResults;
      return response;
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

function upsertOneItem_(items, source, fallbackId, nowIso, activeChannel, store) {
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

  let assignedOrderIdentity = null;
  if (type === 'order') {
    const previousOrderData = existingIndex >= 0 ? parseDataObject_(existing.data_json) : {};
    const orderData = parseDataObject_(merged.data_json);
    if (existingIndex < 0) {
      orderData.received_at = nowIso;
      orderData.service_id = getPragueServiceId_(new Date(nowIso));
    }
    normalizeOrderStructure_(merged, orderData, previousOrderData);
    if (existingIndex < 0) {
      // The production store owns operational numbering. The pure engine keeps
      // its old behavior when no real store is supplied (golden parity tests).
      if (store && typeof store.getMeta === 'function' && typeof store.setMeta === 'function') {
        assignedOrderIdentity = assignOperationalOrderIdentity_(items, merged, store);
        orderData.order_number = assignedOrderIdentity.orderNumber;
        orderData.operational_series_id = assignedOrderIdentity.seriesId;
        merged.title = buildOrderTitle_(orderData, assignedOrderIdentity.orderNumber);
      }
      // Čas přijetí už nepřipravuje ChatGPT. Backend ho vytvoří sám a
      // případný kontext (stůl, jméno, box) zachová za oddělovačem.
      merged.subtitle = buildOrderReceiptSubtitle_(merged.subtitle, orderData, nowIso);
    }
    merged.data_json = safeJsonStringify_(orderData);
  }

  const normalized = normalizeItemRecord_(merged);
  if (existingIndex >= 0) items[existingIndex] = normalized;
  else items.push(normalized);

  return {
    changed: true,
    itemId,
    operation: existingIndex >= 0 ? 'updated' : 'created',
    ...(assignedOrderIdentity ? {
      orderNumber: assignedOrderIdentity.orderNumber,
      operationalSeriesId: assignedOrderIdentity.seriesId
    } : {})
  };
}

function patchOneItem_(items, commandTarget, payload, nowIso) {
  const selector = payload.selector || payload.target || commandTarget;
  const index = resolveSingleItemIndex_(items, selector, {
    expectedTypes: payload.expected_types || payload.expectedTypes || payload.expected_type || payload.expectedType,
    allowFuzzy: Boolean(payload.allow_fuzzy || payload.allowFuzzy)
  });

  const rawPatch = payload.patch ?? payload.fields;
  const dataPatch = payload.data_json_patch || payload.dataJsonPatch;
  const clearFields = Array.isArray(payload.clear_fields) ? payload.clear_fields : [];
  if (rawPatch !== undefined && (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch))) {
    throw new Error('payload.patch musí být objekt.');
  }
  if (dataPatch !== undefined && (!dataPatch || typeof dataPatch !== 'object' || Array.isArray(dataPatch))) {
    throw new Error('payload.data_json_patch musí být objekt.');
  }
  const patch = rawPatch || {};
  if (!Object.keys(patch).length && !dataPatch && !clearFields.length) {
    throw new Error('patch_item vyžaduje patch, data_json_patch nebo clear_fields.');
  }

  const item = Object.assign({}, items[index]);
  const previousOrderData = canonicalItemTypeForServer_(item.type) === 'order'
    ? parseDataObject_(item.data_json)
    : null;
  const allowed = new Set(ITEM_HEADERS);
  Object.keys(patch).forEach(key => {
    if (!allowed.has(key)) return;
    item[key] = patch[key];
  });

  if (patch.data_json && typeof patch.data_json === 'object') {
    item.data_json = safeJsonStringify_(patch.data_json);
  }

  if (dataPatch && typeof dataPatch === 'object' && !Array.isArray(dataPatch)) {
    const data = parseDataObject_(item.data_json);
    Object.keys(dataPatch).forEach(key => {
      if (dataPatch[key] === null) delete data[key];
      else data[key] = dataPatch[key];
    });
    item.data_json = safeJsonStringify_(data);
  }

  clearFields.forEach(key => {
    if (allowed.has(key) && key !== 'id') item[key] = '';
  });

  if (canonicalItemTypeForServer_(item.type) === 'order') {
    const orderData = parseDataObject_(item.data_json);
    normalizeOrderStructure_(item, orderData, previousOrderData || {});
    const orderNumber = extractOrderNumber_({ ...item, data_json: safeJsonStringify_(orderData) });
    if (orderData.recipient && Number.isFinite(orderNumber)) {
      item.title = buildOrderTitle_(orderData, orderNumber);
    }
    if (orderData.recipient || orderData.fulfillment) {
      item.subtitle = buildOrderReceiptSubtitle_(item.subtitle, orderData, orderData.received_at || item.created_at || nowIso);
    }
    item.data_json = safeJsonStringify_(orderData);
  }

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
  if (hasStructuredOrderItems_(data)) {
    data.order_items = data.order_items.map(value => ({ ...value, status: 'served' }));
    syncStructuredOrderMirrors_(item, data);
  } else {
    const served = getServedOrderItems_(data);
    data.served_items = uniqueStrings_(served.concat(pending));
    data.pending_items = [];
  }
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
    if (hasStructuredOrderItems_(restoredData)) {
      restoredData.order_items = restoredData.order_items.map(value => ({ ...value, status: 'waiting' }));
      syncStructuredOrderMirrors_(item, restoredData);
    } else {
      const allItems = getAllOrderItems_(item, restoredData);
      restoredData.served_items = [];
      restoredData.pending_items = allItems;
    }
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
  syncStructuredOrderStatuses_(item, data, nextServed);
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
  if (hasStructuredOrderItems_(data)) {
    const pendingItems = data.order_items.filter(value => String(value.status || 'waiting').toLowerCase() !== 'served');
    const toServe = new Set();
    requested.forEach(request => {
      const wanted = normalizeOrderItemKey_(request.name);
      const matches = pendingItems.filter(value => normalizeOrderItemKey_(value.name) === wanted ||
        (normalizeOrderItemKey_(value.name) && wanted && (normalizeOrderItemKey_(value.name).includes(wanted) || wanted.includes(normalizeOrderItemKey_(value.name)))));
      if (matches.length !== 1) throw new Error('Položka nebyla jednoznačně nalezena v čekající části objednávky: ' + request.name);
      const match = matches[0];
      if (request.quantity > 1 && Number(match.quantity) !== request.quantity) {
        throw new Error('Množství neodpovídá logické položce objednávky: ' + request.name);
      }
      toServe.add(String(match.id));
    });
    data.order_items = data.order_items.map(value => toServe.has(String(value.id)) ? { ...value, status: 'served' } : value);
    syncStructuredOrderMirrors_(item, data);
    item.updated_at = nowIso;
    item.data_json = safeJsonStringify_(data);
    items[index] = normalizeItemRecord_(item);
    const remaining = getPendingOrderItems_(items[index], data);
    if (!remaining.length && payload.complete_when_empty !== false && payload.completeWhenEmpty !== false) {
      return completeOrderAtIndex_(items, index, nowIso, { undoSnapshot });
    }
    return {
      changed: true,
      itemId: item.id,
      servedItems: data.order_items.filter(value => toServe.has(String(value.id))).map(structuredOrderItemStateText_),
      remainingItems: remaining
    };
  }
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
  syncStructuredOrderStatuses_(item, data, data.served_items);
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

function hasStructuredOrderItems_(data) {
  return Boolean(data && Array.isArray(data.order_items));
}

function normalizeOrderStructure_(item, data, previousData) {
  const previous = previousData && typeof previousData === 'object' ? previousData : {};

  if (Object.prototype.hasOwnProperty.call(data, 'recipient')) {
    data.recipient = normalizeRecipient_(data.recipient);
    data.customer_or_table = recipientDisplay_(data.recipient);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'fulfillment')) {
    data.fulfillment = normalizeFulfillment_(data.fulfillment);
  }

  if (Object.prototype.hasOwnProperty.call(data, 'order_items')) {
    if (!Array.isArray(data.order_items) || !data.order_items.length) {
      throw new Error('data.order_items musí být neprázdné pole.');
    }
    data.order_items = normalizeStructuredOrderItems_(String(item.id || ''), data.order_items, previous.order_items);
    syncStructuredOrderMirrors_(item, data);
  } else {
    ensureOrderItemStateArrays_(item, data);
  }
}

function normalizeRecipient_(source) {
  if (source === null || source === undefined || source === '') return { type: 'none', value: '' };
  if (typeof source === 'string') return { type: 'person', value: source.trim() };
  if (typeof source !== 'object' || Array.isArray(source)) throw new Error('recipient musí být objekt.');

  const rawType = normalizeTextKey_(source.type || source.kind || source.recipient_type || source.recipientType || 'none')
    .replace(/\s+/g, '_');
  const aliases = {
    table: 'table', stul: 'table',
    person: 'person', osoba: 'person', customer: 'person', zakaznik: 'person',
    none: 'none', zadny: 'none', bez_prijemce: 'none'
  };
  const type = aliases[rawType] || rawType;
  if (!['table', 'person', 'none'].includes(type)) throw new Error('Neznámý recipient.type: ' + type);

  let value = String(source.value ?? source.name ?? source.label ?? '').trim();
  if (type === 'table') value = value.replace(/^st(?:ů|u)l\s+/i, '').trim();
  if (type !== 'none' && !value) throw new Error('recipient.value je povinné pro table/person.');
  if (type === 'none') value = '';
  return { type, value };
}

function recipientDisplay_(recipient) {
  if (!recipient || typeof recipient !== 'object') return '';
  const type = String(recipient.type || '').toLowerCase();
  const value = String(recipient.value || '').trim();
  if (!value || type === 'none') return '';
  if (type === 'table') return /^st(?:ů|u)l\s+/i.test(value) ? value : 'stůl ' + value;
  return value;
}

function normalizeFulfillment_(source) {
  if (source === null || source === undefined || source === '') return { type: 'unspecified' };
  const raw = typeof source === 'string' ? source : source && typeof source === 'object' ? (source.type || source.kind || source.mode || '') : '';
  const key = normalizeTextKey_(raw).replace(/[\s-]+/g, '_');
  const aliases = {
    '': 'unspecified', unspecified: 'unspecified', neurceno: 'unspecified',
    dine_in: 'dine_in', here: 'dine_in', na_miste: 'dine_in',
    takeaway: 'takeaway', take_away: 'takeaway', s_sebou: 'takeaway', sebou: 'takeaway',
    box: 'box', do_boxu: 'box'
  };
  const type = aliases[key] || key;
  if (!['unspecified', 'dine_in', 'takeaway', 'box'].includes(type)) throw new Error('Neznámý fulfillment.type: ' + type);
  return { type };
}

function fulfillmentDisplay_(fulfillment) {
  const type = String(fulfillment && fulfillment.type || '').toLowerCase();
  if (type === 'takeaway') return 's sebou';
  if (type === 'box') return 'do boxu';
  return '';
}

function buildOrderContext_(data) {
  const parts = [];
  const recipient = recipientDisplay_(data && data.recipient);
  const fulfillment = fulfillmentDisplay_(data && data.fulfillment);
  if (recipient) parts.push(recipient);
  if (fulfillment) parts.push(fulfillment);
  return parts.join(' · ');
}

function buildOrderTitle_(data, orderNumber) {
  const explicit = recipientDisplay_(data && data.recipient);
  let legacy = '';
  if (!explicit) {
    legacy = String(
      data && (data.table || data.table_name || data.tableName || data.customer || data.customer_name ||
      data.customerName || data.person || data.name || data.customer_or_table || data.customerOrTable) || ''
    ).trim();
  }
  const recipient = explicit || legacy;
  return 'Objednávka ' + orderNumber + (recipient ? ' - ' + recipient : '');
}

function assignOperationalOrderIdentity_(items, item, store) {
  const channel = String(item.channel || 'main');
  const metaKey = 'operational_series:' + channel;
  const waiting = items.filter(value =>
    canonicalItemTypeForServer_(value && value.type) === 'order' &&
    String(value.channel || 'main') === channel &&
    getMainOrderStatusForAudit_(value.status) === 'waiting'
  );

  if (!waiting.length) {
    const state = { id: 'series-' + crypto.randomUUID(), next_number: 2 };
    store.setMeta(metaKey, state);
    return { orderNumber: 1, seriesId: state.id };
  }

  let state = store.getMeta(metaKey, null);
  if (!state || typeof state !== 'object' || !String(state.id || '') || !Number.isInteger(Number(state.next_number))) {
    const times = waiting.map(value => Date.parse(value.created_at || value.updated_at || '')).filter(Number.isFinite);
    const earliest = times.length ? Math.min(...times) : -Infinity;
    const candidates = items.filter(value => {
      if (canonicalItemTypeForServer_(value && value.type) !== 'order' || String(value.channel || 'main') !== channel) return false;
      const at = Date.parse(value.created_at || value.updated_at || '');
      return !Number.isFinite(at) || at >= earliest;
    });
    const maxNumber = Math.max(0, ...candidates.map(extractOrderNumber_).filter(Number.isFinite));
    const existingSeries = candidates.map(value => parseDataObject_(value.data_json).operational_series_id).filter(Boolean).pop();
    state = { id: String(existingSeries || 'series-' + crypto.randomUUID()), next_number: Math.max(1, maxNumber + 1) };
  } else {
    state = { id: String(state.id), next_number: Math.max(1, Number(state.next_number) || 1) };
    const sameSeriesMax = Math.max(0, ...items
      .filter(value => canonicalItemTypeForServer_(value && value.type) === 'order' && String(value.channel || 'main') === channel)
      .filter(value => String(parseDataObject_(value.data_json).operational_series_id || '') === state.id)
      .map(extractOrderNumber_).filter(Number.isFinite));
    state.next_number = Math.max(state.next_number, sameSeriesMax + 1);
  }

  const orderNumber = state.next_number;
  state.next_number = orderNumber + 1;
  store.setMeta(metaKey, state);
  return { orderNumber, seriesId: state.id };
}

function normalizeStructuredOrderItems_(orderId, sourceItems, previousItems) {
  const previous = Array.isArray(previousItems) ? previousItems : [];
  const previousById = new Map(previous.filter(Boolean).map(value => [String(value.id || ''), value]).filter(entry => entry[0]));
  const previousByName = new Map();
  previous.forEach(value => {
    const key = normalizeOrderItemStateKey_(value && value.name || '');
    if (key && !previousByName.has(key)) previousByName.set(key, value);
  });
  const usedIds = new Set();

  return sourceItems.map((raw, index) => {
    const source = typeof raw === 'string' ? { name: raw } : raw;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Každá order_items položka musí být objekt nebo text.');
    const name = String(source.name || source.text || source.title || '').trim();
    if (!name) throw new Error('order_items[' + index + '].name je povinné.');

    const requestedId = String(source.id || '').trim();
    const matchedPrevious = (requestedId && previousById.get(requestedId)) || previousByName.get(normalizeOrderItemStateKey_(name)) || {};
    const merged = { ...matchedPrevious, ...source };
    let id = String(merged.id || '').trim();
    if (!id) id = 'oi-' + sanitizeIdPart_(orderId || 'order') + '-' + crypto.randomUUID();
    if (usedIds.has(id)) throw new Error('Duplicitní order_items.id: ' + id);
    usedIds.add(id);

    const quantityNumber = Number(merged.quantity ?? merged.qty ?? 1);
    if (!Number.isInteger(quantityNumber) || quantityNumber < 1) throw new Error('order_items[' + index + '].quantity musí být celé číslo >= 1.');

    const rawStatus = String(merged.status || 'waiting').trim().toLowerCase();
    const status = rawStatus === 'served' || isCompletedLikeStatus_(rawStatus) ? 'served' : 'waiting';

    const rawPricingStatus = merged.pricing_status ?? merged.pricingStatus ?? (merged.pricing && merged.pricing.status);
    const rawUnit = merged.unit_price ?? merged.unitPrice ?? (merged.pricing && merged.pricing.unit_price);
    const rawTotal = merged.total_price ?? merged.totalPrice ?? (merged.pricing && merged.pricing.total_price);
    const rawBasis = merged.price_basis ?? merged.priceBasis ?? (merged.pricing && merged.pricing.basis);
    const inferredStatus = merged.free === true ? 'free' :
      (rawPricingStatus !== undefined && rawPricingStatus !== null && rawPricingStatus !== '' ? rawPricingStatus :
      (rawUnit !== undefined && rawUnit !== null && rawUnit !== '' || rawTotal !== undefined && rawTotal !== null && rawTotal !== '' ? 'known' : 'unknown'));
    const pricingStatus = normalizePricingStatus_(inferredStatus);
    let unitPrice = parseMoneyOrNull_(rawUnit, 'unit_price');
    let totalPrice = parseMoneyOrNull_(rawTotal, 'total_price');
    let priceBasis = normalizeTextKey_(rawBasis || '').replace(/[\s-]+/g, '_');

    if (pricingStatus === 'free') {
      priceBasis = 'total';
      unitPrice = 0;
      totalPrice = 0;
    } else if (pricingStatus === 'unknown') {
      priceBasis = 'unknown';
      unitPrice = null;
      totalPrice = null;
    } else {
      if (priceBasis && !['unit', 'total'].includes(priceBasis)) throw new Error('price_basis musí být unit nebo total.');
      if (!priceBasis) {
        if (unitPrice !== null && totalPrice !== null) {
          if (!moneyEqual_(roundMoney_(unitPrice * quantityNumber), totalPrice)) {
            throw new Error('Cena položky je nejednoznačná: určete price_basis unit/total.');
          }
          priceBasis = 'unit';
        } else if (unitPrice !== null) priceBasis = 'unit';
        else if (totalPrice !== null) priceBasis = 'total';
        else throw new Error('pricing_status known vyžaduje unit_price nebo total_price.');
      }
      if (priceBasis === 'unit') {
        if (unitPrice === null) throw new Error('price_basis unit vyžaduje unit_price.');
        const calculated = roundMoney_(unitPrice * quantityNumber);
        if (totalPrice !== null && !moneyEqual_(calculated, totalPrice)) throw new Error('total_price neodpovídá unit_price × quantity.');
        totalPrice = calculated;
      } else {
        if (totalPrice === null) throw new Error('price_basis total vyžaduje total_price.');
      }
    }

    const normalized = {
      id,
      name,
      quantity: quantityNumber,
      status,
      pricing_status: pricingStatus,
      price_basis: priceBasis,
      unit_price: unitPrice,
      total_price: totalPrice
    };
    if (merged.note !== undefined && merged.note !== null && String(merged.note).trim()) normalized.note = String(merged.note).trim();
    return normalized;
  });
}

function normalizePricingStatus_(value) {
  const key = normalizeTextKey_(value).replace(/[\s-]+/g, '_');
  const aliases = { known: 'known', znama: 'known', unknown: 'unknown', neznamá: 'unknown', neznama: 'unknown', free: 'free', zdarma: 'free' };
  const status = aliases[key] || key;
  if (!['known', 'unknown', 'free'].includes(status)) throw new Error('Neznámý pricing_status: ' + status);
  return status;
}

function parseMoneyOrNull_(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/\s*kč\s*$/i, '').replace(',', '.').trim() : value;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) throw new Error(label + ' musí být nezáporné číslo.');
  return roundMoney_(number);
}

function roundMoney_(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function moneyEqual_(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

function formatMoney_(value) {
  const number = roundMoney_(value);
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}

function renderStructuredOrderItemLine_(value, includeQuantity) {
  if (!value || typeof value !== 'object') return '';
  const name = String(value.name || '').trim();
  if (!name) return '';
  const quantity = Math.max(1, Number(value.quantity) || 1);
  const prefix = includeQuantity && quantity > 1 ? quantity + '× ' : '';
  let suffix = '';
  if (value.pricing_status === 'free') suffix = ' – 0 Kč';
  else if (value.pricing_status === 'unknown') suffix = ' – cena neznámá';
  else if (value.total_price !== null && value.total_price !== undefined && value.total_price !== '') suffix = ' – ' + formatMoney_(value.total_price) + ' Kč';
  return prefix + name + suffix;
}

function structuredOrderItemStateText_(value) {
  return renderStructuredOrderItemLine_(value, false);
}

function syncStructuredOrderMirrors_(item, data) {
  if (!hasStructuredOrderItems_(data)) return;
  data.served_items = uniqueStrings_(data.order_items
    .filter(value => String(value.status || '').toLowerCase() === 'served')
    .map(structuredOrderItemStateText_).filter(Boolean));
  data.pending_items = uniqueStrings_(data.order_items
    .filter(value => String(value.status || 'waiting').toLowerCase() !== 'served')
    .map(structuredOrderItemStateText_).filter(Boolean));
  item.body = data.order_items.map(value => renderStructuredOrderItemLine_(value, true)).filter(Boolean).join('\n');
  recomputeOrderPricing_(data);
}

function syncStructuredOrderStatuses_(item, data, servedValues) {
  if (!hasStructuredOrderItems_(data)) return;
  const selected = new Set((Array.isArray(servedValues) ? servedValues : []).map(normalizeOrderItemStateKey_).filter(Boolean));
  data.order_items = data.order_items.map(value => ({
    ...value,
    status: selected.has(normalizeOrderItemStateKey_(structuredOrderItemStateText_(value))) ? 'served' : 'waiting'
  }));
  syncStructuredOrderMirrors_(item, data);
}

function recomputeOrderPricing_(data) {
  if (!hasStructuredOrderItems_(data)) return;
  let override = data.pricing_override;
  if (!override && data.pricing && typeof data.pricing === 'object' && String(data.pricing.source || '').toLowerCase() === 'override') {
    override = data.pricing;
  }
  if (!override && Object.prototype.hasOwnProperty.call(data, 'total_price_override')) {
    override = { status: 'known', total_price: data.total_price_override };
  }

  const knownSubtotal = roundMoney_(data.order_items.reduce((sum, value) => {
    if (value.pricing_status === 'known' || value.pricing_status === 'free') return sum + Number(value.total_price || 0);
    return sum;
  }, 0));
  const hasUnknown = data.order_items.some(value => value.pricing_status === 'unknown');
  const allFree = data.order_items.length > 0 && data.order_items.every(value => value.pricing_status === 'free');

  let pricing;
  if (override !== undefined && override !== null && override !== '') {
    const source = typeof override === 'object' && !Array.isArray(override) ? override : { status: 'known', total_price: override };
    const status = normalizePricingStatus_(source.status || source.pricing_status || (source.free === true ? 'free' : 'known'));
    let total = parseMoneyOrNull_(source.total_price ?? source.totalPrice ?? source.value, 'pricing_override.total_price');
    if (status === 'known' && total === null) throw new Error('pricing_override known vyžaduje total_price.');
    if (status === 'free') total = 0;
    if (status === 'unknown') total = null;
    data.pricing_override = { status, total_price: total };
    pricing = { status, total_price: total, known_subtotal: status === 'unknown' ? knownSubtotal : Number(total || 0), source: 'override' };
  } else {
    const status = hasUnknown ? 'unknown' : allFree ? 'free' : 'known';
    pricing = { status, total_price: hasUnknown ? null : knownSubtotal, known_subtotal: knownSubtotal, source: 'calculated' };
    delete data.pricing_override;
  }

  data.pricing = pricing;
  data.pricing_status = pricing.status;
  data.known_subtotal = pricing.known_subtotal;
  data.total_price = pricing.total_price === null ? '' : pricing.total_price;
}

function getPendingOrderItems_(item, data) {
  if (hasStructuredOrderItems_(data)) {
    return data.order_items
      .filter(value => String(value && value.status || 'waiting').toLowerCase() !== 'served')
      .map(structuredOrderItemStateText_)
      .filter(Boolean);
  }

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
  if (hasStructuredOrderItems_(data)) {
    return data.order_items
      .filter(value => String(value && value.status || '').toLowerCase() === 'served')
      .map(structuredOrderItemStateText_)
      .filter(Boolean);
  }

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
  if (hasStructuredOrderItems_(data)) {
    syncStructuredOrderMirrors_(item, data);
    return;
  }
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
  if (hasStructuredOrderItems_(data)) {
    return data.order_items.map(structuredOrderItemStateText_).filter(Boolean);
  }
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
  if (Array.isArray(copy.order_items)) {
    copy.order_items = copy.order_items.map(value => {
      if (!value || typeof value !== 'object') return value;
      const next = { ...value };
      delete next.status;
      return next;
    });
  }
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
    pricing_status: extractOrderPricingStatus_(data),
    known_subtotal: extractOrderKnownSubtotal_(data),
    customer_or_table: extractOrderCustomerOrTable_(item, data),
    recipient_type: extractOrderRecipient_(data).type,
    recipient_value: extractOrderRecipient_(data).value,
    fulfillment_type: extractOrderFulfillmentType_(data),
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
  if (data && data.pricing && typeof data.pricing === 'object') {
    const status = String(data.pricing.status || '').toLowerCase();
    const total = data.pricing.total_price;
    if ((status === 'known' || status === 'free') && total !== null && total !== undefined && total !== '') return String(total);
    if (status === 'unknown') return '';
  }
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

function extractOrderPricingStatus_(data) {
  if (data && data.pricing && typeof data.pricing === 'object' && data.pricing.status) return String(data.pricing.status);
  if (data && data.pricing_status) return String(data.pricing_status);
  const total = data && (data.total_price ?? data.totalPrice ?? data.price_total ?? data.priceTotal);
  if (total === 0 || total === '0') return 'free';
  return total === null || total === undefined || total === '' ? '' : 'known';
}

function extractOrderKnownSubtotal_(data) {
  if (data && data.pricing && typeof data.pricing === 'object' && data.pricing.known_subtotal !== undefined && data.pricing.known_subtotal !== null) {
    return String(data.pricing.known_subtotal);
  }
  if (data && data.known_subtotal !== undefined && data.known_subtotal !== null && data.known_subtotal !== '') return String(data.known_subtotal);
  return '';
}

function extractOrderRecipient_(data) {
  if (data && data.recipient && typeof data.recipient === 'object') {
    return {
      type: String(data.recipient.type || ''),
      value: String(data.recipient.value || '')
    };
  }
  const table = data && (data.table || data.table_name || data.tableName);
  if (table) return { type: 'table', value: String(table) };
  const person = data && (data.customer || data.customer_name || data.customerName || data.person || data.name);
  if (person) return { type: 'person', value: String(person) };
  return { type: '', value: '' };
}

function extractOrderFulfillmentType_(data) {
  if (data && data.fulfillment && typeof data.fulfillment === 'object') return String(data.fulfillment.type || '');
  if (data && typeof data.fulfillment === 'string') return String(data.fulfillment);
  return '';
}

function extractOrderCustomerOrTable_(item, data) {
  const structured = recipientDisplay_(data && data.recipient);
  if (structured) return structured;
  const explicit = data.table || data.table_name || data.tableName || data.customer || data.customer_name ||
    data.customerName || data.person || data.name || data.customer_or_table || data.customerOrTable;
  return String(explicit || stripOrderReceiptSubtitlePrefix_(item.subtitle) || '');
}

function buildOrderReceiptSubtitle_(subtitle, data, nowIso) {
  let context = buildOrderContext_(data);
  if (!context) context = stripOrderReceiptSubtitlePrefix_(subtitle);
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
