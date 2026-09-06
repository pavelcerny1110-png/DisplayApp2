# Přenos v16.5 → v17.2

## Výchozí zdroj

Kontrolní součty a seznam 76 přenesených čistých funkcí jsou v `source-provenance.json`. Odpovídají poslední záloze v16.5 a přiloženým zdrojovým souborům, nikoli jen handover dokumentu. Frontend zůstává úplným původním rozhraním; v17.2 nemění layout, gesta ani vizuální provozní model kromě čísla verze.

## Zachováno z v16.5/v17.1

- Čekající / Hotovo / Zrušeno, čas přijetí, běžící čekání, pořadí karet a mizení hotových karet po 60 s.
- Tap dokončení a přesné undo včetně předchozího částečného vydání; long-press dialog položek.
- Swipe waiting objednávky zruší a skryje, swipe hotové/zrušené pouze skryje; práce s připnutými kartami zůstává.
- Tip/Info/Připomínka/Upozornění, alarmy, lokální alert mute, baterie, zvuky, fullscreen, wake lock, téma a orientace.
- Optimistická gesta s `expected_updated_at`/`expected_status`, 409 konflikt a návrat k autoritativnímu snapshotu; frontend zápisy automaticky neopakuje.
- Europe/Prague, serverové časy, service_id, persistentní archiv, order events a rozlišení zdroje chat/display.
- API příkazy, jejich aliasy, command-id deduplikace a oddělení viditelného display snapshotu od archivu.
- Staré nestrukturované objednávky zůstávají kompatibilní; nové strukturované chování se aktivuje přes `data.order_items`.

## Nově ve v17.2

### Serverové provozní číslování

Provozní číslo nové objednávky už neurčuje ChatGPT. Backend vede aktivní sérii per channel: první nová objednávka po vyprázdnění waiting stavu je #1; dokud alespoň jedna waiting objednávka zůstává, čísla pokračují. Částečně vydaná objednávka je dál waiting a reset blokuje. `reopen_order` zachová původní číslo, takže historicky znovuotevřená objednávka může mít stejné číslo jako objednávka současné série; interní ID zůstává autoritativní cíl.

### Revision precondition

`POST /api/command` přijímá `expected_revision`. Pokud požadavek obsahuje nový command ID a aktuální revision neodpovídá, vrátí se HTTP 409 + aktuální snapshot a před provedením dávky se neprovede žádný nový příkaz. Duplicate-only retry již známého command ID zůstává bezpečný i se starou revision.

### Strukturované položky, ceny a příjemce

Nová objednávka může používat `data.order_items` s trvalým line-item ID, názvem, množstvím, stavem a explicitní cenovou semantikou. `quantity > 1` zůstává jeden logický checkbox. Cena může být `known`, `unknown` nebo `free`; známá cena rozlišuje `unit` a `total`, takže výslovná cena celé položky se množstvím znovu nenásobí. `pricing_override` může explicitně určit cenu celé objednávky.

Příjemce je strukturovaný jako `table/person/none`; způsob výdeje `dine_in/takeaway/box/unspecified` je samostatný údaj. Archiv zachovává i kompatibilní starší pole.

## Výslovně nezměněno ve v17.2

- Žádný viditelný stav alert mute; mute zůstává lokální.
- Žádný viditelný odpočet připomínky.
- Žádný sync indikátor, stáří nejstarší objednávky, zvýraznění dlouhého čekání, vibrace ani diagnostická obrazovka.
- Poll zůstává 3 s; WebSocket/SSE není součástí v17.2.
- Make Read/Command bridge se nemění; v17.2 využívá stejný transport.

## Ověření

Lokálně před sestavením release prošlo:

- 31 Node/SQLite testů, včetně nových testů serverového číslování, historical reopen, revision 409, duplicate retry, strukturovaných cen, recipient/fulfillment, archivu a částečného vydávání.
- Původní golden parity test: 36 kroků proti přenesenému v16.5 enginu.
- Statická kontrola `npm run check`.

Release CI musí navíc projít `wrangler deploy --dry-run` a `workerd-smoke.js` nad skutečným lokálním Workers runtime. Teprve úspěšný běh CI a následné produkční ověření potvrzují vydání v17.2.

Chromium/pixelové testy z v17.0 zůstávají referenčním vizuálním základem; v17.2 frontendové chování ani layout nemění. Automatické testy nenahrazují zkoušku na fyzickém kuchyňském telefonu.

## Historická oprava v17.1

V17.1 přidala explicitní UTF-8 v HTML i HTTP odpovědi a ASCII-safe normalizační regex, aby se frontend nerozbil při chybném autodetekování znakové sady. Tato oprava zůstává ve v17.2 zachována.
