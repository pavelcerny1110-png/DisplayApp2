import { DurableObject } from 'cloudflare:workers';
import { KitchenStore } from './store.js';
import { KitchenApi } from './api.js';
import { handleApi, json } from './http.js';

export class Kitchen extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.api = new KitchenApi(new KitchenStore(ctx.storage));
  }
  fetch(request) { return handleApi(request, this.api); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const id = env.KITCHEN.idFromName('kitchen');
      return env.KITCHEN.get(id).fetch(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json({ ok: false, message: 'Nepovolená HTTP metoda.' }, 405);
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    const contentType = String(headers.get('Content-Type') || '').toLowerCase();
    if (url.pathname === '/' || url.pathname.endsWith('.html') || contentType.startsWith('text/html')) {
      headers.set('Content-Type', 'text/html; charset=utf-8');
    }
    // Updates to index.html become visible on reload, never cached by a service worker.
    headers.set('Cache-Control', 'no-cache');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  }
};
