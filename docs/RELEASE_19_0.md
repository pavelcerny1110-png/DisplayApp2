# Display App v19.0

Novinka: **Počítadlo** na webu a v nativním Android klientu 1.2.0 (versionCode 3). Přidává ruční ±1, zadání hodnoty podržením, potvrzené odstranění, trvalou offline frontu a výslovné řešení konfliktu. Podrobnosti a ChatGPT příkazy: [COUNTERS_V19.md](COUNTERS_V19.md).

Připnutá počítadla se zamykají s objednávkou a nejsou součástí Historie. Samostatná počítadla se novým dnem nenulují. Vyčištění displeje je odstraní; archiv objednávek se tím nemaže.

Zachované části: serverové číslování, revision/409 ochrana, strukturované položky a ceny, částečné vydávání a undo, Historie v18, provozní karty, zvuky/připomínky, baterie, fullscreen a keep-awake. Legacy Google Apps Script/Sheets se neaktivuje. Make zůstává jen transport pro ChatGPT.

Před vydáním se ověřují Node/SQLite regrese, skutečný Workers runtime včetně restartu a deduplikace počítadla, offline prohlížeč včetně znovuotevření, původní browserová gesta a Android unit/lint/API29 testy. Produkční APK se podepisuje offline existujícím produkčním klíčem, nikdy novým klíčem z CI.
