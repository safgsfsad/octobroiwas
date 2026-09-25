# Testy bezpieczeństwa

Trzy poziomy: testy jednostkowe (vitest, działają na każdym systemie), testy E2E
(Playwright + Electron, CI na `windows-latest`) i testy ręczne / skryptowe na
docelowym Windowsie (Pester + checklista). Poniższa tabela mapuje wymagania
specyfikacji na to, co faktynie istnieje w repozytorium.

## Uruchamianie

```bat
npm ci
npm run typecheck      rem tsc --noEmit
npm test               rem vitest run (testy jednostkowe)
npm run build          rem esbuild: apps\<app>\dist
npm run e2e            rem Playwright + Electron (wymaga Windowsa do pełnego przebiegu)
npm run test:scripts   rem Pester: scripts\tests\octo.Tests.ps1 (wymaga PowerShell 5.1+/7)
npm run check-fuses    rem weryfikacja fuse'ów Electrona w paczce (po npm run dist:dir)
```

Stan obecny: 20 plików testowych, 144 testy jednostkowe (`npm test`).

## Mapowanie wymagań → testy

| Wymaganie (spec §20) | Gdzie | Uwagi |
|---|---|---|
| Instalacja na czystym Windowsie | `tools/ci/installer-e2e.ps1`, test ręczny | instalator Inno Setup, instalacja per-użytkownik |
| Uruchamianie przez `open.bat` | `scripts/tests/octo.Tests.ps1` + test ręczny | sprawdzana też ścieżka ze spacjami i polskimi znakami |
| Uruchomienie OctoDetect.su | `e2e/octodetect.spec.ts`, Pester | |
| Uruchomienie każdego profilu | `e2e/octobrowser.spec.ts`, Pester | 7 typów profili |
| Izolacja ciasteczek / localStorage / cache | `e2e/octobrowser.spec.ts` (dwa profile, dwa `userData`) | |
| Szyfrowanie profilu, odszyfrowanie poprawną frazą, odrzucenie błędnej | `packages/core/test/profiles.test.ts`, `keyring*.test.ts` | błędna fraza odrzucana przed dotknięciem danych |
| Hasło główne: utworzenie, zmiana, usunięcie, błędne hasło | `packages/core/test/keyring-password.test.ts` | |
| Windows DPAPI / brak DPAPI | `packages/core/test/keyring.test.ts` (fałszywy protector) | |
| Windows Sandbox | test ręczny (wymaga Pro/Enterprise/Education) | `tools/ci/installer-e2e.ps1` sprawdza tylko konfigurację `.wsb` |
| AppContainer / tryb ograniczony | `packages/core/test/privacy.test.ts`, test ręczny | AppContainer pełny nie jest używany – patrz [known-limitations.md](known-limitations.md) |
| Ograniczenia dostępu do plików | test ręczny (profil w piaskownicy nie widzi danych innych profili) | |
| Ochrona DNS (DoH), WebRTC, Canvas, WebGL | `packages/core/test/privacy.test.ts`, `packages/core/test/audit.test.ts` | presety i pomiar w OctoDetect |
| Blokowanie trackerów / reklam / skryptów | `packages/core/test/privacy.test.ts`, `packages/shell/test/channel.test.ts` | |
| Działanie wbudowanych dodatków (adblock, Dark Reader, ClearURLs, mikser audio) | `packages/core/test/audit.test.ts`, test ręczny | bez zewnętrznych WebExtensions |
| Mikser audio | test ręczny (wymaga urządzenia audio) | |
| Aktualizacja co 3. uruchomienie, ręczna, rollback | `packages/core/test/updater.test.ts`, `update-install.test.ts` | podpis Ed25519 + SHA-256 |
| Uszkodzone pliki, nieudane pobieranie, przerwanie instalacji | `packages/core/test/release-verify.test.ts`, `update-install.test.ts`, `store.test.ts` | fail-closed |
| Brak uprawnień administratora | `packages/shell/test/channel.test.ts`, test ręczny (`err.elevated`) | |
| Start aplikacji: odczyt klucza DPAPI bez okna, tryb hasła głównego (błędne/poprawne, „nie pamiętam”) | `packages/shell/test/context-unlock.test.ts` | symulowany Electron, prawdziwe katalogi tymczasowe |
| Kreator pierwszego uruchomienia: tryb DPAPI i tryb hasła głównego, odrzucenie słabego hasła | `packages/shell/test/context-unlock.test.ts` | |
| Magazyn sekretów: Credential Manager (zapis/odczyt/brak wpisu) | `packages/core/test/credman.test.ts`, test ręczny | sekrety nie trafiają do wiersza poleceń ani logów |
| Czytelność UI: żaden tekst nie ma koloru własnego tła | `packages/shell/test/ui-contrast.test.ts` | kontrast WCAG ≥ 3:1 dla każdej reguły `background` + `color`; wykrywa m.in. biały tekst na białym przycisku |
| Monochromatyczny interfejs (bez barw znaczeniowych) | `packages/shell/test/ui-contrast.test.ts` | projekt zakazuje kolorów typu „zielony = ok”; stan zawsze podpisany tekstem i ikoną |
| Etykiety UI istnieją w obu językach (PL/EN) | `packages/shell/test/ui-i18n.test.ts` | sprawdza klucze literałe i dynamiczne (`level.*`, `profile.kindTag.*`, `webrtc.*`, …); brak klucza = widoczny surowy klucz zamiast tekstu |
| Przeglądanie prywatne: profil tymczasowy nic nie zachowuje | `packages/core/test/profiles.test.ts` | `privateBrowsingPatch()` – Ścisły, `clearOnExit`, `deleteOnClose`; dwie sesje różnią się tylko nazwą |
| Tworzenie profilu z poprawką ustawień (mgr:create) | `packages/core/test/profiles.test.ts` | poprawka przechodzi przez `sanitizeProfile`, nietknięte domyślne wartości zostają |
| Motyw okna profilu (ciemny szary / biały), wartość spoza listy odrzucona | `packages/core/test/profiles.test.ts` | `Profile.theme` przechodzi przez `sanitizeProfile`; profil bez motywu dostaje `dark` |
| Przełącznik paska zakładek zawsze zwraca boolean | `packages/core/test/archive-settings.test.ts` | `ui.showBookmarksBar` – łańcuch znaków nie jest traktowany jako `true` |
| Wynik audytu rośnie wraz z pogorszeniem konfiguracji | `packages/core/test/audit.test.ts` | zwykły Chromium > OctoBrowser Standard > OctoBrowser Ścisły; pasma ryzyka: wysoki ≥ 14, średni ≥ 5 |
| Wyszukiwarka w pasku adresu: znana lista, nieznana wartość odrzucona | `packages/core/test/archive-settings.test.ts` | `searchEngineQueryUrl()` koduje zapytanie; „evil” wraca do DuckDuckGo |
| Przełączniki UI zawsze zwracają boolean | `packages/core/test/archive-settings.test.ts` | `confirmOnQuit`, `openLinksInBackground`, `showBookmarksBar` – łańcuch znaków nie jest traktowany jako `true` |
| Polskie znaki i spacje w ścieżce | `packages/core/test/helpers.ts` (`tmpDir`) – wszystkie testy plikowe | |
| Ponowne uruchomienie komputera | test ręczny (auto-start, stan profili, kwarantanna klucza) | |
| Odinstalowanie | `tools/ci/installer-e2e.ps1`, test ręczny | dane użytkownika zostają |

## Testy statyczne i jakościowe

* `npm run typecheck` – strict TypeScript,
* `npm run i18n:check` – parja kluczy PL/EN,
* test `i18n.test.ts` zabrania obietnic „100%”, „niewykrywalny”, „antyfraud” we
  **wszystkich** komunikatach,
* `tools/check-fuses.mjs` – fuse’y Electrona w paczce,
* `tools/hash-files.mjs` – `release\SHA256SUMS.txt`,
* `tools/sign-manifest.mjs` – podpis Ed25519 manifestu aktualizacji.

## Co trzeba przetestować ręcznie przed wydaniem

Patrz [release-checklist.md](release-checklist.md) – w szczególności: kreator
pierwszego uruchomienia (oba tryby klucza), okno hasła głównego (poprawne /
błędne / „nie pamiętam”), przełączanie magazynu sekretów, Windows Sandbox,
instalator, aktualizacja i rollback.
