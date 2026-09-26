# Model bezpieczeństwa

## Co chronimy

| Zasób | Ochrona |
|---|---|
| Dane profili w spoczynku (ciasteczka, pamięć stron, sesja, historia, zakładki) | AES-256-GCM kluczem danych (DEK); dane silnika profilu szyfrowanego pakowane do `engine.vault` po zamknięciu |
| Klucz danych (DEK) | zapisany wyłącznie w postaci opakowanej w `config\keyring.bin`, w jednym z dwóch trybów: **konto Windows (DPAPI)** – aplikacja startuje bez pytania o cokolwiek, albo **hasło główne** (opcjonalne) – Argon2id → AES-256-GCM, hasło nigdy nie jest zapisywane. Gdy DPAPI nie potrafi już odczytać klucza (inne konto, przeniesiony dysk, uszkodzony plik), plik trafia do kwarantanny w `backups\unreadable-<data>`, powstaje nowy klucz i program działa dalej (`--reset-keyring` wymusza to ręcznie) |
| Zaszyfrowany profil | 12-wyrazowa fraza (BIP-39, 128 bitów entropii + suma kontrolna) → Argon2id (64 MiB, 3 iteracje, równoległość 1) → AES-256-GCM na `engine.vault`. Fraza jest pokazywana **jeden raz** przy włączaniu szyfrowania, nigdzie nie jest zapisywana i służy także do odzyskania profilu na innym komputerze |
| Sekrety (hasła proxy) | `config\secrets.bin` (AES-256-GCM, domyślnie, jest w kopiach) **albo** Menedżer poświadczeń Windows (po jednym poświadczeniu na sekret, ten użytkownik Windows, bez kopii) – nigdy w zwykłym JSON/TXT. Lista nazw poświadczeń: `config\credman-index.json` (bez wartości) |
| Konfiguracja | koperta z SHA-256 (wykrywanie uszkodzeń), kopia przed każdą zmianą, automatyczny powrót do ostatniej poprawnej kopii |
| Eksport profilu | zawsze szyfrowany 12-wyrazową frazą wygenerowaną dla tego pliku (AES-256-GCM + Argon2id); import wymaga tych samych 12 słów |
| Raporty OctoDetect | pliki `.odr` szyfrowane DEK |
| Aktualizacje | manifest podpisany Ed25519, SHA-256 każdego pliku, Authenticode (gdy wydanie jest podpisane), tylko oficjalny URL |

Zasady: brak własnych algorytmów kryptograficznych (Node `crypto`/OpenSSL, `hash-wasm` dla Argon2id, DPAPI przez Electron `safeStorage`, Menedżer poświadczeń przez `CredWriteW`/`CredReadW`/`CredDeleteW` z `advapi32.dll`), hasło główne i fraza profilu **nigdy** nie są zapisywane, klucze są zerowane w pamięci po użyciu (w granicach możliwości JavaScriptu), kontekst (AAD) wiąże szyfrogram z przeznaczeniem pliku (nie można podmienić plików między sobą).

Pełna instrukcja (w tym jak ustawić, zmienić i usunąć hasło główne):
[encryption.md](encryption.md).

## Auto-blokada

Po wybranym czasie bezczynności (domyślnie 15 min, 0 = nigdy) oraz gdy Windows
blokuje ekran:

1. menedżer zamyka **zaszyfrowane** profile, szyfruje ich dane i zeruje klucze w
   pamięci – ponowne otwarcie wymaga 12 słów;
2. jeśli folder danych jest chroniony **hasłem głównym**, blokowany jest też
   lokalny klucz (DEK) i aplikacja pyta o hasło ponownie. Anulowanie okna hasła
   kończy pracę aplikacji zamiast działać z odblokowanym kluczem.

Profile niezaszyfrowane i sama aplikacja (przy ochronie DPAPI) działają dalej –
przy ochronie kontem Windows klucz odblokowuje system, więc nie ma czego
pytać (`od.autolockOsMode`).

## Izolacja

* każdy profil to osobny proces Electron z osobnym katalogiem danych – strony nie mogą powiązać profili przez wspólne ciasteczka/pamięć;
* renderery działają w piaskownicy Chromium (sandbox, contextIsolation, bez Node);
* **tryb ograniczony**: blokada kamery, mikrofonu, USB/HID/serial, schowek tylko do zapisu, pobieranie tylko do folderu profilu;
* **Piaskownica Windows** (Windows Sandbox, Pro/Enterprise/Education): jednorazowa maszyna wirtualna z kopią OctoBrowser; po zamknięciu wszystko znika. Przed startem pokazywane jest podsumowanie (tryb, urządzenia, schowek, foldery, trasa sieci, VPN, brak uprawnień administratora). Gdy niedostępna – automatyczny powrót do trybu ograniczonego;
* pełny **AppContainer** dla całej aplikacji nie jest używany (Electron/Chromium już izoluje renderery w piaskownicy o podobnych ograniczeniach; pełny AppContainer uniemożliwia zapis profili). Opisane uczciwie w UI.

## Granice ochrony (czego NIE chronimy)

* **Złośliwe oprogramowanie na odblokowanym komputerze** może odczytać dane używanej sesji, przechwycić klawiaturę lub pamięć procesu. Lokalne szyfrowanie chroni dane w spoczynku (np. kradzież dysku, kopia folderu), nie przed malware. Komunikat jest pokazywany w kreatorze.
* **Anonimowość w sieci** – profile standardowe/ścisłe nie ukrywają adresu IP; do tego służy VPN/proxy lub profil Tor (oficjalny Tor Browser).
* **Odcisk przeglądarki** – poziom ścisły ogranicza najsilniej identyfikujące powierzchnie (canvas, WebGL, WebRTC, szczegóły sprzętu), ale nie czyni przeglądarki niewidoczną. Wartości są stałe dla profilu (bez losowania), co jest bardziej wiarygodne i mniej wykrywalne jako anomalia niż losowanie.
* **Serwery, na które się logujesz**, widzą to, co im przekażesz.
* **Bezpieczne usuwanie na SSD** – nadpisywanie plików nie gwarantuje fizycznego usunięcia danych na nośnikach flash; stąd zalecenie szyfrowania profili.

## Logi

Dwa tryby: **standardowy** i **diagnostyczny** (więcej szczegółów technicznych; automatycznie wraca do standardowego po 24 h). Aplikacje nie zapisują w logach adresów odwiedzanych stron ani ich treści. Dodatkowo każdy wpis przechodzi przez filtr, który usuwa: hasła i pary `klucz=wartość` o wrażliwych nazwach, nagłówki `Bearer/Basic`, tokeny JWT, dane logowania w URL, parametry zapytań i fragmenty URL, adresy e-mail, długie ciągi hex/base64 oraz bloki PEM; znaki nowej linii są usuwane (ochrona przed wstrzykiwaniem wpisów). Przycisk „Usuń logi” w obu aplikacjach usuwa wszystkie pliki logów.

## Uprawnienia

Aplikacje nigdy nie żądają uprawnień administratora. Instalator domyślnie instaluje per użytkownik. Uruchomienie jako administrator wyświetla ostrzeżenie.

## Zgłaszanie podatności

Patrz [SECURITY.md](../SECURITY.md).
