# OctoSuite — OctoBrowser.su i OctoDetect.su

Dwie **osobne** aplikacje desktopowe dla Windows 10/11 (x64). Każda ma własne profile, konfigurację, ikony, procesy i katalogi danych:

| | **OctoBrowser.su** (OB.su) | **OctoDetect.su** (OD.su) |
|---|---|---|
| Cel | prywatna, bezpieczna, wielozadaniowa przeglądarka | audyt prywatności i odcisku (fingerprint) przeglądarki |
| Motyw | granat / grafit / fiolet | ciemny łupek / morski / szmaragd |
| Proces | menedżer + osobny proces na każdy profil | jedno okno + lokalny serwer testowy (127.0.0.1) |
| Dane | `<folder>\OctoBrowser\…` | `<folder>\OctoDetect\…` |

> **Uczciwie o ochronie.** Żadna z aplikacji nie daje „100% bezpieczeństwa”, „anonimowości” ani „niewykrywalności”. Ochrona ogranicza typowe zagrożenia (śledzenie, wycieki, przypadkowe łączenie profili), a OctoDetect **tylko mierzy** – niczego nie fałszuje. Projekt świadomie **nie** zawiera funkcji antydetect/antyfraud (losowanie parametrów sprzętu, udawanie urządzeń, omijanie CAPTCHA/banów, ukrywanie automatyzacji).

## Szybki start (deweloper)

Wymagania: Node.js ≥ 22.12, npm 10, Windows 10/11 do uruchamiania i pakowania (kod buduje się i testuje także na Linux/macOS).

```bat
install.bat           & rem albo ręcznie, krok po kroku:
npm ci
npm run typecheck
npm test
npm run icons         & rem PNG 16–256 + ICO z SVG (wyniki są już w repo)
npm run build         & rem esbuild -> apps\<app>\dist
npm run start:browser & rem OctoBrowser.su (dev)
npm run start:detect  & rem OctoDetect.su (dev)
```

Pakowanie i wydanie (Windows):

```bat
npm run keygen        & rem RAZ, przed pierwszym wydaniem: klucz Ed25519 aktualizacji
npm run build
npm run dist          & rem electron-builder: release\<app>\win-unpacked + zip
npm run installer     & rem Inno Setup 6: release\OctoSuite-Setup-<wersja>.exe
npm run hashes        & rem release\SHA256SUMS.txt
npm run sign-manifest -- --severity recommended --notes-en "..." --notes-pl "..."
```

Szczegóły: [docs/build.md](docs/build.md), [docs/updates-and-release.md](docs/updates-and-release.md).

## Pierwsze uruchomienie

Przy pierwszym uruchomieniu **każdej** aplikacji pojawia się jednorazowy kreator:

1. **Język** – English / Polski (pytanie pojawia się tylko raz; zmiana później w Ustawieniach),
2. **Folder danych** – wybierasz, gdzie zapisywać wszystko (domyślnie `Dokumenty\OctoSuite`); dane są tylko lokalne,
3. **Ochrona klucza** – klucz chroniony kontem Windows (DPAPI, bez hasła) **albo** opcjonalne hasło główne (Argon2id → AES-256-GCM); plus zgody: sprawdzanie publicznego IP (domyślnie **wyłączone**), automatyczne aktualizacje.

Hasło główne jest opcjonalne i nigdzie nie jest zapisywane. Można je ustawić,
zmienić lub usunąć później (Ustawienia → Bezpieczeństwo); zmiana hasła nie
zmienia klucza danych, więc zaszyfrowane dane pozostają czytelne. Pełny opis:
[docs/encryption.md](docs/encryption.md).

## Skrypty serwisowe (`scripts\`)

`start-all.bat` (aktualizacja + uruchomienie **obu** aplikacji), `github-update.bat` (aktualizacja prosto z GitHuba), `open.bat`, `open-detect.bat`, `install.bat`, `update.bat`, `repair.bat`, `uninstall.bat`, `reset-profile.bat`, `backup-profile.bat`, `restore-profile.bat` – obsługują spacje i polskie znaki w ścieżkach, weryfikują SHA-256 i podpisy, piszą logi bez sekretów. Opis: [docs/scripts.md](docs/scripts.md).

## Codzienne użycie (bez konsoli)

Najkrótsza droga: dwuklik `install.bat`, potem dwuklik `run.bat` – oba leżą w katalogu głównym i w `scripts\`.

| Plik | Co robi |
|---|---|
| `install.bat` | **autoinstalacja wszystkiego, co potrzebne**: instalator wydania, a w kopii źródłowej Node.js + git (winget, za zgodą), `npm ci` i `npm run build` |
| `run.bat` | uruchamia obie aplikacje **bez okna konsoli** (pierwszy start sam dokańcza instalację) |
| `scripts\start-all.bat` | sprawdza aktualizacje na GitHubie, instaluje je (po potwierdzeniu) i uruchamia **OctoBrowser.su oraz OctoDetect.su**; `-NoUpdate` = sam start |
| `scripts\github-update.bat` | tylko aktualizacja: zainstalowaną wersję z najnowszego wydania GitHub, a kopię deweloperską przez `git pull` + `npm ci` + `npm run build` |

Oba skrypty weryfikują pobrane pliki (SHA-256, podpis Ed25519 manifestu, Authenticode), robią kopię konfiguracji przed instalacją i zostawiają instalator do rollbacku. Nieudana aktualizacja nie blokuje uruchomienia aplikacji. Szczegóły: [docs/scripts.md](docs/scripts.md).

## Struktura repozytorium

```
apps/
  octobrowser/            OctoBrowser.su (main, preloady, UI, strony octo://, electron-builder.yml)
  octodetect/             OctoDetect.su (main, audytor, serwer testowy, strona probe, UI)
packages/
  core/                   czysty Node: kryptografia, magazyny, profile, presety, audyt, updater, i18n
  shell/                  wspólny kod Electron: kreator, odblokowanie, hardening, sesje, aktualizacje
branding/                 logo SVG, PNG 16/32/48/128/256, ICO (aplikacje + instalator)
installer/octosuite.iss   instalator Inno Setup (obie aplikacje)
scripts/                  skrypty .bat + lib/octo.ps1
tools/                    build, ikony, klucze, podpis manifestu, sumy, licencje, i18n
resources/filters/        bazowa lista filtrów (offline, do pierwszej aktualizacji)
licenses/                 licencje komponentów zewnętrznych
docs/                     dokumentacja
```

## Dokumentacja

| Dokument | Zawartość |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | instrukcja użytkownika OctoBrowser.su |
| [docs/octodetect.md](docs/octodetect.md) | OctoDetect.su: metodologia, poziomy ryzyka, ograniczenia |
| [docs/architecture.md](docs/architecture.md) | architektura, procesy, IPC, układ danych |
| [docs/antidetect.md](docs/antidetect.md) | profile antidetect: fingerprint (OS, UA, WebGL, WebRTC…), proxy i autodetekcja formatu |
| [docs/api.md](docs/api.md) | lokalne REST API (profile, proxy, fingerprinty, start/stop, Puppeteer/Playwright) |
| [docs/technology-choice.md](docs/technology-choice.md) | porównanie technologii i uzasadnienie wyboru |
| [docs/components.md](docs/components.md) | weryfikacja komponentów open source |
| [docs/security-model.md](docs/security-model.md) | szyfrowanie, auto-blokada, granice ochrony |
| [docs/threat-model.md](docs/threat-model.md) | model zagrożeń: co chronimy, przed czym nie |
| [docs/encryption.md](docs/encryption.md) | szyfrowanie: DPAPI, hasło główne, 12-wyrazowa fraza, kopie |
| [docs/known-limitations.md](docs/known-limitations.md) | znane ograniczenia (uczciwa lista) |
| [docs/testing.md](docs/testing.md) | testy bezpieczeństwa i mapa wymagań |
| [docs/release-checklist.md](docs/release-checklist.md) | checklista przed publikacją wydania |
| [docs/privacy-and-network.md](docs/privacy-and-network.md) | telemetria, wszystkie połączenia sieciowe, przechowywane dane |
| [docs/updates-and-release.md](docs/updates-and-release.md) | aktualizacje, podpisy, wydanie, rollback, checklista |
| [docs/scripts.md](docs/scripts.md) | skrypty .bat |
| [docs/build.md](docs/build.md) | budowanie, testy, pakowanie |
| [docs/troubleshooting.md](docs/troubleshooting.md) | rozwiązywanie problemów, logi |
| [docs/feature-matrix.md](docs/feature-matrix.md) | macierz funkcji: zaimplementowane / częściowe / planowane |
| [SECURITY.md](SECURITY.md) | zgłaszanie podatności |
| [CHANGELOG.md](CHANGELOG.md) | historia zmian |

## Licencja

Kod i grafika OctoSuite: **MPL-2.0** (plik [LICENSE](LICENSE)). Komponenty zewnętrzne: [licenses/THIRD-PARTY-NOTICES.md](licenses/THIRD-PARTY-NOTICES.md).
