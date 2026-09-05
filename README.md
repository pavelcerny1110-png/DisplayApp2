# Display App v17.1

Kuchyňský displej pro **ChatGPT**, samostatně provozovaný na Cloudflare.

**ChatGPT → Make (on-demand) → Worker `/api/command` → Durable Object `kitchen`.**
Displej načítá `/api/display` každé 3 sekundy; gesta zapisují přímo do `/api/action`.
Google Apps Script, Google Sheets ani Grok se nepoužívají.

**Živý displej:** https://displayapp2.pavelcerny1110.workers.dev/

**Obsluha z dalšího chatu:** [docs/OPERATIONS.md](docs/OPERATIONS.md) obsahuje ověřené Make scénáře, jejich ID, způsob volání a výsledky živého testu. Úplná konfigurace mostů je v [integrations/make-bridges.json](integrations/make-bridges.json).

## Nasazení

Kompletní zdroj je v tomto repozitáři, produkční větev `main`. Cloudflare Workers Builds je propojeno s repozitářem; deploy příkaz `npx wrangler deploy`, root `/`, samostatný build příkaz není potřeba.

`wrangler.jsonc` deklaruje Worker `displayapp2`, assets `public`, binding `KITCHEN` a první SQLite migraci třídy `Kitchen`. Durable Object není potřeba ručně vytvářet. **Neměňte název objektu `kitchen`, binding ani historii migrací při běžné aktualizaci** – vytvořilo by to jiné úložiště.

Po nasazení otevřete adresu Workeru na kuchyňském zařízení. Zvuk a fullscreen vyžadují gesto obsluhy stejně jako dříve. Nový web má jiný origin než Apps Script, proto může být nutné poprvé znovu povolit zvuk a zvolit místní nastavení.

## Změny proti v16.5

- v17.1: explicitní UTF-8 deklarace v HTML i HTTP hlavičce; Unicode normalizační regex je ASCII-safe.
- Nativní transakční SQLite backend místo tabulek a fronty Commands.
- Stejný HTML/CSS klient, karty, gesta, animace a zvukové chování; změněna pouze transportní vrstva.
- Opraveno swipe odstranění Upozornění (CSS `touch-action`).
- Červené okraje po novém Upozornění pulzují 10 s.
- Modré okraje po aktivaci Připomínky pulzují 10 s, potom pokračuje samotná karta.
- Historická data se nepřenášejí. Původní aplikace zůstává samostatná a nedotčená.

## Soubory

- `public/index.html`: kompletní frontend.
- `src/engine.js`: původní pravidla karet, položek, undo, připnutí a auditů.
- `src/store.js`: SQLite tabulky a transakce.
- `src/api.js`, `src/http.js`, `src/worker.js`: API, validace, Worker a Durable Object.
- `src/settings.js`: výchozí nastavení (3s poll, 60s hotové karty, hlavní kanál).
- `docs/API.md`: smlouva API a obsluha z ChatGPT.
- `docs/PARITY.md`: zachované funkce a rozsah ověření.

## Kontrola

Node.js 22.14 nebo novější:

```sh
npm install
npm test
npm run check
node scripts/workerd-smoke.js
npm run dev
```

`npm test` používá skutečné SQLite přes Node; poslední test porovnává 36 kroků se záznamem původního v16.5 enginu. `workerd-smoke.js` navíc testuje skutečný lokální Workers runtime a restart úložiště, **nikdy produkci**. CI kontroluje také Wrangler dry-run.

Volitelné browser testy: Python Playwright, Chromium, Pillow; `python tests/browser_check.py`. Pro pixelové porovnání nastavte `DISPLAY_BASELINE_HTML` na nezměněný v16.5 soubor. Původní GAS se do tohoto veřejného repozitáře nekopíruje.

## Provoz a bezpečnost

**Podle výslovného rozhodnutí vlastníka je API veřejné bez autentizace a CORS je otevřené.** Kdokoli s adresou může číst, měnit i mazat objednávky. Neukládejte zde tajné údaje. `confirm:true` u vymazání všech logů chrání proti omylu klienta, není autentizace.

Běžný poll je pouze čtení a není závislý na Make. Výpadek Make proto nebrání gestům na displeji. Make není databáze ani další AI: pouze přenáší příkaz a odpověď. Může mít vlastní kvótu; délku přenosu a spotřebu je nutné sledovat v historii běhů.

Příkaz potvrzujte až podle `ok`, `results` a vráceného snapshotu, nikoliv pouze podle HTTP 200 nebo spuštění scénáře. Při nejistém výsledku nejprve načtěte skutečný stav. Nikdy nevytvářejte automaticky nový `command_id` pro opakování téhož příkazu.
