import { DatabaseSync } from 'node:sqlite';
import { KitchenStore } from '../src/store.js';
import { KitchenApi } from '../src/api.js';
export function createTestKitchen(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  const storage = {
    sql: { exec(query, ...args) { return db.prepare(query).all(...args); } },
    transactionSync(callback) {
      db.exec('BEGIN');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const store = new KitchenStore(storage);
  return { db, storage, store, api: new KitchenApi(store) };
}
