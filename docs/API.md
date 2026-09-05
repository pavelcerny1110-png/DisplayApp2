# API v17.0 a obsluha z ChatGPT

Všechny cesty jsou relativní ke **skutečné nasazené URL** tohoto Workeru. UTF-8 JSON, bez autentizace; CORS `*`. Maximální požadavek 1 MiB, dávka 1–100 příkazů. Chybná obálka 400, nesprávný Content-Type 415, velké tělo 413.

## Čtení

- `GET /api/health`: verze, backend, časové pásmo, jméno objektu.
- `GET /api/display`: `settings`, `activeChannel`, `items`, `commandReport`, `syncState`, `serverTime`, `version`.
- `GET /api/log`: dnešní archiv Europe/Prague; `?service_id=YYYY-MM-DD` pro konkrétní den. Vrací `serviceId`, `orders`, `events`, `commandReport`, `serverTime`, `version`.

`syncState.manualRevision` roste při skutečné změně gestem; `revision` zahrnuje i příkazy. Služební den je pražské kalendářní datum. Časy jsou serverové ISO UTC, UI je zobrazuje v Europe/Prague. `/api/display` není archiv: hotové karty si klient skrývá podle původních pravidel, archiv zůstává oddělený.

## Příkazy

`POST /api/command`, Content-Type `application/json`:

```json
{"command_id":"jedinecne-id","action":"upsert_item","payload":{"item":{"id":"order-jedinecne-id","type":"order","title":"#1 stůl T5","body":"Kuřecí řízek – 160 Kč\nHranolky – 55 Kč","status":"waiting","channel":"main","data":{"order_number":1,"customer_or_table":"stůl T5","total_price":215}}}}
```

Dávka: `{"commands":[{...},{...}]}`. Každá položka má vlastní `command_id`. Při chybě jednotlivého příkazu se jeho změny včetně auditů vrátí zpět, další příkazy pokračují. Nejde o jednu transakci celé dávky. Jediný `upsert_items` je naproti tomu atomický.

Identický `command_id` se znovu neprovede; server drží potvrzení **nejméně 24 hodin**, starší průběžně uklízí. Pro všechny nové příkazy použijte nové UUID. Při síťové nejistotě může klient bezpečně zopakovat původní ID v tomto okně, nikoli nové ID. Automatické opakování zápisu není zapnuté. Při vynechání server ID vygeneruje; pro spolehlivou integraci ho však posílejte.

Výsledek: `ok`, `results[]`, `commandReport`, `data` (nový snapshot). Stavy výsledků `processed`, `duplicate`, `superseded`, `error`. Duplicitní odmítnutý příkaz zůstává odmítnutý (`originalStatus:error`, celkové `ok:false`). HTTP 200 samo o sobě neznamená provedení všech příkazů.

`clear_display` a `clear_display_and_current_service_log` přeskočí starší dosud nezpracované příkazy **v téže dávce**. Samostatné HTTP požadavky nemají odloženou frontu: už potvrzené příkazy nelze zpětně označit za superseded. Změny se provádějí v pořadí, ve kterém dorazí ke zpracování.

### Akce

`upsert_item`, `upsert_items`, `patch_item`, `set_status`, `complete_order`, `reopen_order`, `cancel_order`, `serve_order_items`, `set_order_item_states`, `complete_card`, `delete_item`, `attach_card`, `detach_card`, `clear_display`, `clear_channel`, `clear_current_service_log`, `clear_all_order_logs`, `clear_display_and_current_service_log`.

Původní aliasy zachovány, např. `add_item`, `create_item`, `serve_order`, `finish_order`, `pin_card`, `unpin_card`, `clear`, `undo_order`, `reopen`.

Cíl lze určit `target` nebo původními selektory v payload; **preferujte stabilní interní ID** z aktuálního snapshotu. Číslo #1 se může během dne opakovat; nepovažujte ho za globálně jedinečné. Při nejasném cíli se nejdřív podívejte na stav. Příklad:

```json
{"command_id":"nove-jedinecne-id","action":"complete_order","target":"order-jedinecne-id","payload":{}}
```

Nová objednávka dostává `created_at`, `received_at`, `service_id` a prefix „Přijato v HH:mm“ na serveru. ChatGPT je nemusí odhadovat ani posílat. Ceny, položky, přílohy, příjemce a číslování zpracovává ChatGPT podle pravidel kuchyňského záznamu. Typy `order`, `reminder`, `tip`, `info`, `alert` i původní obecné karty zůstávají zachované. Strukturovaná data jsou v `data` nebo `data_json`.

Připomínka: `data.remind_at` (případně původní aliasy `remindAt`, `trigger_at`, `triggerAt`), ISO timestamp s časovým pásmem. Neplánuje se v Make; rozpoznává ji přímo displej jako v16.5.

`clear_display` maže karty, ne denní log. `clear_current_service_log` maže jen log dne (případně `payload.service_id`). `clear_all_order_logs` vyžaduje `payload.confirm:true`. Kombinované vyčištění je `clear_display_and_current_service_log`. Při ukončení dne nejprve načtěte a uložte správný souhrn a až poté proveďte požadovanou očistu.

## Gesta

`POST /api/action`: `action`, `item_id`, `expected_updated_at`, `expected_status`; u částečného vydání také `served_items`. Akce `toggle_order_completion`, `set_order_item_states`, `complete_reminder`, `swipe_item`.

Úspěch 200 + `{ok:true,result,data}`. Konflikt 409 + `{ok:false,conflict:true,message,data}`. Frontend se vrací k autoritativnímu snapshotu. Ostatní chyby gest 400. Neopakovat automaticky. Optimistická změna nastane okamžitě; serverové časy a start 60s skrývání jsou závazné až po potvrzení. Během zápisu klient nepolluje.

Tap na Upozornění pouze lokálně mute/unmute sirénu; není serverový příkaz. Baterie, fullscreen, wake lock, unlock zvuku a lokální téma rovněž zůstávají místní.

## Make

On-demand scénář přijímá `command_json`, předá ho beze změny přes HTTP POST na `/api/command`, vrátí HTTP status a celé tělo odpovědi. Druhý read scénář načítá `/api/display` nebo `/api/log`; výběr cesty je omezený, ne libovolná URL. Skutečná URL se nastavuje až po ověření deploymentu.

Používejte `Make.scenario_run` s explicitními vstupy. Nedávejte do tohoto mostu druhý AI model, časový polling, Google Sheet, ani dávkové čekání. Na každou kuchyňskou zprávu ideálně jeden běh; několik souvisejících akcí lze poslat dávkou. Gesta a 3s poll displeje **neprocházejí Make**.
