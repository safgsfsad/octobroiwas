# Prywatność i połączenia sieciowe

## Telemetria

**Wyłączona i niezaimplementowana.** Aplikacje nie wysyłają statystyk, raportów awarii ani identyfikatorów. Raporty OctoDetect nigdy nie opuszczają komputera, chyba że sam je wyeksportujesz i komuś przekażesz.

## Wszystkie połączenia nawiązywane przez aplikacje

| Połączenie | Kiedy | Dokąd | Co jest wysyłane |
|---|---|---|---|
| Aktualizacja ze skryptu (`github-update.bat`, `start-all.bat`) | ręcznie, przy uruchomieniu skryptu | `api.github.com/repos/chargehuobey/lvocto/releases/latest` + `github.com/chargehuobey/lvocto/releases/download/…` | HTTPS, nagłówek `User-Agent: OctoSuite-scripts`, bez identyfikatorów i bez danych użytkownika |
| Sprawdzenie aktualizacji | 1. uruchomienie dnia i co 3. uruchomienie (jeśli włączone) lub ręcznie | `github.com/chargehuobey/lvocto/releases/latest/download/latest.json` (+ `.sig`) | standardowe żądanie HTTPS (bez identyfikatorów) |
| Pobranie aktualizacji | po potwierdzeniu (lub w tle, jeśli włączone) | ten sam oficjalny adres GitHub Releases | j.w. |
| Aktualizacja list filtrów | przy starcie menedżera najwyżej raz na 24 h (nie w trybie offline) lub ręcznie | `easylist.to`, `ublockorigin.github.io` | j.w. (sesja w pamięci, bez ciasteczek) |
| Publiczny IP | **tylko za zgodą** (domyślnie wyłączone): panel ruchu, audyt | `api.ipify.org` | jedno żądanie HTTPS |
| DNS przez HTTPS | jeśli włączony | wybrany dostawca (Quad9 / Cloudflare / Mullvad / własny) | zapytania DNS stron, które otwierasz |
| Wyszukiwanie | gdy wyszukujesz z paska adresu | `duckduckgo.com` | wpisane zapytanie (nic podczas pisania – brak podpowiedzi sieciowych) |
| Strony | gdy je otwierasz | bezpośrednio lub przez Twoje proxy | to, co wysyła każda przeglądarka |
| Serwer testowy OctoDetect | podczas audytu | `127.0.0.1` (lokalnie) | nic nie wychodzi poza komputer |
| Menedżer poświadczeń Windows | tylko gdy włączysz ten magazyn sekretów | `powershell.exe` → `advapi32.dll` (lokalnie) | nazwa i wartość poświadczenia; **żadne połączenie sieciowe** |
| Kreator / okno hasła głównego | przy pierwszym uruchomieniu i przy starcie w trybie hasła głównego | brak (plik lokalny) | hasło nigdy nie opuszcza komputera i nie jest wysyłane |

Tryb offline (Ustawienia) blokuje wszystkie żądania sieciowe.

## Co jest przechowywane lokalnie

* ustawienia i lista profili (bez sekretów), sekrety zaszyfrowane (plik lub Menedżer poświadczeń Windows);
* `keyring.bin` – wyłącznie opakowany klucz danych (DPAPI lub hasło główne); hasło nie jest zapisywane;
* `credman-index.json` – wyłącznie nazwy poświadczeń, bez wartości;
* dane stron per profil (jak w każdej przeglądarce) – szyfrowane w spoczynku, jeśli włączono;
* zakładki (zaszyfrowane);
* historia – **domyślnie wyłączona**; gdy włączona, tylko tytuły i adresy, nigdy treść stron;
* lista kontaktowanych domen w panelu ruchu – tylko w pamięci, znika po zamknięciu karty;
* logi techniczne bez sekretów i bez adresów stron.

**Nie przechowujemy treści stron** ani pełnej historii domen domyślnie.

## Wyszukiwarka

Domyślnie DuckDuckGo (bez podpowiedzi sieciowych). Zapytania z paska adresu są wysyłane dopiero po zatwierdzeniu.
