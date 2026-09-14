// Exercise the actual Workers runtime and SQLite Durable Object locally.
// Never calls the production Worker. Run after `npm install`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const storage = await mkdtemp(join(tmpdir(), 'display-v18-'));
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
  assert.equal((await request('/api/health')).body.version,'19.0');
  const document=await fetch(base+'/');
  assert.equal(document.status,200);
  assert.match(document.headers.get('content-type') || '', /^text\/html;\s*charset=utf-8/i);
  const documentText=await document.text();
  assert.match(documentText,/DISPLAY_APP_VERSION = '19.0'/);
  assert.match(documentText,/history-v18\.js/);
  assert.match(documentText,/Display App v19\.0/);
  assert.match(documentText,/<meta charset=\"utf-8\">/i);
  assert.ok(documentText.includes(".replace(/[\\u0300-\\u036f]/g, '')"));
  const command={expected_revision:0,command_id:'ci-create',action:'upsert_item',payload:{item:{id:'ci-order',type:'order',data:{recipient:{type:'table',value:'T5'},order_items:[{name:'Polévka',quantity:2,pricing_status:'known',price_basis:'unit',unit_price:50},{name:'Řízek',quantity:1,pricing_status:'known',unit_price:160}]}}}};
  const created=await request('/api/command',command);
  assert.equal(created.body.ok,true);
  assert.equal(created.body.results[0].result.orderNumber,1);
  assert.equal(created.body.data.items[0].title,'Objednávka 1 - stůl T5');
  assert.equal(JSON.parse(created.body.data.items[0].data_json).pricing.total_price,260);
  assert.equal((await request('/api/command',command)).body.results[0].status,'duplicate');
  const pinned=await request('/api/command',{expected_revision:1,command_id:'ci-info',action:'upsert_item',payload:{item:{id:'ci-info',type:'info',title:'Informace',body:'Tatarka',data:{parent_order_id:'ci-order'}}}});
  assert.equal(pinned.body.ok,true);
  const stale=await request('/api/command',{expected_revision:0,command_id:'ci-stale',action:'upsert_item',payload:{item:{id:'should-not-exist',type:'order',body:'X'}}});
  assert.equal(stale.status,409);assert.equal(stale.body.conflict,true);
  const item=(await request('/api/display')).body.items.find(value=>value.id==='ci-order');
  const gesture={action:'toggle_order_completion',item_id:item.id,expected_updated_at:item.updated_at,expected_status:item.status};
  const results=await Promise.all([request('/api/action',gesture),request('/api/action',gesture)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const completed=(await request('/api/display')).body.items.find(value=>value.id==='ci-order');
  assert.equal(completed.status,'served');
  const logged=(await request('/api/log')).body;
  assert.equal(logged.orders.length,1);
  assert.equal(logged.orders[0].status,'completed');
  const history=(await request('/api/history')).body;
  assert.equal(history.version,'19.0');
  assert.equal(history.orders.length,1);
  assert.equal(history.orders[0].status,'completed');
  assert.equal(history.orders[0].attachedCards.length,1);
  assert.equal(history.orders[0].attachedCards[0].body,'Tatarka');
  assert.equal((await request('/api/command',{command_id:'runtime-counter-create',action:'upsert_item',payload:{id:'runtime-counter',type:'counter',title:'Palačinky',data:{value:8}}})).body.ok,true);
  const counterItem=(await request('/api/display')).body.items.find(item=>item.id==='runtime-counter');
  const counterStep={action:'counter_delta',item_id:counterItem.id,generation:JSON.parse(counterItem.data_json).counter_generation,operation_id:'runtime-durable-step',delta:1};
  const steps=await Promise.all([request('/api/action',counterStep),request('/api/action',counterStep)]);
  assert.ok(steps.every(reply=>reply.body.ok));
  assert.equal(JSON.parse((await request('/api/display')).body.items.find(item=>item.id===counterItem.id).data_json).value,9);
  await stop();await start();
  assert.equal((await request('/api/action',counterStep)).body.duplicate,true);
  assert.equal(JSON.parse((await request('/api/display')).body.items.find(item=>item.id===counterItem.id).data_json).value,9);
  assert.equal((await request('/api/display')).body.items.find(value=>value.id==='ci-order').status,'served');
  assert.equal((await request('/api/command',command)).body.results[0].status,'duplicate');
  assert.equal((await request('/api/action',{...gesture,expected_updated_at:completed.updated_at,expected_status:'served'})).body.ok,true);
  assert.equal((await request('/api/display')).body.items.find(value=>value.id==='ci-order').status,'waiting');
  assert.equal((await request('/api/history')).body.orders.length,0);
  console.log('PASS actual workerd v19: assets, SQL, history, pinned cards, command, durable counter retry, conflict, restart, undo');
} catch(error) {console.error(output);throw error;}
finally {await stop();await rm(storage,{recursive:true,force:true});}
