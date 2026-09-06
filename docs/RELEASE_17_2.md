# Display App v17.2

V17.2 rozšiřuje backendový datový model a bezpečnost zápisů bez změny běžného vzhledu a gest displeje.

## Změny

- Provozní číslo nové objednávky přiděluje server podle stejného pravidla aktivní série jako dosud. Reopen historické objednávky zachovává původní číslo.
- `/api/command` podporuje top-level `expected_revision`; stale nový zápis je odmítnut HTTP 409 s aktuálním snapshotem před provedením dávky. Duplicate-only retry původního command ID zůstává bezpečný.
- Nové objednávky mohou používat strukturované `order_items` se stabilním ID, množstvím, stavem a cenami.
- Cena rozlišuje `known / unknown / free` a u známé ceny `unit / total`; explicitní cena celé položky se množstvím znovu nenásobí. `pricing_override` může určit celkovou cenu objednávky.
- Příjemce rozlišuje `table / person / none`; `dine_in / takeaway / box / unspecified` je samostatný způsob výdeje.
- Archiv vrací strukturované cenové a příjemcové údaje vedle kompatibilních starších polí.
- `patch_item` umí samostatný `data_json_patch`/`clear_fields`; structured partial serving zachovává line-item ID a přesný stav.
- Verze backendu/frontendu/package byla zvýšena na 17.2.

## Nezměněno

Make bridge konfigurace, veřejná API adresa, 3s poll, gesta, alarmy, lokální mute, layout a ostatní chování v17.1 zůstávají. WebSocket/SSE ani nové UI indikátory nejsou součástí vydání.

## Validace

Lokálně: 31/31 Node/SQLite testů, 36krokový golden parity test a statická kontrola prošly. Finální release je podmíněn úspěchem GitHub CI včetně Wrangler dry-run a `workerd-smoke`, následným merge do `main`, úspěšným Cloudflare deploymentem a kontrolou živého `/api/health`.
