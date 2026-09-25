# Budowanie ze źródeł

## Wymagania

| Narzędzie | Wersja | Do czego |
|---|---|---|
| Node.js | ≥ 22.12 (LTS) | wszystko |
| npm | 10.x | zależności |
| Windows 10/11 x64 | — | uruchamianie, `npm run dist`, instalator |
| Inno Setup 6 | 6.3+ (z https://jrsoftware.org) | `npm run installer` |
| Windows SDK `signtool` | opcjonalnie | podpis Authenticode |

Typecheck, testy, esbuild i generowanie ikon działają także na Linux/macOS.

## Najszybciej: `install.bat`

Dwuklik `install.bat` w katalogu głównym robi wszystko sam: sprawdza Node.js (≥ 22.12) i git, brakujące instaluje z oficjalnego repozytorium winget (po potwierdzeniu), wykonuje `npm ci` i `npm run build`. Potem `run.bat` uruchamia obie aplikacje bez okna konsoli. Szczegóły i ograniczenia: [scripts.md](scripts.md).

## Polecenia

| Polecenie | Działanie |
|---|---|
| `npm ci` | instalacja zależności z `package-lock.json` |
| `npm run typecheck` | `tsc --noEmit` dla całego monorepo |
| `npm test` | vitest (core, i18n, raporty, archiwa, skrypty, updater, weryfikacja wydania…) |
| `npm run i18n:check` | zgodność kluczy PL/EN i użycia w kodzie |
| `npm run icons` | `branding\*.svg` → PNG 16/32/48/128/256 + ICO (aplikacje i instalator) |
| `npm run build` | esbuild obu aplikacji → `apps\<app>\dist` (`node tools/build.mjs octobrowser --dev` – wersja deweloperska z mapami źródeł) |
| `npm run start:browser` / `start:detect` | build + uruchomienie w Electronie |
| `npm run dist:dir` | paczki bez archiwum (`release\<app>\win-unpacked`) – najszybszy test paczki |
| `npm run dist` | paczki + zip obu aplikacji, fuse’y Electrona |
| `npm run installer` | `release\OctoSuite-Setup-<wersja>.exe` |
| `npm run keygen` / `sign-manifest` / `hashes` | patrz [updates-and-release.md](updates-and-release.md) |
| `npm run licenses` | odświeżenie `licenses\` na podstawie faktycznie zbundlowanych pakietów |

## Uruchamianie w trybie deweloperskim

```bat
npm run start:browser
npm run start:detect
```

Dane deweloperskie trafiają do folderu wybranego w kreatorze. Aby zacząć od nowa, usuń `%APPDATA%\OctoBrowser.su\bootstrap.json` (lub `OctoDetect.su`) – kreator pojawi się ponownie (folder danych nie jest usuwany).

Tryb przenośny: utwórz pusty plik `portable.flag` obok `OctoBrowser.su.exe`.

## Testy

```bat
npm test
npx vitest run packages/core/test/crypto.test.ts
```

Testy obejmują m.in.: AES-256-GCM/Argon2id (wektory, błędne hasło, manipulacja szyfrogramem), keyring (DPAPI/hasło, zmiana trybu), wersjonowane magazyny (kopie, wykrywanie uszkodzeń, przywracanie), profile (tworzenie/duplikacja/eksport/import/reset), presety (brak losowania, stałość wartości), polityki sieci, piaskownicę, logger (redakcja sekretów), updater (podpis, SHA-256, oficjalny URL, downgrade, harmonogram), weryfikację wydań, raporty HTML (escapowanie), archiwa (zip slip), i18n (parytet, placeholdery, zakazane obietnice typu „100% anonimowy”), skrypty (ASCII/CRLF `.bat`, BOM `octo.ps1`, zgodność repozytorium).

### Testy na Windows (CI)

`.github/workflows/ci.yml` uruchamia przy każdym pushu dwa zadania:

* **linux** – typecheck, testy jednostkowe, kontrola i18n, build;
* **windows** – to samo oraz:
  * `npm run e2e` – testy E2E w prawdziwym Electronie (Playwright, `e2e/`): start obu aplikacji w trybie efemerycznym, język, profile domyślne, brak Node w interfejsie, lista dozwolonych kanałów IPC, uruchomienie procesu profilu, układ folderu danych, audyt OctoDetect (czysty Chromium i poziom Ścisły), szyfrowanie raportów;
  * `npm run dist:dir` + `node tools/check-fuses.mjs` – fuse’y Electrona w spakowanych exe;
  * Pester (`scripts/tests`) – skrypty serwisowe w Windows PowerShell 5.1;
  * instalator Inno Setup, podpisany **testowym** kluczem manifest, a następnie `tools/ci/installer-e2e.ps1`: cicha instalacja, weryfikacja wydania przez zainstalowaną aplikację (poprawne / zmodyfikowany instalator / zmodyfikowany manifest), start spakowanych aplikacji, `ELECTRON_RUN_AS_NODE` ignorowane, rejestracja `octobrowser://`, cicha deinstalacja.

`.github/workflows/release.yml` buduje i publikuje wydanie po wypchnięciu tagu `v<wersja>` (wymaga sekretu `UPDATE_SIGNING_KEY`) – patrz [updates-and-release.md](updates-and-release.md).

Lokalnie na Windows: `npm run e2e`, `npm run check-fuses` (po `dist:dir`), `npm run test:scripts` (wymaga PowerShell 7 i Pester 5).
