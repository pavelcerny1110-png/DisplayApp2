# Přenos v16.5 → v17.1

## Výchozí zdroj

Kontrolní součty a seznam 76 přenesených čistých funkcí jsou v `source-provenance.json`. Odpovídají poslední záloze v16.5 a přiloženým zdrojovým souborům, nikoli jen handover dokumentu. Frontend je úplný původní soubor; nezávislé přepsání vizuálu se neprovádělo.

## Zachováno

- Čekající / Hotovo / Zrušeno, čas přijetí, běžící čekání, pořadí karet, původní mizení po 60 s.
- Tap dokončení a přesné undo včetně předchozího částečného vydání; long-press dialog položek.
- Swipe čekající objednávky zruší a skryje, swipe hotové/zrušené pouze skryje; příslušná práce s připnutými kartami.
- Tip/Info připnutí, odpojení, dokončení, zobrazení příjemce a cen.
- Připomínka: čas aktivace, cyklus 20 s zvuk / 40 s ticho, lokální pulzování, potvrzení.
- Upozornění: nepřetržitá siréna, tap místní mute/unmute, nový alert sirénu znovu zapne.
- Baterie 10 % / 5 %, odlišné délky sirény a priority Battery > Alert > Reminder, vypnutí tapem či nabíječkou.
- Optimistická gesta, synchronizace po konfliktu, zadržení pollu během zápisu, žádné automatické opakování nejistého zápisu.
- Zvuky jednotlivých událostí, fullscreen, wake lock, lokální téma, orientace, hodinové/empty stavy, overflow a scroll/visibility chování.
- Obecné message/media/gallery/table/checklist karty: existující rendering a datová schémata.
- Europe/Prague, serverové časy přijetí/výdeje/dokončení/reopen/zrušení, service_id jako datum, manuální revize.
- Oddělený autoritativní stav objednávek a chronologické události, rozlišení chat/display zdroje, trvalý archiv skrytých karet.
- Výběr kanálů a nastavení nadále reprezentovány serverovými settings; výchozí hodnoty nyní v `src/settings.js`, nikoli v Google Sheet.

## Výslovně změněno

Transport GAS/Sheets byl nahrazen HTTP a SQLite transakcemi. Původní tabulková fronta již neexistuje; clear barrier platí na dosud neprovedené příkazy přijaté dávky. Dedupe potvrzení se drží nejméně 24 h. Archiv nemá automatickou retenční očistu. Historie staré aplikace se neimportuje.

Tři UI úpravy: alert touch-action pro swipe; alert viewport 10 s; reminder viewport 10 s a poté pouze karta. Verze 17.1. Při prvním otevření nového originu se místní preference z Apps Scriptu automaticky nepřenášejí.

## Ověření při přípravě

- 26 úspěšných Node testů nad skutečnou SQLite databází.
- Golden parity test z původního v16.5 enginu: 36 kroků (normalizace, příkazy, položky, připnutí, stav, undo, audit a chyby).
- Chromium: skutečné touch swipe alertu přes API, tap připomínky, optimistický tap při zpožděném POST, undo, long-press dialog.
- Časově ověřeny oba 10s viewport pulzy a pokračující animace reminder karty.
- Pixelově shodné snímky proti v16.5 pro reprezentativní snapshot na 412×915 a 1280×800 při zastavených hodinách a animacích.
- Statická kontrola JS syntaxe, verze, časů, CSS, absence GAS závislostí a deklarace SQLite bindingu.

`workerd-smoke.js` ověřuje navíc lokální skutečný Workers runtime, persistentní SQLite, souběh dvou gest a restart. Výsledky tohoto CI a skutečné produkční nasazení je nutné posuzovat podle běhu GitHub/Cloudflare, ne podle tohoto seznamu.

Simulované a automatické testy **nenahrazují zkoušku na kuchyňském telefonu**: fyzická baterie, zvuk, OS spořič, fullscreen a wake lock vyžadují kontrolu v cílovém prostředí. Pixelový test nepokrývá každou možnou kartu nebo animovaný snímek.

## Oprava v17.1

HTML explicitně deklaruje UTF-8 v dokumentu i HTTP odpovědi a normalizační regex používá ASCII escape, aby se JavaScript nerozbil při chybném autodetekování znakové sady. `workerd-smoke.js` tuto cestu regresně kontroluje.
