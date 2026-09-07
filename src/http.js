import { InputError } from './api.js';
import { VERSION } from './settings.js';

export const MAX_JSON_BYTES = 1048576;
export const API_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'X-Content-Type-Options': 'nosniff'
});
export function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: API_HEADERS });
}
function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function parseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function terminalMs(order) {
  const value = String(order.cancelledAt || order.completedAt || order.receivedAt || '');
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function history(api) {
  const snapshot = api.snapshot();
  const serviceId = String(snapshot.syncState && snapshot.syncState.currentServiceId || '');
  const log = api.log(serviceId);
  const orders = (Array.isArray(log.orders) ? log.orders : [])
    .filter(record => record && (record.status === 'completed' || record.status === 'cancelled'))
    .map(record => {
      const item = parseObject(record.item_json);
      const attachedCards = parseArray(record.attached_cards_json).filter(card => card && typeof card === 'object' && !Array.isArray(card));
      return {
        id: String(record.order_id || item.id || ''),
        orderNumber: Number(record.order_number) || null,
        status: String(record.status || ''),
        receivedAt: String(record.received_at || ''),
        completedAt: String(record.last_completed_at || record.first_completed_at || ''),
        cancelledAt: String(record.cancelled_at || ''),
        item,
        attachedCards
      };
    })
    .sort((a, b) => terminalMs(b) - terminalMs(a) || terminalMs({ receivedAt: b.receivedAt }) - terminalMs({ receivedAt: a.receivedAt }));
  return { serviceId, orders, serverTime: new Date().toISOString(), version: VERSION };
}
async function readJson(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new InputError('Použijte Content-Type: application/json.', 415);
  }
  if (Number(request.headers.get('content-length') || 0) > MAX_JSON_BYTES) throw new InputError('Požadavek je příliš velký.', 413);
  if (!request.body) throw new InputError('Chybí JSON tělo požadavku.');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) { await reader.cancel(); throw new InputError('Požadavek je příliš velký.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InputError('Neplatné JSON tělo požadavku.'); }
}
export async function handleApi(request, api) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_HEADERS });
  try {
    if (request.method === 'GET' && path === '/api/health') {
      return json({ ok: true, version: VERSION, backend: 'cloudflare-durable-object-sqlite', instance: 'kitchen', timezone: 'Europe/Prague', serverTime: new Date().toISOString() });
    }
    if (request.method === 'GET' && path === '/api/display') return json(api.snapshot());
    if (request.method === 'GET' && path === '/api/history') return json(history(api));
    if (request.method === 'GET' && path === '/api/log') return json(api.log(url.searchParams.get('service_id')));
    if (request.method === 'POST' && path === '/api/command') {
      // Read the request asynchronously, THEN do all engine/storage work without
      // yielding. No request can interleave inside a command or manual mutation.
      const response = api.commands(await readJson(request));
      return json(response, response.conflict ? 409 : 200);
    }
    if (request.method === 'POST' && path === '/api/action') {
      const response = api.action(await readJson(request));
      return json(response, response.ok ? 200 : response.conflict ? 409 : 400);
    }
    const known = ['/api/health', '/api/display', '/api/history', '/api/log', '/api/command', '/api/action'].includes(path);
    return json({ ok: false, message: known ? 'Nepovolená HTTP metoda.' : 'Endpoint nebyl nalezen.' }, known ? 405 : 404);
  } catch (error) {
    if (!(error instanceof InputError)) console.error('DisplayApp2 API failure', error);
    return json({ ok: false, message: error instanceof InputError ? error.message : 'Backend se nepodařilo bezpečně dokončit. Načtěte aktuální stav; neopakujte zápis s novým command_id.' }, error instanceof InputError ? error.status : 500);
  }
}
