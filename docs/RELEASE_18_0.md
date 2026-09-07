# Display App v18.0

## Hlavní novinka: Historie dnešní služby

- Nový read-only endpoint `GET /api/history` vrací pouze dokončené a zrušené objednávky aktuální pražské služby.
- Historie zachovává plný archiv objednávky a snapshot karet Info / Tip / Připomínka / Alert, které byly k objednávce skutečně připnuté při jejím ukončení.
- Samostatné provozní karty se do Historie nemíchají.
- Vyčištění aktuálního nebo celého archivu vyčistí i odpovídající Historii.
- Webový fallback dostává jediný přepínač režimu `Displej` / `Historie`. Text tlačítka vždy označuje aktuální režim.
- Historické objednávky jsou bez běžícího timeru: žlutě se zobrazuje čas přijetí a zeleně čas vydání, případně červeně čas zrušení. Dokončené karty mají zelené a zrušené červené ohraničení.

## Zachovaná kompatibilita

- Hlavní režim Displej, gesta, zvuky, bateriové výstrahy, serverové číslování, revision-safe zápisy a strukturované objednávky z v17.2 zůstávají beze změny.
- Stávající SQLite data se nemažou ani neresetují; v18 pouze přidává pomocnou tabulku pro snapshoty připnutých karet.
- Make Read/Command bridge zůstává beze změny.
