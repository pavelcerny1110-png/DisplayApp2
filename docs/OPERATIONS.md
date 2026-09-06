# Provoz Display App v17.2 z ChatGPT

Tento dokument je provozní vodítko. Autoritativní kód je `DisplayApp2/main`; autoritativní živý stav je backend API, ne tento text ani paměť chatu.

## Architektura

- Displej: https://displayapp2.pavelcerny1110.workers.dev/
- Backend: Cloudflare Worker `displayapp2`, SQLite Durable Object `Kitchen`, binding `KITCHEN`, objekt `kitchen`.
- ChatGPT zápisy: Make Command Bridge → `/api/command`.
- ChatGPT čtení: Make Read Bridge → `/api/display`, `/api/log`, `/api/health`.
- Ruční gesta a 3s poll displeje jdou přímo do Cloudflare a Make nepoužívají.
- Stará GAS/Sheets verze je archivní fallback; v běžném provozu v17.2 se nepoužívá.

## Make mosty

Organizace `8894830`, tým `2672945`, oblast `eu1.make.com`.

**DisplayApp2 Command Bridge** — scenario **7256818**. `Make.scenario_run` dostává `inputs.command_json`, tedy JSON příkazu/dávky jako text. Vrací `http_status` a celé `response` API.

**DisplayApp2 Read Bridge** — scenario **7256768**. Vstupy:

- `resource:"display"`, `service_id:""` — živý snapshot,
- `resource:"log"`, `service_id:"YYYY-MM-DD"` — archiv služby,
- `resource:"health"`, `service_id:""` — health/verze.

Make scénáře se pro v17.2 nemění.

## Revision workflow v17.2

`display` i odpověď úspěšného commandu obsahují `syncState.revision`. Kitchen Assistant si poslední potvrzenou revision drží jako krátkodobý provozní stav.

Pokud asistent bezpečně zná poslední revision, může další objednávkový zápis poslat rovnou s top-level `expected_revision`, bez samostatného pre-readu. Server změnu přijme jen tehdy, pokud se mezitím nic nezměnilo.

Při **HTTP 409 / `conflict:true`** se neprovedl žádný nový příkaz z podmíněné dávky. `response.data` už obsahuje aktuální snapshot; není nutné platit další Read Bridge jen kvůli stejnému stavu. Asistent z něj znovu vyhodnotí uživatelský záměr a použije nový command ID.

Pokud asistent revision nezná (nový chat, nejistý stav, nejasný timeout), načte `display`.

Síťový retry stejné operace používá původní `command_id`. Duplicate-only retry funguje i se starou expected revision. Nikdy nevytvářejte automaticky nové ID jen proto, že první HTTP výsledek nebyl vidět.

## Nové objednávky

Asistent už **nepočítá provozní číslo**. Vytvoří unikátní interní order ID a pošle `type:"order"`, `status:"waiting"`, strukturovaného příjemce a `order_items`. Backend přiřadí provozní číslo i sérii a vrátí je ve výsledku/snapshotu.

Pravidlo číslování zůstává stejné: #1 na začátku aktivní série; dokud existuje waiting, čísla pokračují; completed/cancelled neblokují reset; částečně vydaná waiting blokuje. Jakmile waiting nezůstane, další nová objednávka = #1.

`reopen_order` zachová historické číslo. Mohou tedy výjimečně existovat dvě waiting karty se stejným číslem; změny vždy cílujte interním ID.

## Strukturovaná objednávka

Doporučený nový payload:

```json
{
  "recipient":{"type":"table","value":"T5"},
  "fulfillment":{"type":"dine_in"},
  "order_items":[
    {"name":"Kuřecí směs","quantity":2,"pricing_status":"known","price_basis":"unit","unit_price":155},
    {"name":"Kečup","quantity":1,"pricing_status":"known","price_basis":"unit","unit_price":15}
  ]
}
```

Server doplní line-item ID a stav. Po vytvoření používejte IDs z vráceného snapshotu při opravách a zachovávejte je.

Cena z menu = typicky `price_basis:"unit"`. Výslovně zadaná cena celé logické položky = `price_basis:"total"`; už se množstvím nenásobí. Neznámá = `pricing_status:"unknown"`, zdarma = `free`.

Pokud uživatel výslovně určí **celkovou cenu celé objednávky**, použijte `pricing_override`. Bez override server počítá cenu z položek. Pokud je některá cena neznámá, `pricing.status` je `unknown` a `known_subtotal` zůstává použitelný pro součet známých částek.

Příjemce a způsob výdeje jsou oddělené: `recipient.type = table/person/none`; `fulfillment.type = dine_in/takeaway/box/unspecified`.

## Vydávání a opravy

Před změnou používejte interní order ID z posledního autoritativního snapshotu.

- celé vydání: `complete_order`,
- reopen: `reopen_order`,
- zrušení waiting: `cancel_order`,
- přesný částečný stav: `set_order_item_states`,
- vydání logického typu: `serve_order_items`,
- oprava dat/ceny/příjemce: `patch_item` + `data_json_patch`.

`quantity:3` je stále jeden logický checkbox. Jednotlivé kusy stejného typu se uvnitř checkboxu nerozdělují.

Ruční změny z telefonu jsou autoritativní a zvyšují `revision`; jejich audit má source `display`.

## Provozní karty

Typy zůstávají `info`, `tip`, `reminder`, `alert`. Připnutí ke konkrétní objednávce používá interní ID. Časovaná Připomínka používá `data.remind_at`, ne Make schedule.

Mute Upozornění zůstává pouze interní/lokální stav displeje. Tap na alert neposílá serverový příkaz.

## Začátek služby

1. `health`.
2. `display` a kontrola stavu.
3. `clear_display`.
4. `clear_all_order_logs` s `confirm:true` podle stálých pravidel Restaurant Assistant.
5. Ověřit prázdný display/log a zachytit novou revision.

## Konec služby

1. načíst `log` s explicitním `service_id`,
2. rekonstruovat PDF z archivu a eventů,
3. uložit/ověřit PDF podle stálých pravidel,
4. až potom `clear_display`.

Na konci služby archiv nemažte; maže se při začátku další služby.

## Potvrzení zápisu

Make `status:success` znamená jen úspěšný běh mostu. Za provedenou změnu považujte až správný HTTP stav + `response.ok` + příslušný `results[]` + výsledný snapshot. HTTP 200 samo nestačí pro dávku s individuální chybou.

## Testovací základ v17.2

Release obsahuje Node/SQLite testy pro původní v16.5 parity chování i nové serverové číslování, revision 409, duplicate retry, strukturované položky/ceny, příjemce, archiv a částečné vydávání. CI navíc spouští Wrangler dry-run a skutečný lokální `workerd-smoke`. Frontend layout/gesta nejsou v17.2 měněny kromě čísla verze.

Po produkčním merge vždy ověřte `/api/health` přes Read Bridge a alespoň jeden kontrolovaný živý zápis před ostrou službou.
