# Display App v17.2

Kuchyňský objednávkový displej pro ChatGPT, provozovaný na Cloudflare.

**ChatGPT → Make (on-demand) → Worker `/api/command` → SQLite Durable Object `kitchen`.**
Displej čte `/api/display` každé 3 sekundy; ruční gesta zapisují přímo do `/api/action`. Google Apps Script/Sheets verze je archivní fallback a do běžného provozu v17.2 nezapisuje.

**Živý displej:** https://displayapp2.pavelcerny1110.workers.dev/

Provozní návod je v [docs/OPERATIONS.md](docs/OPERATIONS.md), API smlouva v [docs/API.md](docs/API.md) a přesná konfigurace Make mostů v [integrations/make-bridges.json](integrations/make-bridges.json).

## v17.2

- **Serverové provozní číslování:** backend přiděluje #1, #2… podle waiting série; completed/cancelled reset neblokují, částečně vydaná objednávka ano. `reopen_order` zachová původní číslo.
- **Revision guard:** `/api/command` podporuje `expected_revision`. Stará revision vrací HTTP 409 + aktuální snapshot před provedením jakéhokoli nového příkazu z dávky; duplicate-only retry původního command ID zůstává bezpečný.
- **Strukturované položky:** `data.order_items` má stabilní ID, název, množství, stav a explicitní cenová pole.
- **Cenová sémantika:** `known/unknown/free`, rozlišení ceny za kus a ceny celé logické položky, `known_subtotal` a volitelný `pricing_override` celé objednávky.
- **Strukturovaný příjemce:** `table/person/none`; způsob výdeje (`dine_in/takeaway/box`) je samostatný údaj.
- Archiv vrací nové strukturované údaje, ale zachovává kompatibilní pole a celé `item_json`.
- Make scénáře se nemění; nové podmínky jsou součástí JSON těla předávaného existujícím Command Bridge.
- Vzhled, 3s poll, zvuky, interní mute Upozornění, fullscreen, baterie, wake lock, připomínky, animace a 60s skrývání hotových karet zůstávají zachované.

## Předchozí základ

- v17.1: explicitní UTF-8 v HTML a HTTP hlavičce + ASCII-safe normalizační regex.
- v17.0: přesun z GAS/Sheets na Cloudflare Worker + SQLite Durable Object při zachování frontendového chování v16.5; opraven swipe Upozornění a 10s viewport pulzy Alert/Reminder.

## Nasazení

Autoritativní zdroj je produkční větev `main`. Cloudflare Workers Builds je propojeno s repozitářem. `wrangler.jsonc` deklaruje Worker `displayapp2`, assets `public`, binding `KITCHEN`, SQLite třídu `Kitchen` a jméno Durable Objectu se v běžných aktualizacích nemění.

## Soubory

- `public/index.html`: kompletní frontend.
- `src/engine.js`: pravidla karet, objednávek, strukturovaných položek, cen, číslování, undo a auditů.
- `src/store.js`: SQLite tabulky, meta stav, revision a transakce.
- `src/api.js`, `src/http.js`, `src/worker.js`: API, revision guard, HTTP a Durable Object.
- `src/settings.js`: verze a výchozí nastavení.
- `docs/API.md`: smlouva API.
- `docs/OPERATIONS.md`: obsluha z ChatGPT/Make.
- `docs/PARITY.md`: zachované funkce a rozsah testů.

## Kontrola

Node.js 22.14+:

```sh
npm install
npm test
npm run check
npx wrangler deploy --dry-run
node scripts/workerd-smoke.js
```

`npm test` používá SQLite a zachovává i 36krokový golden test původního v16.5 enginu. Nové testy v17.2 ověřují serverové číslování, revision konflikty, retry deduplikaci, strukturované ceny/položky, příjemce a zachování stavu při opravách. `workerd-smoke.js` testuje skutečný lokální Workers runtime, nikdy produkci.

Volitelné browser testy: `python tests/browser_check.py`. V17.2 nemění rozložení ani ovládání frontendu mimo číslo verze.

## Provoz a bezpečnost

Dle rozhodnutí vlastníka je API veřejné bez autentizace a CORS je `*`. Neukládejte sem tajné údaje. `confirm:true` při vymazání všech logů je ochrana proti omylu, nikoli autentizace.

Příkaz potvrzujte podle HTTP statusu, `ok`, `results` a vráceného snapshotu. Při HTTP 409 použijte aktuální `data` a záměr sestavte znovu. Při nejistém síťovém výsledku nejprve ověřte původní běh/stav; neopakujte tutéž operaci s novým `command_id`.
