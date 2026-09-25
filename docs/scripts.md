# Skrypty serwisowe (`scripts\`)

Wszystkie pliki `.bat` są cienkimi nakładkami na `scripts\lib\octo.ps1` (Windows PowerShell 5.1 – wbudowany w Windows 10/11, bez dodatkowych instalacji).

| Skrypt | Działanie | Opcje |
|---|---|---|
| `open.bat` | uruchamia OctoBrowser.su | argumenty przekazywane do aplikacji, np. `--open-profile=<id>` |
| `open-detect.bat` | uruchamia OctoDetect.su | j.w. |
| `install.bat` | weryfikuje i uruchamia instalator (najnowszy `OctoSuite-Setup-*.exe`); **gdy instalatora nie ma, a jest kod źródłowy – instaluje wszystko, czego brakuje** | `-Source <folder>`, `-Yes` |
| `setup.bat` | sama autoinstalacja wymagań: Node.js ≥ 22.12 i git przez winget, `npm ci`, `npm run build` | `-Yes` |
| `run.bat` | uruchamia **obie** aplikacje **bez okna konsoli** (pierwsze uruchomienie doinstalowuje i buduje, co trzeba) | `-Update` |
| `update.bat` | pobiera najnowsze wydanie z oficjalnego GitHub Releases, weryfikuje, robi kopię, instaluje | `-CheckOnly`, `-NoBackup` |
| `repair.bat` | sprawdza instalację i konfigurację, naprawia co się da | — |
| `uninstall.bat` | uruchamia deinstalator | `-DeleteData` (wymaga wpisania `USUŃ`/`DELETE`) |
| `reset-profile.bat` | resetuje profil (ciasteczka, dane stron, historia, sesja) | `-Profile <nazwa|id>` |
| `backup-profile.bat` | kopia profilu do `.zip` + `.sha256` | `-Profile`, `-Destination <folder>` |
| `restore-profile.bat` | przywraca profil z kopii | `-Profile`, `-Archive <plik.zip>` |
| `github-update.bat` | aktualizacja prosto z GitHuba: wydanie (instalacja) **albo** `git pull` + `npm ci` + `npm run build` (kopia deweloperska) | `-CheckOnly`, `-Yes` |
| `start-all.bat` | aktualizuje z GitHuba, a potem uruchamia **obie** aplikacje | `-NoUpdate`, `-Yes` |

Wspólne: `-Yes` (bez pytań), `-Lang en|pl`. Zmienna `OCTO_NOPAUSE=1` wyłącza pauzę na końcu (dla automatyzacji). Kody wyjścia: `0` OK, `1` błąd, `2` anulowane przez użytkownika.

## Autoinstalacja i ciche uruchamianie

`install.bat` (również w katalogu głównym repozytorium) wykrywa sytuację sam:

* obok skryptów leży `OctoSuite-Setup-*.exe` → klasyczna weryfikacja (SHA-256, Ed25519, Authenticode) i instalacja;
* jest kod źródłowy (rozpoznawany po `package.json` + `tools\build.mjs` + `apps\octobrowser` + `apps\octodetect`; **folder `.git` nie jest wymagany**, więc ZIP pobrany z GitHuba działa tak samo) → **autoinstalacja wymagań**: sprawdzenie `node --version` i `git --version` (najpierw odświeżany jest `PATH` z rejestru, a gdy narzędzia nadal nie widać – przeszukiwane są standardowe lokalizacje `Program Files\nodejs`, `Program Files\Git`, `%LOCALAPPDATA%\Programs`; znaleziona ścieżka trafia do `PATH` tej sesji i dalej jest używana bezwzględnie, więc konsola otwarta przed instalacją Node.js nie psuje niczego), a jeśli czegoś brakuje lub wersja jest za niska – instalacja z **oficjalnego repozytorium winget** (`OpenJS.NodeJS.LTS`, `Git.Git`) po potwierdzeniu (lub od razu z `-Yes`; kody winget `-1978335189` i `-1978335212` = „pakiet już jest” są traktowane jako sukces, a nie błąd), odświeżenie `PATH` w bieżącej sesji, `npm ci` (pomijane, gdy `package-lock.json` się nie zmienił – znacznik `node_modules\.octo-lock-sha256`) i `npm run build`. Gdy winget (Instalator aplikacji) jest niedostępny, skrypt nie pobiera niczego na własną rękę – podaje wymaganą wersję i proponuje otwarcie **oficjalnej** strony pobierania (nodejs.org / git-scm.com), po czym prosi o ponowne uruchomienie. Jeśli po instalacji Node.js nie jest jeszcze widoczny w `PATH` tej konsoli, skrypt prosi o otwarcie nowego okna.

`run.bat` (również w katalogu głównym) uruchamia obie aplikacje **bez żadnego okna konsoli**: przy pierwszym przebiegu ustawia `OCTO_HIDDEN=1` i przekazuje sam siebie do `scripts\lib\hidden.vbs` (Windows Script Host, `WshShell.Run …, 0, True`), więc okno nigdy się nie pokazuje; zmienna `OCTO_HIDDEN` blokuje pętlę, a `OCTO_NOPAUSE=1` wyłącza `pause`. Gdy Windows Script Host jest zablokowany polityką, skrypt działa dalej w zwykłej konsoli (PowerShell startuje z `-WindowStyle Hidden -NonInteractive`). W trybie `run` skrypt nigdy nie zadaje pytań – niewidocznego okna nie dałoby się potwierdzić: brakujące zależności instaluje tylko wtedy, gdy zostały wcześniej zaakceptowane, a aktualizacje wydań zostawia aktualizatorowi w aplikacji. Gdy czegokolwiek brakuje, `run` otwiera **widoczne** okno z `setup.bat`, czeka na jego zakończenie i dopiero potem startuje aplikacje. `-Update` dodatkowo robi `git pull --ff-only` + przebudowę przed startem.

`hidden.vbs` przyjmuje wyłącznie ścieżkę pliku i argumenty; argument zawierający cudzysłów jest odrzucany, więc do wiersza poleceń nie da się wstrzyknąć dodatkowej komendy.

### Programy zewnętrzne a `$ErrorActionPreference = 'Stop'`

Skrypt działa w trybie „każdy błąd przerywa”. W PowerShellu oznacza to, że **każda** linia zapisana przez program zewnętrzny na stderr staje się błędem krytycznym – a `npm warn deprecated …` czy postęp `git` trafiają właśnie tam i nie są awarią. Dlatego wszystkie wywołania `npm`, `git` i `node` idą przez `Invoke-Native`: na czas wywołania przełącza preferencję na `Continue`, wypisuje wyjście jako zwykły tekst, a o powodzeniu decyduje **wyłącznie kod wyjścia**. Przy błędzie ostatnie 20 linii trafia do logu. Test jednostkowy pilnuje, że w skrypcie nie zostało żadne „gołe” wywołanie natywne.

## Bezpieczeństwo skryptów

* **Ścieżki**: zawsze w cudzysłowach, `DisableDelayedExpansion` (znak `!` w nazwie folderu jest bezpieczny), konsola przełączana na UTF-8 i przywracana; `octo.ps1` zapisany jako UTF-8 z BOM – polskie znaki działają w PS 5.1.
* **Pobieranie**: tylko `https://github.com/chargehuobey/lvocto/releases/…`, TLS 1.2+.
* **Weryfikacja instalatora**:
  1. SHA-256 z `SHA256SUMS.txt` i z podpisanego manifestu,
  2. podpis Ed25519 manifestu – przez tryb `--verify-manifest` zainstalowanej aplikacji, a przy świeżej instalacji przez Node.js (jeśli jest) z kluczem `scripts\lib\update-public-key.pem`,
  3. Authenticode (niepodpisany instalator = ostrzeżenie; nieprawidłowy podpis = przerwanie).
  
  Gdy podpisu Ed25519 nie da się sprawdzić: `install.bat` wymaga świadomego potwierdzenia (wpisanie `TAK`/`YES`), `update.bat` **przerywa** (fail-closed).
* **Kopie**: `update.bat` kopiuje konfigurację do `backups\pre-update-<data>`; `repair.bat` przed zmianą przenosi uszkodzony plik do `*.broken-<data>`.
* **Archiwa profili**: suma `.sha256` sprawdzana przed przywróceniem, ochrona przed „zip slip” (ścieżki wychodzące poza folder profilu są odrzucane), rozpakowanie do katalogu tymczasowego i dopiero potem podmiana.
* **Blokady**: skrypty odmawiają zmian, gdy aplikacja działa (pliki profilu są zablokowane).
* **Logi**: `<folder danych>\OctoBrowser\logs\scripts-RRRRMMDD.log` (lub `%TEMP%`, jeśli folder nieznany); hasła, tokeny i klucze są maskowane, ścieżka profilu użytkownika skracana do `%USERPROFILE%`.

## Przywracanie usuniętego profilu

Jeśli profil usunięto z listy, `restore-profile.bat -Archive <plik.zip>` przywraca jego dane i zostawia w folderze profilu plik `restored-entry.json` (zapisane ustawienia profilu, bez sekretów). Skrypt nigdy sam nie edytuje `profiles.json`. Przy następnym uruchomieniu OctoBrowser.su sprawdza ten plik tym samym walidatorem co listę profili i dodaje profil z powrotem. Nieprawidłowy lub zmodyfikowany plik jest odrzucany (zmiana nazwy na `*.rejected`) i odnotowywany w logu.

## Aktualizacja z GitHuba (`github-update.bat`, `start-all.bat`)

`github-update.bat` działa w dwóch trybach, wykrywanych automatycznie:

1. **Zainstalowana aplikacja** (obok skryptów jest `OctoBrowser\OctoBrowser.su.exe`) – skrypt odpytuje REST API oficjalnego repozytorium (`https://api.github.com/repos/chargehuobey/lvocto/releases/latest`; gdy nie ma wydania oznaczonego jako „latest”, bierze najnowsze nie-szkicowe, a wydanie wstępne otrzymuje wagę *optional*). Dalej: porównanie wersji z `ProductVersion` pliku EXE, pokazanie changelogu z wydania, potwierdzenie, pobranie zasobu `OctoSuite-Setup-*.exe` **tylko** z `https://github.com/chargehuobey/lvocto/releases/download/…`, weryfikacja (`latest.json` + `latest.json.sig` → podpis Ed25519 i SHA-256 instalatora; brak manifestu → `SHA256SUMS.txt` + Authenticode + świadome potwierdzenie `TAK`/`YES`), kopia konfiguracji, zachowanie instalatora do rollbacku (`updater\installed\<wersja>.exe`, 3 ostatnie) i instalacja `/SILENT`.
2. **Kopia deweloperska** (obok skryptów jest `package.json` i `.git`) – `git status --porcelain` (lokalne zmiany = przerwanie, nic nie jest nadpisywane), `git pull --ff-only` (bez merge i rebase), `npm ci` tylko jeśli zmienił się `package-lock.json` lub brakuje `node_modules`, na końcu `npm run build`. Z `-CheckOnly` skrypt kończy się po pobraniu zmian, bez budowania.

`start-all.bat` wykonuje najpierw to samo sprawdzenie, a potem uruchamia OctoBrowser.su i OctoDetect.su (w kopii deweloperskiej – przez Electron z `node_modules`). Nieudana lub odrzucona aktualizacja **nigdy** nie blokuje startu – wyświetlane jest ostrzeżenie i aplikacje startują na dotychczasowej wersji. `-NoUpdate` pomija sprawdzanie całkowicie. Instalator tworzy dla obu skryptów skróty w menu Start („Uruchom obie aplikacje (z aktualizacją)”, „Aktualizuj z GitHub”).

Skrypt kontaktuje się wyłącznie z `github.com/chargehuobey/lvocto` i `api.github.com/repos/chargehuobey/lvocto`; każdy inny adres jest odrzucany (`urlNotOfficial`). Nie są wysyłane żadne dane poza standardowym żądaniem HTTPS z nagłówkiem `User-Agent: OctoSuite-scripts`.

## Aktualizacja

`update.bat` uruchamia zweryfikowany instalator w trybie `/SILENT` (tylko okno postępu, bez stron kreatora – zgoda została już wyrażona w skrypcie), tak samo jak aktualizacja z aplikacji. `install.bat` (nowa instalacja) pokazuje pełny kreator.

## Testy

`scripts\tests\octo.Tests.ps1` (Pester 5) uruchamia `octo.ps1` w Windows PowerShell 5.1 na tymczasowym folderze ze spacją i polskimi znakami w ścieżce: kopia, reset, przywracanie (także usuniętego profilu), zmodyfikowane archiwum, „zip slip”, niepoprawny identyfikator, logi; dodatkowo statycznie (AST) sprawdza obecność komend `github-update` i `start-all` oraz to, że w skrypcie nie ma adresów spoza oficjalnego repozytorium. Uruchamiane w CI (`.github/workflows/ci.yml`) lub lokalnie: `npm run test:scripts`.

## Ograniczenia

* przy świeżej instalacji podpis Ed25519 da się sprawdzić tylko z Node.js lub z już zainstalowaną aplikacją; w przeciwnym razie `install.bat` wymaga świadomego potwierdzenia.
