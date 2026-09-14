import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = fs.readFileSync('public/index.html','utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
new vm.Script(script);
// v18 intentionally preserves the proven v17.2 HTML core and injects its new
// read-only History layer in the Worker. Keep checking both halves.
assert.match(html, /const DISPLAY_APP_VERSION = '19\.0'/);
assert.match(html, /const ALERT_VIEWPORT_PULSE_MS = 10000/);
assert.match(html, /const REMINDER_VIEWPORT_PULSE_MS = 10000/);
assert.match(html, /<meta charset=\"utf-8\">/i);
assert.ok(html.includes(".replace(/[\\u0300-\\u036f]/g, '')"));
assert.match(html, /\.operational-alert\.alert-alarm-toggle\s*\{[^}]*touch-action: pan-y pinch-zoom;/);
assert.doesNotMatch(html, /google\.script\.run/);
const history = fs.readFileSync('public/history-v18.js','utf8');
new vm.Script(history);
assert.match(history, /textContent = 'Displej'/);
assert.match(history, /inHistory \? 'Historie' : 'Displej'/);
assert.match(history, /fetch\('\/api\/history'/);
assert.match(history, /history-received/);
assert.match(history, /history-terminal/);
const settings = fs.readFileSync('src/settings.js','utf8');
assert.match(settings, /VERSION = '19\.0'/);
const http = fs.readFileSync('src/http.js','utf8');
assert.match(http, /GET' && path === '\/api\/history'/);
const worker = fs.readFileSync('src/worker.js','utf8');
assert.match(worker, /history-v18\.js/);
assert.match(worker, /HTMLRewriter/);
const store = fs.readFileSync('src/store.js','utf8');
assert.match(store, /order_attachment_snapshots/);
assert.match(store, /attached_cards_json/);
for (const file of fs.readdirSync('src').filter(f=>f.endsWith('.js'))) {
  assert.doesNotMatch(fs.readFileSync('src/'+file,'utf8'), /SpreadsheetApp|LockService|PropertiesService|HtmlService|16E83Bk7/);
}
const config = JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
assert.equal(config.name,'displayapp2');
assert.deepEqual(config.migrations[0].new_sqlite_classes,['Kitchen']);
console.log('v19 frontend layers, history contract and Cloudflare configuration checks passed.');
