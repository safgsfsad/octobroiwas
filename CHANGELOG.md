# Changelog / Historia zmian

**PL – ekran startowy, przeglądanie prywatne i nowe okno tworzenia profilu**
- **Pusty ekran startowy**: gdy nie ma żadnego profilu, widok Profile pokazuje na środku ikonę, krótki opis i dwa przyciski – **Przeglądanie prywatne** i **Nowy profil** – zamiast pustej siatki.
- **Przeglądanie prywatne**: jeden klik tworzy tymczasowy profil w poziomie Ścisły i od razu go otwiera; historia, ciasteczka, pamięć podręczna i dane witryn są usuwane po zamknięciu, a profil znika z listy (`mgr:private-browse`, `privateBrowsingPatch()` w `packages/core/src/profiles.ts`). Komunikat wyraźnie mówi, że tryb prywatny nie zapewnia anonimowości w internecie.
- **Nowe okno tworzenia profilu**: zakładki **Ogólne / Prywatność / Sieć / Piaskownica** po lewej i **podsumowanie na żywo** po prawej (nazwa, typ, poziom, tryb sieci, WebRTC, canvas, WebGL, informacje o sprzęcie, izolacja, historia, czyszczenie, usuwanie profilu). `mgr:create` przyjmuje teraz nazwę, typ i poprawkę ustawień; stary, dwuargumentowy sposób wywołania nadal działa.
- **Nowe testy**: `ui-i18n.test.ts` (każda etykieta UI istnieje w PL i EN, także etykiety dynamiczne) oraz przypadki w `profiles.test.ts` dla przeglądania prywatnego i poprawki ustawień – łącznie 139 testów.

**EN – empty start screen, private browsing and a new create-profile dialog**
- **Empty start screen**: with no profiles the Profiles view shows a centred icon, a short explanation and two buttons - **Private browsing** and **New profile** - instead of an empty grid.
- **Private browsing**: one click creates a temporary Strict profile and opens it; history, cookies, cache and site data are deleted on close and the profile disappears from the list (`mgr:private-browse`, `privateBrowsingPatch()` in `packages/core/src/profiles.ts`). The dialog states plainly that private browsing does not make you anonymous on the internet.
- **New create-profile dialog**: tabs **General / Protection / Network / Isolation** on the left and a **live summary** on the right (name, type, level, network mode, WebRTC, canvas, WebGL, hardware info, isolation, history, cleanup, delete-on-close). `mgr:create` now accepts name, kind and a settings patch; the legacy two-argument call still works.
- **New tests**: `ui-i18n.test.ts` (every UI label exists in PL and EN, dynamic ones included) plus private-browsing and create-patch cases in `profiles.test.ts` - 139 tests in total.

**PL – widoczne przełączniki, okno „Zamykanie…”, Piaskarnica jako wersja testowa, więcej ustawień**
- **Naprawione niewidoczne przełączniki**: włączony przełącznik miał biały wskaźnik na białym torze (nic nie było widać). Teraz włączony stan to ciemny wskaźnik na białym torze, a obok etykiety zawsze pojawia się tekst *Włączone / Wyłączone* – stan nie zależy już od kształtu ani barwy.
- **Zamykanie okna z zapisem**: zdarzenie zamknięcia okna jest przechwytywane. Zamiast uciąć proces, w oknie pojawia się minimalistyczne, monochromatyczne okno **„Zamykanie…”** z informacją, co się dzieje (zapis sesji i *n* kart, opróżnianie ciasteczek i danych – albo informacja, że profil nie zapisuje sesji). Dostępne są **Wymuś zamknięcie** z małym czerwonym dopiskiem *(możliwa utrata danych)* (jedyny udokumentowany wyjątek od monochromatu) oraz **Kontynuuj przeglądanie**. Wymuszenie trafia do logu jako `window.force-closed`. Całość wyłącza się w Ustawieniach → Karty.
- **Windows Sandbox jako wersja testowa**: opcja jest tak oznaczona w oknach tworzenia i edycji profilu, a w podsumowaniu przed uruchomieniem pojawia się wiersz „Status: wersja testowa”. Gdy w systemie wykryty jest aktywny VPN, do podsumowania dodawany jest wiersz ostrzegawczy: Piaskarnica to jednorazowa maszyna wirtualna z własnym przełącznikiem, a filtry klienta VPN (zwłaszcza „kill switch”) mogą w niej blokować sieć. Aplikacja nie rusza konfiguracji VPN-a – podaje naprawę (split tunnelling dla Piaskarnicy) albo uruchomienie profilu w trybie ograniczonym.
- **Więcej ustawień**: wyszukiwarka w pasku adresu (DuckDuckGo, Startpage, Brave Search, Mojeek – bez podpowiedzi sieciowych), „Pytaj przed zamknięciem okna”, „Otwieraj linki z zakładek i historii w tle”. Każda nowa wartość przechodzi przez `validateSettings`, który odrzuca wartości nieznanego typu.
- Testy: +2 przypadki (silniki wyszukiwania, booleanowość przełączników) – łącznie 144.

**EN – visible switches, a "Closing…" window, Windows Sandbox as a test version, more settings**
- **Fixed invisible switches**: an enabled switch drew a white knob on a white track, so nothing was visible. An enabled switch now has a dark knob on a white track, and the label is always followed by the words *On / Off* - the state no longer depends on shape or colour.
- **Closing a window saves first**: the window close event is intercepted. Instead of cutting the process short, a minimal monochrome **"Closing…"** overlay appears, saying what is happening (saving the session and *n* tabs, flushing cookies and profile data - or that this profile keeps no session). It offers **Force close** with a small red *(may lose data)* note (the single documented exception to the monochrome design) and **Keep browsing**. A forced close is logged as `window.force-closed`. The whole behaviour can be switched off in Settings → Tabs.
- **Windows Sandbox marked as a test version**: the option is labelled that way in the create and edit dialogs, and the pre-launch summary gains a "Status: test version" row. When an active VPN is detected, an extra warning row explains that the sandbox is a disposable VM with its own virtual switch and that VPN client filters (a kill switch in particular) can block its network. The app does not touch the VPN configuration - it states the fix (split tunnelling for Windows Sandbox) or running the profile in restricted mode.
- **More settings**: address-bar search engine (DuckDuckGo, Startpage, Brave Search, Mojeek - none of them sends network suggestions), "Ask before a window closes" and "Open bookmark and history links in the background". Every new value goes through `validateSettings`, which rejects unknown types.
- Tests: +2 cases (search engines, switch booleans) - 144 in total.

**PL – monochromatyczny interfejs, motyw okna, pasek zakładek i zmiana folderu danych**
- **Cienkie paski przewijania**: w każdym arkuszu interfejsu (menedżer, okno przeglądarki, strony wewnętrzne `octo://`, OctoDetect) pasek ma 10 px, `scrollbar-width: thin` i wewnętrzny margines (`background-clip: content-box`), więc nie nachodzi na tekst – wcześniej szeroki pasek Windowsa przykrywał treść paneli.
- **Motyw okna profilu**: nowe pole `Profile.theme` (`dark` = ciemny szary, `light` = biały) wybierane przy tworzeniu profilu i w jego edycji. Motyw obowiązuje pasek kart, pasek narzędzi, panele i wbudowaną stronę nowej karty; w wariancie białym karty są zaokrąglone, a pasek adresu jasny i mocno zaokrąglony. Treść stron nie jest zmieniana.
- **Monochromatyczna strona nowej karty**: usunięte gradienty i barwny akcent (`--accent`/`--accent2`). Stan kafelka (ochrona, DNS, WebRTC…) pokazuje kształt znacznika – pełne kółko, obwódka, pusty prostokąt – oraz słowo w wartości, więc nie zależy od rozróżniania kolorów.
- **Panel prywatności reaguje od razu na zmianę poziomu**: `ui:set-level` stosuje najpierw nowe ustawienia lokalnie (jak to już robi `ui:audio`), więc panel nie pokazuje już wartości poprzedniego poziomu. Pełne działanie nowego poziomu – jak wcześniej – obejmuje nowe okna i karty.
- **Pasma ryzyka w OctoDetect**: przeliczone progi (wysoki ≥ 14, średni ≥ 5). Punkty poszczególnych ustaleń nie zmieniły się – zmieniły się tylko progi, tak aby zwykły Chromium wypadał jako wysoki, OctoBrowser Standard jako średni, a OctoBrowser Ścisły jako niski. Nowy test pilnuje tej kolejności.
- **Pasek zakładek**: nowe ustawienie `ui.showBookmarksBar` (menu okna albo Ustawienia → Karty) pokazuje zakładki jako zwykłe przyciski pod paskiem adresu.
- **Zmiana folderu danych**: Ustawienia → Ogólne → **Zmień…** kopiuje profile, ustawienia, logi i kopie do nowego folderu, zapisuje go w `bootstrap.json` i uruchamia aplikację ponownie. Kopia jest wykonywana przed zapisem nowej ścieżki, stary folder zostaje bez zmian. Folder w katalogu instalacji i w katalogach systemowych jest odrzucany.
- Testy: +4 przypadki (motyw profilu, przełącznik paska zakładek, kolejność wyników audytu) – łącznie 142.

**EN – monochrome interface, window theme, bookmarks bar and data-folder move**
- **Thin scrollbars**: every renderer stylesheet (launcher, browser window, internal `octo://` pages, OctoDetect) now uses a 10 px scrollbar with `scrollbar-width: thin` and an inner margin (`background-clip: content-box`), so it no longer covers the text - the wide Windows default scrollbar used to sit on top of panel content.
- **Per-profile window theme**: new `Profile.theme` field (`dark` = dark grey, `light` = white), chosen when the profile is created and in the profile editor. It applies to the tab strip, toolbar, panels and the built-in new tab page; in the white variant tabs are pill-shaped and the address bar is light and strongly rounded. Page content is not changed.
- **Monochrome new tab page**: gradients and the coloured accent (`--accent`/`--accent2`) are gone. A card's state (protection, DNS, WebRTC...) is shown by the shape of its marker - filled circle, ring, hollow square - plus the value written out in words, so nothing depends on colour vision.
- **Privacy panel follows a level switch immediately**: `ui:set-level` now applies the new settings locally first (as `ui:audio` already did), so the panel no longer renders the previous level's values. A new level still only takes full effect in new windows and pages.
- **OctoDetect risk bands recalibrated**: high ≥ 14, medium ≥ 5. Finding points are unchanged - only the thresholds moved, so a plain Chromium lands high, OctoBrowser Standard medium and OctoBrowser Strict low. A new test guards that ordering.
- **Bookmarks bar**: new `ui.showBookmarksBar` setting (window menu or Settings → Tabs) shows bookmarks as plain buttons under the address bar.
- **Data folder move**: Settings → General → **Change…** copies profiles, settings, logs and backups to the new folder, records it in `bootstrap.json` and restarts the app. The copy happens before the new path is written and the old folder is left untouched. Folders inside the install directory or system folders are refused.
- Tests: +4 cases (profile theme, bookmarks-bar switch, audit score ordering) - 142 in total.

## 0.1.0 – wersja wstępna (niewydana)

**PL – rozszerzenie ochrony klucza**
- **Opcjonalne hasło główne**: kreator pierwszego uruchomienia (krok 3) pozwala wybrać ochronę klucza danymi konta Windows (DPAPI, bez hasła) albo hasłem głównym (Argon2id → AES-256-GCM). Hasło można później ustawić, zmienić lub usunąć w Ustawieniach → Bezpieczeństwo obu aplikacji; zmiana hasła nie zmienia klucza danych, więc wszystkie zaszyfrowane dane pozostają czytelne.
- **Okno hasła głównego** (`packages/shell/src/unlock.ts`, `renderer/unlock.html`): ponowne odblokowanie przy starcie, po auto-blokadzie i po zablokowaniu ekranu; 3 nieudane próby = komunikat z możliwością rozpoczęcia z nowym kluczem; „Nie pamiętam hasła” przenosi stary klucz do `backups\unreadable-<data>` (nic nie jest usuwane); anulowanie kończy pracę aplikacji.
- **Auto-blokada rozszerzona o klucz lokalny**: przy haśle głównym po czasie bezczynności blokowany jest także klucz danych (wcześniej tylko zaszyfrowane profile).
- **Menedżer poświadczeń Windows** jako opcjonalne miejsce przechowywania sekretów (np. haseł proxy): `packages/core/src/credman.ts` (CredWriteW/CredReadW/CredDeleteW przez PowerShella, JSON na stdin/stdout – bez sekretów w wierszu poleceń), przełącznik w Ustawieniach → Bezpieczeństwo, `config\credman-index.json` przechowuje wyłącznie nazwy.
- **Nowa dokumentacja**: `docs/encryption.md` (instrukcja szyfrowania), `docs/threat-model.md` (model zagrożeń), `docs/known-limitations.md`, `docs/testing.md` (mapa testów bezpieczeństwa), `docs/release-checklist.md` (checklista przed publikacją).
- Testy: +15 przypadków (hasło główne, Menedżer poświadczeń, router sekretów) – łącznie 130.

**EN – key protection extension**
- **Optional master password**: the first-run wizard (step 3) now offers Windows-account (DPAPI, no password) or master-password protection (Argon2id → AES-256-GCM). It can be set, changed and removed later in Settings → Security of either app; changing it re-wraps the same data key, so all encrypted data stays readable.
- **Master-password window** (`packages/shell/src/unlock.ts`, `renderer/unlock.html`): re-unlock on start, after auto-lock and after the screen locks; 3 wrong attempts offer starting with a new key; "I do not remember the password" quarantines the old key in `backups\unreadable-<date>` (nothing is deleted); cancelling quits the app.
- **Auto-lock extended to the local key**: with a master password the data key is locked after the idle time as well (previously only encrypted profiles).
- **Windows Credential Manager** as an optional secret store (e.g. proxy passwords): `packages/core/src/credman.ts` (CredWriteW/CredReadW/CredDeleteW via PowerShell, JSON on stdin/stdout - no secrets on a command line), switch in Settings → Security, `config\credman-index.json` holds names only.
- **New documentation**: `docs/encryption.md`, `docs/threat-model.md`, `docs/known-limitations.md`, `docs/testing.md`, `docs/release-checklist.md`.
- Tests: +15 cases (master password, Credential Manager, secret router) - 130 in total.

**PL – poprawki interfejsu**
- **Naprawione niewidoczne etykiety**: przyciski „Uruchom”, „Nowy profil” i inne klasy `btn primary` miały biały tekst na białym tle (tekst i ikona były niewidoczne), tak samo aktywny przycisk poziomu ochrony (`seg button.on`) i numer aktywnego kroku w kreatorze. Teraz tekst na białym tle jest czarny.
- **Karty profili**: pod nazwą profilu nie powtarza się już jego typ („Personal / Personal”, „Work / Work”…) – zamiast tego krótki opis roli profilu (`profile.kindTag.*`).
- **Proxy systemowe**: etykieta trybu sieci brzmi teraz „Proxy systemowe” / „System proxy” zamiast „Ustawienia systemowe”, które wyglądało jak odsyłacz do ustawień.
- **Monochromatyczny interfejs**: usunięte pozostałości barw (zielony/amber/różowy) z OctoDetect i OctoBrowser; stan zawsze opisują ikona, waga tekstu i podpis.
- **Nowy test UI** (`packages/shell/test/ui-contrast.test.ts`): sprawdza kontrast każdej reguły `background` + `color` (≥ 3:1) i zakazuje barw w arkuszach stylów – regresja „białe na białym” nie przejdzie już przez `npm test`.
- Testy: +3 przypadki – łącznie 133.

**EN – UI fixes**
- **Invisible labels fixed**: `.btn primary` buttons ("Launch", "New profile", …) had white text on a white background - label and icon were invisible; the same applied to the active protection-level segment and to the active step number in the first-run wizard. Text on white is now black.
- **Profile cards**: the profile type no longer repeats the profile name ("Personal / Personal", "Work / Work" …); a short role description (`profile.kindTag.*`) is shown instead.
- **System proxy**: the network mode now reads "System proxy" / "Proxy systemowe" instead of "System settings", which looked like a link to the settings page.
- **Monochrome UI**: leftover hues (green/amber/rose) removed from OctoDetect and OctoBrowser; state is always carried by icon, weight and a text label.
- **New UI test** (`packages/shell/test/ui-contrast.test.ts`): checks the contrast of every `background` + `color` rule (>= 3:1) and forbids hues in the stylesheets, so "white on white" cannot regress through `npm test` again.
- Tests: +3 cases - 133 in total.

## 0.1.0 – wersja wstępna (niewydana)

**PL**
- Pierwsza wersja OctoBrowser.su i OctoDetect.su dla Windows 10/11.
- Profile (osobisty, praca, prywatny, testowy, tymczasowy, Tor, własny) w osobnych procesach, szyfrowanie AES-256-GCM, klucz lokalny chroniony DPAPI.
- **Bez hasła głównego**: aplikacja startuje bez pytania o cokolwiek, a klucza, którego Windows nie potrafi już odszyfrować (DPAPI), nie blokuje startu – trafia do kwarantanny w `backups\unreadable-<data>`, powstaje nowy (`--reset-keyring` wymusza to ręcznie).
- **12-wyrazowa fraza (BIP-39)** szyfruje profil i pozwala go odzyskać: pokazywana raz przy włączaniu szyfrowania, wymagana przy otwieraniu zaszyfrowanego profilu oraz przy eksporcie i imporcie.
- Interfejs obu aplikacji przerobiony na czarno-biały i minimalistyczny: ikony zamiast barw znaczeniowych, wyraźne odstępy między informacjami i polami.
- Poziomy ochrony Standard / Ścisły / Tor (wartości stałe, bez losowania), blokowanie reklam i trackerów, tylko HTTPS, usuwanie parametrów śledzących.
- Panele: ruch i sieć, dźwięk, prywatność; widok podzielony, obraz w obrazie, grupy i usypianie kart.
- OctoDetect.su: lokalny audyt prywatności z poziomami ryzyka, zaszyfrowane raporty, eksport JSON/HTML.
- Aktualizacje podpisane Ed25519 + SHA-256, rollback; instalator Inno Setup; skrypty serwisowe.
- Interfejs po polsku i angielsku; brak telemetrii.
- `install.bat` / `setup.bat` – autoinstalacja wymagań (Node.js, git przez winget, `npm ci`, `npm run build`) i `run.bat` – uruchomienie obu aplikacji bez okna konsoli.
- `github-update.bat` – aktualizacja prosto z GitHuba (wydanie albo `git pull` + `npm ci` + `npm run build` w kopii deweloperskiej) oraz `start-all.bat` – aktualizacja i uruchomienie obu aplikacji jednym plikiem.

**EN**
- First version of OctoBrowser.su and OctoDetect.su for Windows 10/11.
- Profiles in separate processes, AES-256-GCM encryption, local key protected by DPAPI.
- **No master password**: the app starts without asking for anything, and a key Windows can no longer decrypt (DPAPI) never blocks the start - it is quarantined in `backups\unreadable-<date>` and replaced (`--reset-keyring` forces this manually).
- **12-word passphrase (BIP-39)** encrypts a profile and recovers it: shown once when encryption is enabled, required to open an encrypted profile and to export or import one.
- Both UIs reworked to a black-and-white, minimal design: icons instead of meaningful colours, clear spacing between information and input fields.
- Standard / Strict / Tor protection levels (fixed values, no randomisation), ad and tracker blocking, HTTPS-only, tracking-parameter removal.
- Traffic, audio and privacy panels; split view, picture-in-picture, tab groups and sleeping tabs.
- OctoDetect.su: local privacy audit with risk levels, encrypted reports, JSON/HTML export.
- Ed25519 + SHA-256 signed updates with rollback; Inno Setup installer; maintenance scripts.
- Polish and English UI; no telemetry.
- `install.bat` / `setup.bat` - automatic setup of all prerequisites (Node.js, git via winget, `npm ci`, `npm run build`) and `run.bat` - starts both apps with no console window.
- `github-update.bat` - update straight from GitHub (release install, or `git pull` + `npm ci` + `npm run build` in a development checkout) and `start-all.bat` - update and start both apps from a single file.
