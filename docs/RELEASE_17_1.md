# Display App v17.1

Datum vydání: 2026-09-05

## Oprava

v17.1 opravuje inicializaci frontendu na reálném telefonu, kde v17.0 mohl prohlížeč bez explicitní znakové sady interpretovat HTML/JavaScript jinak než jako UTF-8. Výsledkem byly poškozené symboly a zastavení JavaScriptu před vykreslením hodin, prázdného stavu a tlačítka pro odemknutí zvuku.

Změny:

- `<meta charset="utf-8">` je uvedeno na začátku `<head>`.
- Worker pro HTML explicitně vrací `Content-Type: text/html; charset=utf-8`.
- Unicode normalizační regex používá ASCII escape `\u0300-\u036f`, takže jeho syntaxe nezávisí na dekódování zdrojového souboru.
- Runtime a frontend mají verzi 17.1.

## Ověření

Před propagací na `main` prošly všechny Node/SQLite testy, statická kontrola frontendu, Wrangler dry-run a skutečný lokální Workers runtime přes `workerd-smoke.js`. Ten regresně kontroluje jak HTTP charset, tak HTML meta deklaraci a ASCII-safe regex.

Funkce, vzhled, Make bridge, API a uložený Durable Object stav se touto opravou nemění.
