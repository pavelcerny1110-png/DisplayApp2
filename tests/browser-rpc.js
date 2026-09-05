// Local browser-test bridge, not deployed. Uses stdin/stdout, not a network port.
import readline from 'node:readline';
import { createTestKitchen } from './sqlite.js';
import { handleApi } from '../src/http.js';
const { api } = createTestKitchen();
for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const q = JSON.parse(line);
    const res = await handleApi(new Request('https://display.test'+q.path, {
      method: q.method || 'GET', headers: q.body === undefined ? {} : { 'content-type':'application/json' },
      body: q.body === undefined ? undefined : JSON.stringify(q.body)
    }), api);
    console.log(JSON.stringify({ status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) }));
  } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
}
