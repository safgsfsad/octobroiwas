# Aktualizacje i wydania

## Jak działa aktualizacja w aplikacji

1. **Kiedy sprawdza**: przy pierwszym uruchomieniu danego dnia i przy co 3. uruchomieniu (jeśli „Automatyczne aktualizacje” są włączone), a także ręcznie („Sprawdź aktualizacje”). „Przypomnij później” wstrzymuje automatyczne sprawdzanie na wybrany czas.
1a. **Ze skryptu**: `scripts\github-update.bat` (albo `scripts\start-all.bat`, który aktualizuje i uruchamia obie aplikacje) – odpytuje REST API oficjalnego repozytorium, pobiera zasób wydania, weryfikuje go tak samo jak aktualizacja z aplikacji i instaluje w trybie `/SILENT`; w kopii deweloperskiej robi `git pull --ff-only` + `npm ci` + `npm run build`. Szczegóły: [scripts.md](scripts.md).
2. **Skąd**: wyłącznie `https://github.com/chargehuobey/lvocto/releases/…` (adres wkompilowany; adres pliku w manifeście musi zaczynać się od `…/releases/download/`, inaczej aktualizacja jest odrzucana; przekierowanie GitHub do jego CDN jest dopuszczalne, bo integralność pliku potwierdza SHA-256 z podpisanego manifestu).
3. **Weryfikacja**, zanim cokolwiek zostanie uruchomione:
   * podpis Ed25519 pliku `latest.json` (`latest.json.sig`) kluczem publicznym wkompilowanym w aplikację,
   * zgodność kanału, wersja nowsza niż zainstalowana (ochrona przed cofnięciem wersji),
   * SHA-256 i rozmiar pobranego instalatora zgodne z podpisanym manifestem,
   * podpis Authenticode instalatora (jeśli wydanie jest podpisane certyfikatem).
4. **Przed instalacją**: kopia konfiguracji (`backups\pre-update-<data>`), zapamiętanie poprzedniego instalatora (3 ostatnie w `updater\installed`) – to umożliwia **cofnięcie** do poprzedniej wersji („Przywróć poprzednią wersję”).
5. **Instalacja**: `OctoSuite-Setup-<wersja>.exe /SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /LANG=<język> /RELAUNCH=<aplikacja>` – widoczne jest tylko okno postępu (bez stron kreatora, zgoda padła w aplikacji). Aplikacja zamyka się, instalator aktualizuje obie aplikacje, dane pozostają nietknięte, a na koniec uruchamia ponownie aplikację, która zleciła aktualizację. Log instalatora: `<dane>\logs\installer-<data>.log`.

Okno aktualizacji pokazuje: wersję, datę, wagę (**bezpieczeństwo / zalecana / opcjonalna**), listę zmian (PL/EN), komponenty, czy wymagany jest restart.

> Dopóki w buildzie nie ma klucza publicznego (`npm run keygen` nie został wykonany), updater działa w trybie **fail-closed**: pokazuje „Aktualizacje nie są skonfigurowane w tej wersji” i niczego nie pobiera.

## Pliki wydania (GitHub Release `v<wersja>`)

| Plik | Opis |
|---|---|
| `OctoSuite-Setup-<wersja>.exe` | instalator obu aplikacji (jednocześnie pakiet aktualizacji) |
| `latest.json` | manifest: wersja, kanał, waga, notatki PL/EN, nazwa pliku, SHA-256, rozmiar, URL |
| `latest.json.sig` | podpis Ed25519 manifestu (base64) |
| `SHA256SUMS.txt` | sumy SHA-256 wszystkich plików (format `sha256sum -c`) |

## Tworzenie wydania

### Jednorazowo

```bat
npm run keygen
```

* `keys\update-private-key.pem` – **klucz prywatny**, ignorowany przez git. Przenieś go offline lub do sekretu CI. Opcjonalnie zaszyfruj: ustaw `OCTO_KEY_PASSPHRASE` przed `keygen` (i przed `sign-manifest`).
* `packages\core\src\update-public-key.ts` i `scripts\lib\update-public-key.pem` – klucz publiczny, **commitowany**.
* Zmiana klucza (`--force`) sprawia, że zainstalowane kopie odrzucą aktualizacje – wymagana ręczna reinstalacja.

### Każde wydanie (Windows)

```bat
rem 1. podbij "version" w package.json (jedno źródło wersji)
npm ci
npm run typecheck && npm test
npm run icons
npm run build
npm run dist
rem 2. (opcjonalnie) podpis Authenticode:
rem    set CSC_LINK=... & set CSC_KEY_PASSWORD=...          (electron-builder – exe aplikacji)
rem    set OCTO_SIGNTOOL=signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a $f   (instalator)
npm run installer
npm run sign-manifest -- --severity recommended --notes-en "Fixes ..." --notes-pl "Poprawki ..."
npm run hashes
npm run hashes -- --verify
```

### Automatycznie (GitHub Actions)

1. Raz: dodaj sekret repozytorium `UPDATE_SIGNING_KEY` z zawartością `keys\update-private-key.pem` (opcjonalnie `UPDATE_KEY_PASSPHRASE`, `CSC_LINK`/`CSC_KEY_PASSWORD`, `OCTO_SIGNTOOL`).
2. Podbij wersję, uzupełnij `CHANGELOG.md` (opcjonalnie `release-notes.json` z polami `en`/`pl`), commit.
3. `git tag v<wersja> && git push origin v<wersja>` – `release.yml` buduje, sprawdza fuse’y, buduje instalator, podpisuje manifest (klucz istnieje tylko w pliku tymczasowym tego kroku), liczy sumy, uruchamia test instalatora na gotowych plikach i publikuje release z czterema plikami.

Ręcznie, w jednym kroku: `npm run release -- --severity recommended --notes-en "..." --notes-pl "..."` (po zakończeniu automatycznie uruchamia `hashes`).

Opcje `sign-manifest`: `--severity security|recommended|optional`, `--components app,engine,filters`, `--channel stable|beta`, `--file <ścieżka>`, `--no-restart`, `--notes plik.json`.

Następnie utwórz release `v<wersja>` i wgraj cztery pliki z tabeli powyżej, np. `gh release create v1.0.0 release\OctoSuite-Setup-1.0.0.exe release\latest.json release\latest.json.sig release\SHA256SUMS.txt --notes-file CHANGELOG.md`.

### Weryfikacja wydania bez uruchamiania UI

Każda zainstalowana aplikacja ma tryb weryfikacji (używany przez `install.bat`/`update.bat`):

```bat
"OctoBrowser.su.exe" --verify-manifest="C:\ścieżka\latest.json" --verify-installer="C:\ścieżka\OctoSuite-Setup-1.0.0.exe" --verify-result="C:\ścieżka\wynik.json"
```

Kody wyjścia: `0` OK, `10` brak klucza w buildzie, `11` zły podpis, `12` niezgodny SHA-256, `13` błąd odczytu, `14` pliku nie ma w manifeście.

## Checklista przed wydaniem

- [ ] Electron podbity do najnowszej wspieranej wersji z poprawkami bezpieczeństwa (`npm i electron@latest`), `npm audit` przejrzany
- [ ] `version` w `package.json` podbite, wpis w `CHANGELOG.md` (PL/EN)
- [ ] `npm run typecheck`, `npm test`, `npm run i18n:check` – bez błędów
- [ ] `npm run licenses` – `licenses\` aktualne, nowe zależności sprawdzone (licencja, aktywność, uprawnienia)
- [ ] klucz publiczny obecny w `update-public-key.ts` i `scripts\lib\update-public-key.pem`; klucz prywatny **nie** jest w repozytorium (`git status`, `git log -p | findstr PRIVATE`)
- [ ] test ręczny na czystym Windows 10 i 11: kreator (PL/EN, folder ze spacją i polskimi znakami, np. `C:\Użytkownicy\Test Ł\Dane`), tworzenie/eksport/import/szyfrowanie profilu, auto-blokada, panel ruchu, audyt OctoDetect (wszystkie cele), Windows Sandbox / tryb ograniczony
- [ ] aktualizacja z poprzedniej wersji: wykrycie, instalacja, zachowanie danych, rollback
- [ ] `scripts\*.bat` uruchomione z folderu ze spacją i polskimi znakami: install, update `-CheckOnly`, repair, backup/restore/reset profilu, uninstall
- [ ] instalator i exe podpisane Authenticode (jeśli dostępny certyfikat), `signtool verify /pa`
- [ ] `npm run hashes -- --verify` OK; manifest podpisany; pliki wgrane do właściwego tagu
- [ ] po publikacji: `update.bat -CheckOnly` na zainstalowanej poprzedniej wersji widzi nowe wydanie
