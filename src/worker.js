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
    // Revalidate on every online load; v19's service worker only provides an offline shell.
    headers.set('Cache-Control', 'no-cache');
    headers.set('X-Content-Type-Options', 'nosniff');
    const response = new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    if (!isHtml || request.method === 'HEAD' || asset.status < 200 || asset.status >= 300) return response;

    // Independent counter and read-only history layers share the existing shell.
    return new HTMLRewriter()
      .on('#screenTitle', { element(element) { element.setInnerContent(`Display App v${VERSION}`); } })
      .on('body', { element(element) { element.append('<script src="/counter-core-v19.js"></script><script src="/counter-browser-v19.js"></script><script src="/history-v18.js"></script>', { html: true }); } })
      .transform(response);
  }
};
