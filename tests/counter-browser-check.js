// Full browser + IndexedDB + offline service-worker test against isolated SQLite.
// No request is sent to the production Worker or Make.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createTestKitchen } from './sqlite.js';
import { handleApi } from '../src/http.js';
const { api } = createTestKitchen();
const command = (action, payload = {}, target) => {
  const result = api.commands({ action, payload, target, command_id: crypto.randomUUID() }); assert.equal(result.ok, true); return result;
};
const add = item => command('upsert_item', { item });
const counter = id => api.snapshot().items.find(i => i.id === id);
const data = id => JSON.parse(counter(id).data_json);
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await handleApi(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }), api);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    } else {
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!['index.html','counter-core-v19.js','counter-browser-v19.js','counter-shell-v19.js','history-v18.js'].includes(name)) { res.writeHead(404); res.end(); return; }
      let body = await readFile(new URL('../public/' + name, import.meta.url), 'utf8');
      if (name === 'index.html') body = body.replace('</body>', '<script src="/counter-core-v19.js"></script><script src="/counter-browser-v19.js"></script><script src="/history-v18.js"></script></body>');
      res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(body);
    }
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const directory = await mkdtemp(join(tmpdir(), 'display-counter-browser-'));
await mkdir('browser-screenshots', { recursive: true });
const errors = [];
let context, page;
async function launch(offline = false) {
  context = await chromium.launchPersistentContext(directory, { headless:true, viewport:{width:412,height:915}, offline, args:['--no-sandbox'] });
  page = context.pages()[0] || await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.counterDisplay && document.querySelector('.counter-card'));
}
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(100); }
  throw new Error('Timed out: ' + label);
}
const valueNode = id => page.locator(`article.counter-card[data-item-id="${id}"] output`);
const plus = id => page.locator(`article.counter-card[data-item-id="${id}"]`).getByRole('button', { name:'Přičíst 1' });
async function edit(id, value, save = true) {
  const card = page.locator(`article.counter-card[data-item-id="${id}"]`);
  await card.scrollIntoViewIfNeeded(); const bounds = await card.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 35); await page.mouse.down(); await page.waitForTimeout(750); await page.mouse.up();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  await dialog.getByRole('textbox').fill(String(value));
  await dialog.getByRole('button', { name:save ? 'Uložit' : 'Zrušit', exact:true }).click();
}
async function swipe(id) {
  const card = page.locator(`article.counter-card[data-item-id="${id}"]`); await card.scrollIntoViewIfNeeded(); const b = await card.boundingBox();
  await page.mouse.move(b.x + b.width * .88, b.y + 30); await page.mouse.down(); await page.mouse.move(b.x + b.width * .08, b.y + 30, {steps:12}); await page.mouse.up();
  await page.getByRole('dialog').waitFor();
}
try {
  add({ id:'c', type:'counter', title:'Palačinky', body:'Příprava v kuchyni', data:{value:10} });
  add({ id:'zero', type:'counter', title:'Vejce' });
  await launch();
  await until(() => plus('c').isEnabled(), 'counter initialized');
  assert.equal(await page.locator('article[data-item-id="zero"]').getByRole('button',{name:'Odečíst 1'}).isDisabled(), true);
  await plus('c').dispatchEvent('pointerdown'); await page.waitForTimeout(900); // no auto-repeat
  assert.equal(data('c').value, 10);
  await plus('c').click(); await until(() => data('c').value === 11, 'one step');
  await edit('c', 20, false); assert.equal(data('c').value, 11);
  await edit('c', 20); await until(() => data('c').value === 20, 'absolute save');
  await swipe('zero'); await page.getByRole('dialog').getByRole('button',{name:'Zrušit',exact:true}).click(); assert.ok(counter('zero'));
  await swipe('zero'); await page.getByRole('dialog').getByRole('button',{name:'Odstranit',exact:true}).click(); await until(() => !counter('zero'), 'confirmed deletion');
  await page.screenshot({path:'browser-screenshots/19_counter_portrait.png',fullPage:true});
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await until(() => page.evaluate(() => navigator.serviceWorker.controller !== null), 'offline shell active');
  await context.setOffline(true);
  for (let i = 0; i < 3; i++) { await plus('c').click(); await until(async () => (await valueNode('c').textContent()) === String(21+i), 'durable offline step'); }
  assert.equal(data('c').value, 20);
  await context.close(); await launch(true);
  await until(async () => (await valueNode('c').textContent()) === '23', 'restart retained local count');
  await plus('c').click(); await until(async () => (await valueNode('c').textContent()) === '24', 'offline after restart');
  command('counter_delta', {generation:data('c').counter_generation,delta:2}, 'c');
  await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => data('c').value === 26, 'merged offline plus ChatGPT');
  await until(async () => (await valueNode('c').textContent()) === '26' && await page.locator('#counterQueueBanner').isHidden(), 'acknowledged exactly once');
  await context.setOffline(true); await edit('c', 40);
  command('counter_delta', {generation:data('c').counter_generation,delta:1}, 'c');
  await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => (await page.locator('#counterQueueBanner').textContent()).includes('vyžaduje kontrolu'), 'absolute conflict');
  assert.equal(data('c').value, 27);
  await page.locator('#counterQueueBanner').click();
  await page.screenshot({path:'browser-screenshots/19_counter_conflict.png',fullPage:true});
  await page.getByRole('dialog').getByRole('button',{name:'Použít místní hodnotu'}).click();
  await until(() => data('c').value === 40, 'explicit resolution');
  await until(() => page.locator('#counterQueueBanner').isHidden(), 'resolution acknowledged');
  await context.setOffline(true); await plus('c').click(); await until(async () => await valueNode('c').textContent() === '41', 'pending deletion recovery');
  command('clear_display'); await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => (await page.locator('#counterQueueBanner').textContent()).includes('vyžaduje kontrolu'), 'deleted card notice');
  assert.equal(api.snapshot().items.length, 0);
  await page.locator('#counterQueueBanner').click(); assert.match(await page.getByRole('dialog').textContent(), /Místní hodnota: 41/);
  await page.getByRole('dialog').getByRole('button',{name:'Vzít na vědomí'}).click();
  add({id:'o',type:'order',body:'Palačinka'}); add({id:'p',type:'counter',title:'Pro objednávku',data:{parent_order_id:'o'}});
  await page.evaluate(() => refreshDisplay()); await until(() => plus('p').isEnabled(), 'pinned counter');
  command('complete_order', {}, 'o'); await page.evaluate(() => refreshDisplay()); await until(() => plus('p').isDisabled(), 'parent locks counter');
  await page.setViewportSize({width:915,height:412}); await page.screenshot({path:'browser-screenshots/19_counter_landscape.png',fullPage:true});
  await page.getByRole('button',{name:'Aktuální režim Displej. Klepnutím přepnete do Historie.'}).click();
  await page.locator('.history-order').waitFor(); assert.equal(await page.locator('#historyContent .counter-card').count(), 0);
  assert.doesNotMatch(JSON.stringify(api.log()), /counter_generation/);
  assert.deepEqual(errors, []);
  console.log('PASS browser V19: controls, hold, confirmed swipe, IndexedDB, offline shell restart, relative merge, explicit conflict, deletion recovery, parent lock, History');
} finally { await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(directory,{recursive:true,force:true}); }
