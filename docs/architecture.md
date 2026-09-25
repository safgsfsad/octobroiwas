# Architektura OctoSuite

## Warstwy

```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ apps/octobrowser (Electron)  │   │ apps/octodetect (Electron)   │
│  main: manager + runtime     │   │  main: auditor + probe-server│
│  preload: chrome/tab/launcher│   │  preload: detect (+ shim)    │
│  renderer: browser/launcher  │   │  renderer: detect, probe     │
└──────────────┬───────────────┘   └──────────────┬───────────────┘
               │  packages/shell (wspólny kod Electron)             
               │  kreator, odblokowanie (hasło główne), hardening,  
               │  IPC, sesje, adblock, update-manager, okna, CLI verify 
               └────────────────────┬───────────────────────────────
                        packages/core (czysty Node, testowany vitest)
                        crypto, keyring, secretstore, config (VersionedStore),
                        profiles, privacy, network, sandbox, audit, updater,
                        release-verify, report-html, i18n (en/pl), logger
```

* `packages/core` nie importuje Electrona – całą logikę bezpieczeństwa da się testować jednostkowo.
* `packages/shell/src/keyring-recovery.ts` – wspólna ścieżka odzyskiwania klucza (kwarantanna + nowy klucz), używana przy starcie i w oknie hasła głównego.
* `packages/shell/src/unlock.ts` + `renderer/unlock.html` – okno hasła głównego (retry, „nie pamiętam hasła”, anulowanie = koniec pracy aplikacji).
* `packages/core/src/credman.ts` – opcjonalny magazyn sekretów w Menedżerze poświadczeń Windows (JSON na stdin/stdout do PowerShella, bez argumentów wiersza poleceń).
* Kod jest bundlowany przez esbuild (`tools/build.mjs`) do `apps/<app>/dist`; w paczce nie ma `node_modules`.
* Wersja pakietu jest jedna (root `package.json`), wstrzykiwana jako `__OCTO_VERSION__`.

## OctoBrowser.su – procesy

| Proces | Rola |
|---|---|
| **Menedżer** (`OctoBrowser.su.exe`) | okno „Profile i ustawienia”, jedyny zapisujący `profiles.json` i `settings.json`, trzyma klucz danych (DEK), uruchamia procesy profili, aktualizacje, auto-blokada |
| **Proces profilu** (`--profile-process=<id>`) | osobna instancja Electron z własnym `userData` (`profiles\<id>\engine`), własną sesją Chromium, oknami i kartami |
| Renderery kart | piaskownica Chromium, `contextIsolation`, `sandbox: true`, bez Node |

Komunikacja menedżer ↔ profil: prywatny, dziedziczony potok dwukierunkowy na deskryptorze 3 procesu profilu (JSON-lines). Nie stdin – w Electronie na Windows `process.stdin` procesu głównego zwraca wyłącznie EOF, więc klucz nigdy by nie dotarł (wykryte przez testy E2E w CI). Klucz danych nie trafia do argumentów ani zmiennych środowiskowych.

* menedżer → profil: `init{key}` (klucz przekazywany tylko przez potok, nigdy w argumentach/zmiennych środowiskowych), `profile-updated`, `settings-updated`, `update-status`, `filters-updated`, `focus`, `open-url`, `quit`;
* profil → menedżer: `ready`, `open-launcher`, `update-profile`, `check-updates`, `launch-detect`, `launch-sandbox`, `update-settings`.

Przy zamknięciu profilu: `cleanupEphemeral` (profile tymczasowe) → `sealVault` (szyfrowanie danych silnika, jeśli włączone) → wymazanie klucza z pamięci.

Linki `octobrowser://open?profile=<id|nazwa>` i `--open-profile=<id>` otwierają wskazany profil.

### Okno przeglądarki

* **chrome** (pasek kart, adres, panele) to zaufany renderer z preloadem `preload-chrome.js` – kanały `ui:*`;
* karty to `WebContentsView` nałożone na obszar treści, z preloadem `preload-tab.js` (normalizacja API zgodnie z presetem – wartości stałe dla profilu);
* strony wewnętrzne: `octo://newtab`, `octo://error`, `octo://https-only` (CSP `default-src 'self'`).

## OctoDetect.su

* jedno okno (`preload-detect.js`, kanały `od:*`);
* **serwer testowy** na `127.0.0.1`, losowy port, jednorazowy token, sprawdzanie nagłówków `Host` i `Origin`, limit treści 256 KB;
* cele audytu: `baseline` (czysta sesja w pamięci), `standard`/`strict` (syntetyczny profil z tym samym preloadem co karty OctoBrowser), `external` (dowolna przeglądarka przez `shell.openExternal`);
* raporty zapisywane jako zaszyfrowane pliki `.odr` (AES-256-GCM, kontekst `octodetect-report-v1`), eksport do JSON lub statycznego HTML bez skryptów.

## Układ danych

Folder bazowy wybierany przy pierwszym uruchomieniu (domyślnie `Dokumenty\OctoSuite`):

```
<baza>\OctoBrowser\
  config\        settings.json, profiles.json (koperta z SHA-256, kopia przed każdą zmianą),
                 keyring.bin (DEK tylko w postaci opakowanej: DPAPI albo hasło główne),
                 secrets.bin (zaszyfrowane sekrety, np. hasła proxy),
                 credman-index.json (tylko NAZWY poświadczeń w Menedżerze poświadczeń Windows)
  profiles\<id>\ engine\ (dane Chromium), engine.vault, bookmarks.enc, history.enc, session.enc, downloads\
  engine\  downloads\  backups\  updater\  logs\  temp\  filters\
<baza>\OctoDetect\
  config\  reports\  backups\  updater\  logs\  temp\
%APPDATA%\OctoBrowser.su\bootstrap.json   język + ścieżka folderu danych (bez sekretów)
%APPDATA%\OctoDetect.su\bootstrap.json
```

Tryb przenośny: plik `portable.flag` obok `.exe` → `bootstrap.json` zapisywany obok programu.

## Sekwencja startu (po pierwszym uruchomieniu)

```
main.ts -> prepareApp (ścieżki, switche Chromium) -> app.whenReady
  -> startApp (packages/shell/src/context.ts)
       odmowa pracy jako administrator
       logger -> settings (VersionedStore, kopia przed zmianą)
       keyring:
         brak pliku          -> utworzenie (DPAPI)
         --reset-keyring     -> recoverKeyring (kwarantanna + nowy klucz)
         mode 'os'           -> automatyczne odblokowanie DPAPI
         mode 'password'     -> okno hasła głównego (unlock.ts)
       secrets -> SecretRouter (secrets.bin albo Menedżer poświadczeń Windows)
  -> hardenApp -> okno aplikacji
```

## Instalacja

Instalator Inno Setup instaluje obie aplikacje obok siebie (`{app}\OctoBrowser`, `{app}\OctoDetect`) – każda znajduje drugą przez `..\<Inna>\<Inna>.su.exe`. Domyślnie instalacja per użytkownik (bez uprawnień administratora). Ten sam plik `OctoSuite-Setup-<wersja>.exe` jest pakietem aktualizacji dla obu aplikacji.

## Hardening Electrona

* fuse’y: `runAsNode=false`, `enableNodeOptionsEnvironmentVariable=false`, `enableNodeCliInspectArguments=false`, `enableEmbeddedAsarIntegrityValidation=true`, `onlyLoadAppFromAsar=true`, `enableCookieEncryption=true`, `grantFileProtocolExtraPrivileges=false`;
* `app.enableSandbox()`, `contextIsolation`, brak `nodeIntegration`, blokada `<webview>`, blokada nawigacji zaufanych okien poza `dist`, IPC przyjmowane tylko z zaufanych `webContents`;
* odmowa uruchamiania z uprawnieniami administratora (ostrzeżenie).
