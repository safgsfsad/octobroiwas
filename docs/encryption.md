# Szyfrowanie – instrukcja

Wszystko, co OctoSuite zapisuje na dysku, jest szyfrowane sprawdzonymi
bibliotekami (Node `crypto`/OpenSSL, `hash-wasm` dla Argon2id, Windows DPAPI
przez Electron `safeStorage`). **Nie ma tu własnych algorytmów
kryptograficznych.**

## 1. Klucz danych (DEK) i dwie możliwe ochrony

Klucz danych (256 bitów, losowany przez CSPRNG systemu) szyfruje:
`secrets.bin`, `bookmarks.enc`, `history.enc`, `session.enc`, raporty
OctoDetect (`*.odr`) i zaszyfrowane magazyny. Sam klucz **nigdy nie jest
zapisywany w jawnej postaci** – tylko w postaci opakowanej w
`config\keyring.bin`, w jednym z dwóch trybów:

| Tryb | Co dzieje się przy starcie | Kiedy wybrać |
|---|---|---|
| **Konto Windows (DPAPI)** – domyślny | nic nie trzeba wpisywać; klucz odblokowuje system | jeden użytkownik, jeden komputer; wygoda |
| **Hasło główne** | pojawia się okno „Hasło główne”; bez niego aplikacja się nie otworzy | komputer współdzielony, przenośny dysk, wyższe wymagania |

Hasło główne jest **opcjonalne**. Można je ustawić:

* w kreatorze pierwszego uruchomienia (krok 3: „Hasło główne (opcjonalne)”),
* albo później: OctoBrowser.su → **Bezpieczeństwo** → „Ustaw lub zmień hasło
  główne”, OctoDetect.su → **Ustawienia** → ten sam panel.

Wymagania: minimum 10 znaków. Hasło jest wyprowadzane algorytmem **Argon2id**
(64 MiB pamięci, 3 iteracje, równoległość 1 – powyżej minimum OWASP) z losową
16-bajtową solą, a wynik owija klucz w **AES-256-GCM** z losowym 96-bitowym
nonce. Sol, nonce i parametry KDF są zapisane w pliku – hasło **nie jest nigdzie
zapisywane** i nigdy nie jest logowane.

Zmiana hasła nie zmienia klucza danych – owijany jest od nowa, więc wszystkie
dane pozostają czytelne. Usunięcie hasła głównego przenosi ochronę z powrotem na
DPAPI (ten sam klucz, te same dane).

### Co się dzieje, gdy hasła nie znamy

OctoSuite **nie ma** funkcji „przypomnij hasło” – nie da się odzyskać hasła,
którego nie znamy. W oknie hasła głównego jest link „Nie pamiętam hasła”, po
którym aplikacja:

1. pokazuje, co to oznacza (lokalnie zaszyfrowane dane staną się nieczytelne),
2. po potwierdzeniu przenosi stary klucz i zależne pliki do
   `backups\unreadable-<data>` (nic nie jest usuwane),
3. tworzy nowy klucz i startuje dalej.

Profil zaszyfrowany 12-wyrazową frazą pozostaje czytelny z tą frazą – to osobny
mechanizm (patrz punkt 3).

## 2. Zaszyfrowane profile (12-wyrazowa fraza)

Profil można zaszyfrować niezależnie od trybu ochrony klucza. Gdy profil jest
zamknięty, jego dane silnika (ciasteczka, localStorage, IndexedDB, sesja) są
spakowane i zaszyfrowane do `profiles\<id>\engine.vault`:

* fraza: 12 słów BIP-39 (128 bitów entropii + suma kontrolna) – pokazywana
  **raz**, nigdy nie jest zapisywana;
* wyprowadzenie: Argon2id (te same parametry), losowa sól w `vault.json`;
* szyfrowanie: AES-256-GCM, kontekst AAD `octosuite-profile-vault-v1:<id>`;
* `vault.json` zawiera tylko sól, parametry i zaszyfrowaną wartość kontrolną –
  dzięki niej błędna fraza jest odrzucana **przed** dotknięciem danych.

Ta sama fraza służy do odzyskania profilu na innym komputerze (eksport +
import).

## 3. Eksport i import profilu

Eksport **zawsze** jest szyfrowany (nie ma eksportu „do czystego pliku”):
12-wyrazowa fraza → Argon2id → AES-256-GCM, plik `.obprofile`. Sekrety (hasła
proxy) **nigdy** nie są eksportowane. Import tworzy nowy profil i nigdy nie
nadpisuje istniejącego.

## 4. Sekrety – dwa miejsca przechowywania

| Miejsce | Co to jest | Kiedy wybrać |
|---|---|---|
| `config\secrets.bin` (domyślnie) | cała mapa sekretów zaszyfrowana kluczem danych; **jest w kopiach zapasowych** | normalna sytuacja |
| **Menedżer poświadczeń Windows** | po jednym poświadczeniu ogólnym na sekret, w skarbicu systemowym (ten użytkownik Windows) | chcesz trzymać sekrety poza folderem danych |

Przełączasz to w Ustawieniach → Bezpieczeństwo → „Gdzie przechowywać sekrety”.
Zmiana **nie przenosi** zapisanych sekretów – wpisz je ponownie po przełączeniu.
Poświadczenia systemowe nie wchodzą do naszych kopii zapasowych, dlatego
plik `config\credman-index.json` przechowuje wyłącznie **nazwy** poświadczeń
(bez wartości), żeby dało się je usuwać po profilu.

## 5. Kopie zapasowe i przywracanie

* przed **każdą** zmianą `settings.json`, `profiles.json`, zakładek, sesji
  powstaje kopia w `backups\` (VersionedStore),
* uszkodzony plik nie blokuje startu: aplikacja przenosi go do
  `<plik>.damaged-<data>` i wraca do najnowszej poprawnej kopii,
* kopię zaszyfrowanego profilu robisz przyciskiem w UI albo
  `scripts\backup-profile.bat`, przywracasz `scripts\restore-profile.bat`.

## 6. Czyszczenie i usuwanie

* `secureDeleteDir` nadpisuje plik losowymi danymi przed usunięciem i czyści
  katalogi – **na SSD nie gwarantuje to fizycznego usunięcia** (wear leveling);
  dlatego profilów z wrażliwymi danymi nie należy usuwać, tylko szyfrować;
* `temp\` jest czyczone przy starcie i zamknięciu;
* przy zamknięciu profilu tymczasowego dane silnika są usuwane.

## 7. Co szyfrowanie NIE robi

Lokalne szyfrowanie chroni dane **w spoczynku** (kradzież dysku, kopia folderu).
Nie chroni przed złośliwym oprogramowaniem działającym na odblokowanym
komputerze pod tym samym kontem – takie malware może odczytać klucz z pamięci
procesu, przechwycić klawiaturę lub zrobić zrzut ekranu. Komunikat jest
pokazywany w kreatorze i w ustawieniach.

## 8. Polecenia (wiersz poleceń / skrypty)

```bat
scripts\backup-profile.bat --profile <id>            rem zaszyfrowana kopia profilu
scripts\restore-profile.bat --file <ścieżka>         rem przywracanie (pyta o 12 słów)
scripts\reset-profile.bat --profile <id>             rem wymazanie danych profilu
scripts\repair.bat                                   rem naprawa konfiguracji z kopii
OctoBrowser.su.exe --reset-keyring                   rem nowy klucz (stary trafia do backups)
```

Skrypty nie przyjmują haseł jako argumentów (wyniki widoczne w monitorze
procesów) – hasło i frazę wpisujesz w oknie aplikacji.
