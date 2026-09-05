import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = fs.readFileSync('public/index.html','utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
new vm.Script(script);
assert.match(html, /const DISPLAY_APP_VERSION = '17\.0'/);
assert.match(html, /const ALERT_VIEWPORT_PULSE_MS = 10000/);
assert.match(html, /const REMINDER_VIEWPORT_PULSE_MS = 10000/);
assert.match(html, /\.operational-alert\.alert-alarm-toggle\s*\{[^}]*touch-action: pan-y pinch-zoom;/);
assert.doesNotMatch(html, /google\.script\.run/);
for (const file of fs.readdirSync('src').filter(f=>f.endsWith('.js'))) {
  assert.doesNotMatch(fs.readFileSync('src/'+file,'utf8'), /SpreadsheetApp|LockService|PropertiesService|HtmlService|16E83Bk7/);
}
const config = JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
assert.equal(config.name,'displayapp2');
assert.deepEqual(config.migrations[0].new_sqlite_classes,['Kitchen']);
console.log('Frontend syntax, approved fixes and Cloudflare configuration checks passed.');
