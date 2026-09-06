// Exercise the actual Workers runtime and SQLite Durable Object locally.
// Never calls the production Worker. Run after `npm install`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const storage = await mkdtemp(join(tmpdir(), 'display-v17-'));
const base = 'http://127.0.0.1:8788';
let processHandle;
let output = '';
async function start() {
  processHandle = spawn('node_modules/.bin/wrangler', ['dev','--local','--ip','127.0.0.1','--port','8788','--persist-to',storage], {env:{...process.env, CI:'true', WRANGLER_SEND_METRICS:'false'}, stdio:['ignore','pipe','pipe']});
  processHandle.stdout.on('data', b => {output += b;});
  processHandle.stderr.on('data', b => {output += b;});
  processHandle.on('error', error => {output += error.stack;});
  for (let i=0;i<150;i++) {
    try {const r=await fetch(base+'/api/health'); if(r.ok) return;} catch {}
    if(processHandle.exitCode !== null) throw Error(output);
    await sleep(200);
  }
  throw Error('Local Worker did not start.\n'+output);
}
async function stop() {
  if(!processHandle || processHandle.exitCode !== null) return;
  const exited = new Promise(resolve=>processHandle.once('exit',resolve));
  processHandle.kill('SIGTERM');
  await Promise.race([exited,sleep(3000)]);
  if(processHandle.exitCode===null) {processHandle.kill('SIGKILL');await exited;}
}
async function request(path,body) {
  const r=await fetch(base+path,body===undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:r.status, body:await r.json()};
}
try {
  await start();
  assert.equal((await request('/api/health')).body.version,'17.2');
  const document=await fetch(base+'/');
  assert.equal(document.status,200);
  assert.match(document.headers.get('content-type') || '', /^text\/html;\s*charset=utf-8/i);
  const documentText=await document.text();
  assert.match(documentText,/DISPLAY_APP_VERSION = '17.2'/);
  assert.match(documentText,/<meta charset=\"utf-8\">/i);
  assert.ok(documentText.includes(".replace(/[\\u0300-\\u036f]/g, '')"));
  const command={expected_revision:0,command_id:'ci-create',action:'upsert_item',payload:{item:{id:'ci-order',type:'order',data:{recipient:{type:'table',value:'T5'},order_items:[{name:'Polévka',quantity:2,pricing_status:'known',price_basis:'unit',unit_price:50},{name:'Řízek',quantity:1,pricing_status:'known',unit_price:160}]}}}};
  const created=await request('/api/command',command);
  assert.equal(created.body.ok,true);
  assert.equal(created.body.results[0].result.orderNumber,1);
  assert.equal(created.body.data.items[0].title,'Objednávka 1 - stůl T5');
  assert.equal(JSON.parse(created.body.data.items[0].data_json).pricing.total_price,260);
  assert.equal((await request('/api/command',command)).body.results[0].status,'duplicate');
  const stale=await request('/api/command',{expected_revision:0,command_id:'ci-stale',action:'upsert_item',payload:{item:{id:'should-not-exist',type:'order',body:'X'}}});
  assert.equal(stale.status,409);assert.equal(stale.body.conflict,true);
  const item=(await request('/api/display')).body.items[0];
  const gesture={action:'toggle_order_completion',item_id:item.id,expected_updated_at:item.updated_at,expected_status:item.status};
  const results=await Promise.all([request('/api/action',gesture),request('/api/action',gesture)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const completed=(await request('/api/display')).body.items[0];
  assert.equal(completed.status,'served');
  const logged=(await request('/api/log')).body;
  assert.equal(logged.orders.length,1);
  assert.equal(logged.orders[0].status,'completed');
  await stop();await start();
  assert.equal((await request('/api/display')).body.items[0].status,'served');
  assert.equal((await request('/api/command',command)).body.results[0].status,'duplicate');
  assert.equal((await request('/api/action',{...gesture,expected_updated_at:completed.updated_at,expected_status:'served'})).body.ok,true);
  assert.equal((await request('/api/display')).body.items[0].status,'waiting');
  console.log('PASS actual workerd: assets, SQL, command, dedupe, concurrent conflict, archive, restart, undo');
} catch(error) {console.error(output);throw error;}
finally {await stop();await rm(storage,{recursive:true,force:true});}
