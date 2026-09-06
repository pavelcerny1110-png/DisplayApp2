import * as E from './engine.js';
import { DEFAULT_SETTINGS, VERSION } from './settings.js';

const emptyReport = () => ({ processed: 0, errors: [], busy: false });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const messageOf = error => String(error && error.message || error).slice(0, 1000);
export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class KitchenApi {
  constructor(store) { this.store = store; }
  snapshot(commandReport = emptyReport()) {
    const settings = { ...DEFAULT_SETTINGS, ...this.store.getMeta('settings', {}) };
    const activeChannel = String(settings.active_channel || 'main');
    const now = Date.now();
    const items = this.store.items().filter(item => {
      if (!item.id || (item.channel && item.channel !== activeChannel)) return false;
      const expiry = item.expires_at ? Date.parse(item.expires_at) : NaN;
      return !(Number.isFinite(expiry) && expiry < now);
    }).sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || (Number(b.priority) || 0) - (Number(a.priority) || 0));
    return {
      settings, activeChannel, items, commandReport,
      syncState: {
        manualRevision: Number(this.store.getMeta('manual_revision', 0)),
        lastManualEventAt: String(this.store.getMeta('last_manual_event_at', '')),
        currentServiceId: E.getPragueServiceId_(new Date()),
        revision: Number(this.store.getMeta('revision', 0))
      },
      serverTime: new Date().toISOString(), version: VERSION
    };
  }
  log(serviceId) {
    const resolved = E.normalizeServiceId_(serviceId, E.getPragueServiceId_(new Date()));
    if (resolved.length > 200) throw new InputError('service_id je příliš dlouhé.');
    return { serviceId: resolved, ...this.store.readLog(resolved), commandReport: emptyReport(), serverTime: new Date().toISOString(), version: VERSION };
  }
  commands(input) {
    if (!isObject(input)) throw new InputError('Požadavek musí být JSON objekt.');
    const batch = Object.hasOwn(input, 'commands') ? input.commands : [input];
    if (!Array.isArray(batch) || !batch.length || batch.length > 100) throw new InputError('commands musí obsahovat 1 až 100 příkazů.');
    const rawExpectedRevision = input.expected_revision ?? input.expectedRevision;
    let expectedRevision = null;
    if (rawExpectedRevision !== undefined && rawExpectedRevision !== null && rawExpectedRevision !== '') {
      const parsed = Number(rawExpectedRevision);
      if (!Number.isInteger(parsed) || parsed < 0) throw new InputError('expected_revision musí být nezáporné celé číslo.');
      expectedRevision = parsed;
    }
    // Validate the envelope BEFORE accepting any part of the request.
    const commands = batch.map(raw => {
      if (!isObject(raw) || typeof raw.action !== 'string' || !raw.action.trim()) throw new InputError('Každý příkaz musí mít action.');
      const id = String(raw.command_id || raw.commandId || 'cmd-' + crypto.randomUUID()).trim();
      if (!id || id.length > 200) throw new InputError('command_id musí mít 1 až 200 znaků.');
      let payload;
      try { payload = E.parsePayloadObject_(raw.payload ?? raw.payload_json ?? {}); }
      catch (error) { throw new InputError(messageOf(error)); }
      return { commandId: id, action: E.canonicalCommandAction_(raw.action), target: raw.target, payload };
    });
    this.store.atomic(() => this.store.cleanupCommands());
    // A stale conditional write is rejected before any new command is accepted.
    // Duplicate-only retries remain readable even with an old revision so a
    // network retry of the same command_id can safely learn its original result.
    const hasNewCommand = commands.some(command => !this.store.command(command.commandId));
    const currentRevision = Number(this.store.getMeta('revision', 0));
    if (expectedRevision !== null && hasNewCommand && expectedRevision !== currentRevision) {
      const report = emptyReport();
      return {
        ok: false,
        conflict: true,
        busy: false,
        message: 'Backend se mezitím změnil. Načtěte vrácený snapshot a příkaz sestavte znovu.',
        expectedRevision,
        currentRevision,
        results: [],
        commandReport: report,
        data: this.snapshot(report)
      };
    }
    // Only not-yet-accepted commands can form a clear barrier. A duplicate clear
    // is genuinely a no-op, including when retried alongside other commands.
    let barrier = -1;
    const seen = new Set();
    commands.forEach((command, index) => {
      if (seen.has(command.commandId) || this.store.command(command.commandId)) return;
      seen.add(command.commandId);
      if (command.action === 'clear_display' || command.action === 'clear_display_and_current_service_log') barrier = index;
    });
    const results = [];
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      const prior = this.store.command(command.commandId);
      if (prior) {
        results.push({ ...prior, status: 'duplicate', originalStatus: prior.status });
        continue;
      }
      if (index < barrier) {
        results.push(this.store.atomic(() => {
          const result = { commandId: command.commandId, action: command.action, status: 'superseded', processedAt: this.store.nextTimestamp(), result: { reason: 'Přeskočeno kvůli novějšímu vyčištění displeje.' } };
          this.store.rememberCommand(result);
          return result;
        }));
        continue;
      }
      try {
        results.push(this.store.atomic(() => {
          const now = this.store.nextTimestamp();
          const before = this.store.items();
          const items = E.cloneItems_(before);
          const channel = String(this.store.getMeta('settings', {}).active_channel || DEFAULT_SETTINGS.active_channel);
          const result = E.applyCommandToItems_(items, command, command.payload, now, channel, this.store);
          if (result.changed) this.store.writeItems(items);
          if (!result.skipOrderAudit) {
            this.store.audit([E.deriveOrderAuditMutation_(before, items, {
              action: command.action, source: E.getCommandSource_(command.payload), occurredAt: now,
              commandId: command.commandId, details: result
            })]);
          }
          if (result.changed || result.skipOrderAudit) this.store.bumpRevision(now);
          const entry = { commandId: command.commandId, action: command.action, status: 'processed', processedAt: now, result };
          this.store.rememberCommand(entry);
          return entry;
        }));
      } catch (error) {
        // The entire individual command was rolled back, including its archive.
        // Remember the rejection, so retrying a batch cannot rerun it accidentally.
        const entry = this.store.atomic(() => {
          const rejected = { commandId: command.commandId, action: command.action, status: 'error', processedAt: this.store.nextTimestamp(), error: messageOf(error) };
          this.store.rememberCommand(rejected);
          return rejected;
        });
        results.push(entry);
      }
    }
    const errors = results.filter(result => result.status === 'error' || result.originalStatus === 'error')
      .map(result => ({ commandId: result.commandId, action: result.action, error: result.error }));
    const report = { processed: results.filter(result => result.status === 'processed').length, errors, busy: false };
    return { ok: !errors.length, busy: false, results, commandReport: report, data: this.snapshot(report) };
  }
  action(input) {
    if (!isObject(input)) throw new InputError('Požadavek musí být JSON objekt.');
    try {
      return this.store.atomic(() => {
        const items = this.store.items();
        const id = String(input.item_id || input.itemId || '').trim();
        const index = items.findIndex(item => String(item.id) === id);
        const conflict = message => ({ ok: false, conflict: true, busy: false, message, data: this.snapshot() });
        if (index < 0) return conflict('Karta už na serveru neexistuje.');
        const current = items[index];
        const expectedAt = String(input.expected_updated_at || input.expectedUpdatedAt || '');
        const expectedStatus = String(input.expected_status || input.expectedStatus || '').toLowerCase();
        if ((expectedAt && current.updated_at !== expectedAt) || (expectedStatus && String(current.status).toLowerCase() !== expectedStatus)) {
          return conflict('Karta se mezitím změnila. Displej byl znovu synchronizován.');
        }
        const now = this.store.nextTimestamp();
        const before = E.cloneItems_(items);
        const action = String(input.action || '').trim().toLowerCase();
        const mutations = [];
        let result;
        if (action === 'toggle_order_completion') {
          if (E.canonicalItemTypeForServer_(current.type) !== 'order') throw new InputError('toggle_order_completion lze použít jen na objednávku.');
          const status = E.getMainOrderStatusForAudit_(current.status);
          result = status === 'waiting' ? E.completeOrderAtIndex_(items, index, now)
            : status === 'completed' ? E.reopenOrderAtIndex_(items, index, now) : { changed: false, itemId: id, status };
        } else if (action === 'set_order_item_states') {
          result = E.setOrderItemStatesCommand_(items, id, { served_items: input.served_items || input.servedItems, complete_when_empty: true }, now);
        } else if (action === 'complete_reminder') {
          if (E.canonicalItemTypeForServer_(current.type) !== 'reminder') throw new InputError('complete_reminder lze použít jen na Připomínku.');
          result = E.completeCardAtIndex_(items, index, now, false);
        } else if (action === 'swipe_item') {
          result = E.applyDisplaySwipe_(items, index, now, mutations);
        } else throw new InputError('Neznámá ruční akce displeje: ' + action);
        if (result.changed) {
          this.store.writeItems(items);
          if (action !== 'swipe_item') mutations.push(E.deriveOrderAuditMutation_(before, items, {
            action, source: 'display', occurredAt: now, commandId: '', details: result
          }));
          this.store.audit(mutations);
          this.store.bumpRevision(now, true);
        }
        return { ok: true, busy: false, result, data: this.snapshot() };
      });
    } catch (error) {
      return { ok: false, busy: false, message: messageOf(error), data: this.snapshot() };
    }
  }
}
