import { DurableObject } from 'cloudflare:workers';
import { KitchenStore } from './store.js';
import { KitchenApi } from './api.js';
import { handleApi, json } from './http.js';
import { VERSION } from './settings.js';

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
    const isHtml = url.pathname === '/' || url.pathname.endsWith('.html') || contentType.startsWith('text/html');
    if (isHtml) headers.set('Content-Type', 'text/html; charset=utf-8');
    // Updates to index.html become visible on reload, never cached by a service worker.
    headers.set('Cache-Control', 'no-cache');
    headers.set('X-Content-Type-Options', 'nosniff');
    const response = new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    if (!isHtml || request.method === 'HEAD' || asset.status < 200 || asset.status >= 300) return response;

    // v18 deliberately leaves the proven v17.2 HTML core untouched and layers
    // the read-only history UI on top. This sharply limits regression risk.
    return new HTMLRewriter()
      .on('#screenTitle', { element(element) { element.setInnerContent(`Display App v${VERSION}`); } })
      .on('body', { element(element) { element.append('<script src="/history-v18.js"></script>', { html: true }); } })
      .transform(response);
  }
};
