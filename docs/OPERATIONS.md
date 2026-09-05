# Provoz Display App v17.0 z ChatGPT

Ověřeno 5. 9. 2026. Tento dokument je provozní vodítko, nikoli náhrada aktuálního kódu nebo skutečného stavu API.

## Kam se připojit

- Displej: https://displayapp2.pavelcerny1110.workers.dev/
- Produkční repozitář: https://github.com/pavelcerny1110-png/DisplayApp2 (větev `main`).
- Backend: Cloudflare Worker `displayapp2`, SQLite Durable Object `Kitchen`, binding `KITCHEN`, jméno objektu `kitchen`.
- Google Sheets, GAS a Grok do této verze nezapisují ani nejsou potřeba.

Nový chat musí používat níže uvedené Make scénáře, nikoli starý Commands sheet. V Make je organizace `8894830`, tým `2672945`, oblast `eu1.make.com`. Při změně účtu nejprve znovu načtěte `Make.environment_get`.

## Odeslání příkazu

Aktivní on-demand scénář **DisplayApp2 Command Bridge**, ID **7256818**.

Nástroj `Make.scenario_run` dostává `scenarioId:7256818` a `inputs.command_json`: platný JSON příkazu nebo dávky jako text. Scénář předá tělo beze změny jedním HTTP POST na pevnou adresu `/api/command` a vrátí `outputs.http_status` a `outputs.response`.

Úspěch potvrzujte až po kontrole HTTP statusu, `response.ok`, jednotlivých `response.results` a výsledného `response.data` snapshotu. Samotné `status:success` u Make znamená pouze dokončení přenosu: záměrně se vrací i odpověď API 400/409, aby se neztratilo vysvětlení chyby.

Každému novému příkazu dejte jedinečné `command_id`. Pro nejisté opakování stejné operace použijte původní ID, nikoli nové. Dedupe okno je nejméně 24 hodin. Automatické opakování zápisů není nakonfigurováno. Při timeoutu nejdříve zjistěte výsledek běhu a skutečný stav.

Akce, selektory a příklady jsou v [API.md](API.md). Stabilní interní ID karty je bezpečnější cíl než opakovaně používané provozní číslo objednávky.

## Čtení stavu a denního záznamu

Aktivní on-demand scénář **DisplayApp2 Read Bridge**, ID **7256768**.

`Make.scenario_run` dostává `scenarioId:7256768` a tyto vstupy:

- `resource:"display"`, `service_id:""`: aktuální snapshot displeje.
- `resource:"log"`, `service_id:"YYYY-MM-DD"`: archiv konkrétního dne.
- `resource:"health"`, `service_id:""`: verze a stav API.

Volba cesty je omezena na tyto tři možnosti; žádná libovolná cílová URL. Výsledek opět obsahuje `outputs.http_status` a `outputs.response`. Prázdný `service_id` u logu znamená aktuální pražský den. Pro závěrečný souhrn je bezpečnější poslat zamýšlené datum explicitně.

Archiv načítejte přes `resource:"log"`, nikoli z viditelných karet: skrytá/dokončená objednávka může být stále v denním záznamu. Všechny autoritativní časy a datum služby jsou serverové, Europe/Prague.

## Make konfigurace a provoz

Oba scénáře: Scenarios Start scenario v2 → HTTP Make a request v4 → Scenarios Return output v2. Běží jen na vyžádání. Bez dalšího AI modelu, webhooku, plánovaného čekání nebo tabulek. Vstupy a úplné parametry jsou v `../integrations/make-bridges.json` pro obnovu přes Make nástroje; nejde o nativní soubor pro tlačítko Import blueprint.

HTTP timeout 30 s, parseResponse zapnuto, redirect vypnutý, sdílení cookies vypnuté, komprese zapnutá. Tyto parametry jsou vyplněné explicitně, protože jejich vynechání ve v4 při první konfiguraci způsobilo validační chybu. Příkazový scénář vrací i neúspěšné HTTP odpovědi, čtecí při HTTP chybě skončí chybou.

Make není databáze. Poll displeje a gesta jdou přímo do Cloudflare a nespotřebovávají běhy Make. Jeden ověřený příkazový běh spotřeboval 1 kredit a trval 305 ms; není to záruka rychlosti ani celkový čas od napsání zprávy. K tomu se přičítá práce ChatGPT, volání nástroje, síť a až přibližně jeden 3s interval pollu. Kvótu Make je třeba sledovat podle aktuálního tarifu.

## Ověření vydání

Úplný kód byl nasazen z commitu `a71972075d0b8e58bcec46843288f19633da6609`. GitHub Actions i Cloudflare Workers Builds skončily úspěšně. Cloudflare build `c7540d85-5052-4445-a5a8-d576cbbabcab`, verze deploymentu `2f980210-e362-4289-8d5b-46abfc2b047f`.

26 testů Node/SQLite včetně 36krokového porovnání s původním enginem; 9 kontrol Chromium včetně dotykového swipe, long-press, undo a obou 10s pulzů; referenční snímky shodné pro dvě testované velikosti. CI navíc ověřilo skutečný Workers runtime, transakční konflikt dvou gest a zachování dat po restartu. Podrobnosti a omezení jsou v [PARITY.md](PARITY.md).

Živý test z tohoto ChatGPT přes Make: vytvoření info karty → samostatné načtení → opakování původního příkazu jako duplicate bez další změny → odstranění pouze této testovací karty. Dnešní archiv zůstal bez objednávek a událostí. Prázdný příkaz byl odmítnut HTTP 400 a chyba se správně vrátila do chatu. Ověření není jen spuštění scénáře bez výsledku.

Původní v16.5 ani její data nebyly odstraněny nebo migrovány. Po prvním otevření nové adresy na telefonu je potřeba znovu obslužným gestem odemknout zvuk a případně fullscreen. Fyzické zařízení, baterie, spořič a zvuk vyžadují zkoušku na místě.

## Bezpečnost a změny

API je dle rozhodnutí vlastníka veřejné bez autentizace, CORS `*`. Znalost adresy umožňuje čtení i změny/mazání. Potvrzení při mazání všech logů není přístupový klíč.

Žádné nové verze nebo opravy bez výslovného pokynu. Výchozí zdroj další verze je aktuální `DisplayApp2/main`, nikoli starý GAS ani handover. Další změny mají zachovat chování v17; nesouvisející nalezené chyby nejprve oznamte. Po schváleném vydání aktualizujte kompletní projekt v GitHubu a ověřte výsledek nasazení.
