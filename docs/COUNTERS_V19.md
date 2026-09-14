# Počítadla v19

Počítadlo je samostatná karta `type:"counter"` nebo karta připnutá k čekající objednávce. Vytváří se pouze přes ChatGPT. Výchozí hodnota je 0; hodnoty jsou nezáporná celá čísla, nejvýše 9007199254740991. Backend vytváří vlastní `counter_generation` a `counter_revision`; klient je nevymýšlí.

## Vytvoření přes stávající Command Bridge

```json
{
  "command_id":"unikatni-id-vytvoreni",
  "action":"upsert_item",
  "payload":{"item":{
    "id":"unikatni-interni-id-pocitadla",
    "type":"counter",
    "title":"Palačinky",
    "body":"Příprava v kuchyni",
    "data":{"value":0}
  }}
}
```

Pro připnutí doplňte `data.parent_order_id` z aktuálního autoritativního snapshotu. Stejné provozní číslo může patřit více objednávkám; používejte interní ID. Žádný další Make scénář není potřeba.

## Změna existujícího počítadla přes ChatGPT

Nejprve načtěte aktuální `display`, vyřešte správné interní ID a převezměte `data_json.counter_generation`. Používejte top-level `expected_revision` z tohoto čtení; na HTTP 409 znovu vyhodnoťte záměr vůči vrácenému snapshotu.

- Přičíst/odečíst množství: `action:"counter_delta"`, `target:interní ID`, `payload:{generation:hodnota ze serveru,delta:celé nenulové číslo}`.
- Nastavit číslo: `action:"counter_set"`, stejné `target`, `payload:{generation:hodnota ze serveru,value:nová hodnota,expected_counter_revision:aktuální counter_revision}`.
- Odstranit: `action:"counter_delete"`, stejné `target`, `payload:{generation:hodnota ze serveru}`. Nejdřív musí být jasný uživatelský záměr kartu odstranit.
- Název a popis: běžný `patch_item` pro `title`, `subtitle`, `body`, případně `sort`, `priority`, `channel`.
- Připnout/odepnout: `attach_card` / `detach_card`; dokončená/zrušená rodičovská objednávka počítadlo zamyká.

Neměňte hodnotu pomocí `patch_item`, `upsert_item` existující karty ani zápisem `data_json`. `command_id` je identita operace; síťový retry používá původní ID a stejný obsah. `counter_delta` mění relativně, `counter_set` vyžaduje shodu číselné revize. Přímá klientská `/api/action` používá navíc `item_id` a stabilní `operation_id` místo command obálky; běžná objednávková gesta tuto frontu nepoužívají.

## Ovládání a offline režim

- Fialová karta: název, velké číslo, volitelný popis; vlevo −, vpravo +. Jeden stisk znamená jeden krok, podržení tlačítka neopakuje kroky. U nuly je − vypnuté.
- Podržení karty mimo tlačítka otevře zadání hodnoty s Uložit/Zrušit. Přejetí žádá potvrzení odstranění.
- Každý ruční krok vydá tiché kliknutí, pokud jsou povolené zvuky.
- Android ukládá cache/frontu atomicky do soukromého souboru. Web používá IndexedDB a service worker pouze pro offline HTML/JS. API se do service worker cache neukládá.
- Uložená změna přežije zavření/restart. Po připojení se relativní kroky sloučí s ostatními zápisy, opakované odeslání stejné operace ji neprovede podruhé. Změny na různých kartách neblokuje konflikt jiné karty.
- Ruční přepis při změně jinde vyžádá volbu mezi místní hodnotou a hodnotou serveru. Totéž platí, pokud by souběh zbývajících kroků překročil rozsah. Místní hodnota zůstane zachovaná do rozhodnutí.
- Po odstranění/clear se karta z neodeslaných změn neobnoví. Zařízení ponechá informaci o místní hodnotě pro ruční využití při případném novém vytvoření přes ChatGPT.
- Po studeném offline startu jsou běžné objednávkové zápisy uzamčené do načtení serveru. Offline lze ovládat počítadla z uloženého stavu.

## Životnost a archiv

Nový den hodnotu nemaže. Počítadlo zůstává do odstranění nebo `clear_display`; nemá expiraci, cílovou hodnotu ani progress. Připnuté počítadlo se při dokončení/zrušení objednávky uzamkne a zmizí s objednávkou. Obnovení stále existující objednávky jej znovu zpřístupní.

Počítadla se neukládají do Historie, archivních příloh, completion undo snapshotu, PDF ani denního souhrnu. Technická potvrzení operací zůstávají pouze po dobu existence dané generace počítadla a při odstranění se uklidí. Archiv objednávek zůstává autoritou pro PDF a souhrny.

## Nasazení

Vychází z produkčního backendu `ff3316f444270547e5817ba0aa27b4f92955cee3`. SQLite přidává `counter_receipts`; existující objednávky ani archiv se nemažou. Schéma je v2; starší backend se svou ochranou proti downgrade nelze nasadit nad schéma v2 bez řízeného kompatibilního roll-forward řešení. Worker, Durable Object binding, jméno `kitchen` a Make scénáře zůstávají stejné.
