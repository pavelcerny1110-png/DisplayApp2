# API v17.2 a obsluha z ChatGPT

Všechny cesty jsou relativní ke skutečné nasazené URL Workeru. UTF-8 JSON, bez autentizace; CORS `*`. Maximální požadavek 1 MiB, dávka 1–100 příkazů.

## Čtení

- `GET /api/health`: verze, backend, časové pásmo, jméno objektu.
- `GET /api/display`: `settings`, `activeChannel`, `items`, `commandReport`, `syncState`, `serverTime`, `version`.
- `GET /api/log`: archiv dne Europe/Prague; `?service_id=YYYY-MM-DD` pro konkrétní službu.

`syncState.revision` roste při každé skutečné změně z příkazu i displeje. `manualRevision` roste jen při ruční změně gestem. `/api/display` není archiv; hotová karta může z displeje zmizet, zatímco `/api/log` ji zachovává.

## Bezpečný zápis přes revision

`POST /api/command`, Content-Type `application/json`.

Klient může přidat top-level `expected_revision`:

```json
{"expected_revision":12,"command_id":"uuid","action":"complete_order","target":"order-id","payload":{}}
```

Pokud se backend od revision 12 změnil a požadavek obsahuje alespoň jeden nový command ID, server vrátí **HTTP 409**, `conflict:true` a aktuální snapshot v `data`. Před konfliktem se neprovede žádný nový příkaz z dávky. Klient z vráceného snapshotu sestaví nový záměr s novým command ID.

Výjimka: retry již zpracovaného `command_id` lze poslat se starou revision; duplicate-only retry vrátí původní výsledek a nic znovu neprovede. Dedupe je držen nejméně 24 hodin. Při síťové nejistotě tedy opakujte původní ID, ne nové.

Bez `expected_revision` zůstává starší kompatibilní chování. Pro Kitchen Assistant v17.2 je doporučen podmíněný zápis s poslední známou `revision`.

Dávka: `{"expected_revision":12,"commands":[{...},{...}]}`. Revision podmínka se kontroluje jednou před dávkou. Jednotlivé příkazy pak mají stejné transakční chování jako dříve: chyba jednoho příkazu vrátí jeho změny zpět, ostatní mohou pokračovat. `upsert_items` je atomický jako jeden příkaz.

Výsledek obsahuje `ok`, `results[]`, `commandReport`, `data`. Stavy výsledků: `processed`, `duplicate`, `superseded`, `error`. HTTP 200 ani Make `success` samo o sobě neznamená, že všechny příkazy uspěly.

## Nová objednávka a provozní číslo

Novou objednávku stále vytváří `upsert_item`, ale **provozní číslo přiděluje backend**. Klient neposílá autoritativní `order_number` ani číslo v titulku.

```json
{
  "expected_revision": 12,
  "command_id": "uuid",
  "action": "upsert_item",
  "payload": {
    "item": {
      "id": "order-unikatni-id",
      "type": "order",
      "status": "waiting",
      "channel": "main",
      "data": {
        "recipient": {"type":"table","value":"T5"},
        "fulfillment": {"type":"box"},
        "order_items": [
          {"name":"Kuřecí směs","quantity":2,"pricing_status":"known","price_basis":"unit","unit_price":155},
          {"name":"Kečup","quantity":1,"pricing_status":"free"}
        ]
      }
    }
  }
}
```

Backend nastaví `order_number`, `operational_series_id`, `created_at`, `received_at`, `service_id`, titulek `Objednávka N - příjemce`, subtitle `Přijato v HH:mm ...` a odvodí display body. Výsledek příkazu vrací také přidělené `orderNumber`.

Provozní pravidlo zůstává stejné: první objednávka aktivní série = 1; dokud existuje alespoň jedna waiting objednávka, další čísla pokračují; completed/cancelled reset neblokují; částečně vydaná waiting objednávka blokuje. Když nezůstane žádná waiting, nová objednávka zahájí novou sérii #1.

`reopen_order` **nemění historické číslo**. Znovuotevřením starší objednávky proto mohou existovat dvě waiting objednávky se stejným provozním číslem. Pro změny vždy používejte interní order ID.

## Strukturované položky

`data.order_items` je autoritativní struktura nové objednávky. Každá logická položka má:

- `id`: stabilní line-item ID; při vytvoření může chybět, server ho doplní,
- `name`: celý název/modifikace položky,
- `quantity`: celé číslo >= 1,
- `status`: `waiting` nebo `served` (server jej synchronizuje),
- `pricing_status`: `known`, `unknown`, `free`,
- `price_basis`: u známé ceny `unit` nebo `total`,
- `unit_price`, `total_price`.

Více kusů stejného jídla zůstává jeden logický typ/checkbox. Např. `quantity:3` = jedna položka „3× Vývar“, ne tři checkboxy.

Ceny:

- `known + unit`: `total_price = unit_price × quantity`.
- `known + total`: uvedený `total_price` je cena celé logické položky a **znovu se množstvím nenásobí**.
- `free`: server nastaví 0 Kč.
- `unknown`: číselná cena zůstává `null` a display ji označí jako neznámou.

Backend vypočítá `data.pricing` s `status`, `total_price`, `known_subtotal`, `source`. Pokud je alespoň jedna cena neznámá, stav objednávky je `unknown`, celková cena je `null` a `known_subtotal` drží součet známých částek.

Výslovně zadaná cena celé objednávky má přednost přes:

```json
{"pricing_override":{"status":"known","total_price":590}}
```

Pro explicitně bezplatnou celou objednávku lze použít `status:"free"`. Odstraněním `pricing_override` se cena znovu počítá z položek.

Při opravě položek používejte jejich ID z aktuálního snapshotu a zachovejte je. `patch_item` nyní může pracovat i pouze s `data_json_patch`, např. aktualizovaným `order_items` nebo `pricing_override`.

## Příjemce a způsob výdeje

`data.recipient`:

- `{ "type":"table", "value":"T5" }`
- `{ "type":"person", "value":"Martin" }`
- `{ "type":"none", "value":"" }`

`data.fulfillment.type` je samostatný údaj: `dine_in`, `takeaway`, `box`, `unspecified`. „S sebou/do boxu“ tedy není typ příjemce.

Archiv přímo vrací `recipient_type`, `recipient_value`, `fulfillment_type`, `pricing_status`, `known_subtotal` a zároveň zachovává kompatibilní `customer_or_table`, `total_price` a celé `item_json`.

## Akce

`upsert_item`, `upsert_items`, `patch_item`, `set_status`, `complete_order`, `reopen_order`, `cancel_order`, `serve_order_items`, `set_order_item_states`, `complete_card`, `delete_item`, `attach_card`, `detach_card`, `clear_display`, `clear_channel`, `clear_current_service_log`, `clear_all_order_logs`, `clear_display_and_current_service_log`.

Původní aliasy zůstávají. Stabilní interní ID je bezpečnější než číslo nebo titulek.

`set_order_item_states` nastavuje přesný výběr vydaných logických položek. `serve_order_items` u strukturované objednávky vydá celý logický typ; nerozděluje jednotlivé kusy uvnitř `quantity`.

Připomínka používá `data.remind_at` jako ISO timestamp s časovým pásmem; neplánuje se v Make.

`clear_display` maže karty, ne log. `clear_current_service_log` maže log jednoho dne. `clear_all_order_logs` vyžaduje `confirm:true`.

## Gesta

`POST /api/action`: `action`, `item_id`, `expected_updated_at`, `expected_status`; u částečného vydání `served_items`. Akce: `toggle_order_completion`, `set_order_item_states`, `complete_reminder`, `swipe_item`.

Konflikt ručního gesta zůstává HTTP 409 s aktuálním snapshotem. Frontend POST automaticky neopakuje. Tap na Upozornění pouze lokálně mute/unmute sirénu a nemění backend.

## Make

Command Bridge přijímá `command_json` a předává jej beze změny na `/api/command`. Read Bridge načítá `display`, `log` nebo `health`. Make není databáze. Poll displeje a gesta Make nepoužívají.

V17.2 nevyžaduje změnu existujících Make scénářů; `expected_revision` je pouze další pole JSON těla předávaného stávajícím Command Bridge.
