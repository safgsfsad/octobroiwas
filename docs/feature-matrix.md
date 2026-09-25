# Macierz funkcji

Legenda: ✅ zaimplementowane · 🟡 częściowo / z ograniczeniami · ⏳ planowane · ⛔ celowo pominięte

Stan weryfikacji: kod przechodzi `tsc` i 144 testy vitest, oba bundle budują się esbuild i ładują się w teście dymnym z atrapą Electrona. **Aplikacje nie zostały uruchomione w prawdziwym Electronie na Windows** w środowisku, w którym powstał ten kod (brak binarki Electron, PowerShell i Wine) – przed wydaniem wymagany jest test ręczny według checklisty w [updates-and-release.md](updates-and-release.md).

| # | Obszar | Stan | Uwagi |
|---|---|---|---|
| 1 | Branding: SVG, PNG 16–256, ICO, ikona instalatora | ✅ | oryginalne grafiki, osobne motywy obu aplikacji |
| 2 | Porównanie i wybór technologii | ✅ | [technology-choice.md](technology-choice.md) |
| 3 | Weryfikacja komponentów | ✅ | [components.md](components.md), `licenses\` |
| 4 | Profile: 7 typów, osobne dane i procesy | ✅ | |
| 4 | Utwórz / edytuj / duplikuj / usuń / reset | ✅ | operacje na plikach wymagają zamkniętego profilu |
| 4 | Import / eksport (tylko szyfrowany) | ✅ | |
| 4 | Blokada, auto-czyszczenie tymczasowych | ✅ | |
| 4 | Dodatki per profil | 🟡 | tylko wbudowane funkcje; zewnętrzne WebExtensions nieobsługiwane |
| 5 | AES-256-GCM, Argon2id, DPAPI | ✅ | [encryption.md](encryption.md) |
| 5 | Hasło główne (opcjonalne): ustawienie, zmiana, usunięcie, okno odblokowania | ✅ | Argon2id → AES-256-GCM; hasło nigdzie nie jest zapisywane; błędne hasło = brak dostępu, nie „pół” dostępu |
| 5 | Windows Credential Manager jako magazyn sekretów | ✅ | opcjonalnie, domyślnie wyłączone; tylko nazwy w `credman-index.json` |
| 5 | Auto-blokada (profil + klucz lokalny), kopie przed zmianą, wykrywanie uszkodzeń | ✅ | |
| 5 | Ostrzeżenie o granicach szyfrowania (malware) | ✅ | w kreatorze, oknie hasła i ustawieniach |
| 6 | Tryb ograniczony (kamera/mikrofon/USB/schowek) | ✅ | |
| 6 | Windows Sandbox + podsumowanie przed startem | ✅ | wymaga Pro/Enterprise/Education; niesprawdzone na żywym systemie |
| 6 | AppContainer | 🟡 | tylko piaskownica rendererów Chromium; brak pełnego AppContainer dla aplikacji |
| 7 | Presety Standard / Ścisły / Tor, bez losowania | ✅ | Tor = oficjalny Tor Browser |
| 8 | Raport OctoDetect z poziomami ryzyka | ✅ | niskie / średnie / wysokie / nie można określić |
| 8 | Test WebRTC | 🟡 | bez własnego serwera STUN; Standard = tylko interfejs publiczny, Ścisły/Tor = brak nieproxyowanego UDP |
| 8 | Wykrywanie rozszerzeń | ⛔ | technika fingerprintingu |
| 8 | Audyt zewnętrznej przeglądarki | 🟡 | odcisk mierzony w dowolnej przeglądarce; bez oceny izolacji profili, polityki ciasteczek osób trzecich i piaskownicy tej przeglądarki |
| 9 | Panel ruchu i sieci | ✅ | VPN wykrywany heurystycznie |
| 10 | Mikser dźwięku | 🟡 | głośność/wyciszanie kart i profilu, urządzenie wyjściowe; **brak korektora**; obejmuje karty bieżącego profilu |
| 11 | Wielozadaniowość (widok podzielony, PiP, grupy, usypianie, wyszukiwanie kart, sesje) | ✅ | wyskakujące okna otwierane jako karty bez `window.opener` |
| 12 | Dodatki z metadanymi i kontrolą integralności | ✅ | integralność = podpis aplikacji (wbudowane) / podpis producenta (zewnętrzne programy) |
| 12 | Listy filtrów | ✅ | tylko oficjalne URL, limit rozmiaru; offline – mała lista bazowa |
| 13 | 13 skryptów `.bat` (9 z wymagań + `github-update.bat`, `start-all.bat`, `setup.bat`, `run.bat` + nakładki `install.bat`/`run.bat` w katalogu głównym) | 🟡 | zaimplementowane; testy tylko statyczne (brak PowerShell w środowisku budowania) |
| 13 | Skrypty a zaszyfrowane `profiles.json` | 🟡 | trzeba podać id profilu |
| 13 | `restore-profile` usuniętego profilu | ✅ | skrypt zostawia `restored-entry.json`, aplikacja przywraca wpis (`adoptRestoredEntries`) |
| 14 | Instalator Inno Setup (obie aplikacje, per użytkownik, dane zachowane przy deinstalacji) | 🟡 | nieprzetestowany na żywym Windows; przy aktualizacji interaktywny kreator |
| — | Autoinstalacja wymagań (`install.bat`/`setup.bat`: winget + `npm ci` + build) i start bez konsoli (`run.bat`) | ✅ | winget nietestowany na żywym Windows |
| — | Aktualizacja z GitHuba i start obu aplikacji z pliku `.bat` | ✅ | `github-update.bat` (wydanie lub kopia deweloperska), `start-all.bat` |
| 15 | Updater: harmonogram, ręcznie, lista zmian, waga, odłożenie, kopia, SHA-256 + Ed25519 + Authenticode, oficjalne źródło, rollback | ✅ | wyłączony (fail-closed) do czasu `npm run keygen` |
| 16 | UI OctoBrowser (PL/EN) | ✅ | |
| 17 | UI OctoDetect z ekranem startowym (PL/EN) | ✅ | |
| 17 | Ochrona klucza: DPAPI **albo** hasło główne | ✅ | wybór w kreatorze i w Ustawieniach; nieczytelny klucz jest kwarantannowany, nie blokuje startu |
| — | Szyfrowanie i odzyskiwanie profilu 12-wyrazową frazą | ✅ | BIP-39 (`packages/core/src/mnemonic.ts`), fraza przy włączaniu szyfrowania, przy otwieraniu, eksporcie i imporcie profilu |
| — | Interfejs czarno-biały, minimalistyczny, z ikonami | ✅ | wspólne tokeny w `packages/shell/renderer/shared.css`, brak barw znaczeniowych, odstępy `--gap`/`--gap-lg`; test `ui-contrast.test.ts` pilnuje kontrastu i monochromatu |
| — | Pusty ekran startowy zamiast pustej listy profili | ✅ | przyciski „Przeglądanie prywatne” i „Nowy profil” na środku |
| — | Przeglądanie prywatne (profil tymczasowy, jeden klik) | ✅ | poziom Ścisły, dane usuwane po zamknięciu; bez obietnic anonimowości |
| — | Tworzenie profilu: zakładki + podsumowanie na żywo | ✅ | `mgr:create` przyjmuje nazwę, typ i poprawkę ustawień; test `profiles.test.ts` |
| — | Motyw okna profilu: ciemny szary / biały | ✅ | `Profile.theme`, wybór przy tworzeniu i w edycji; białe okno ma zaokrąglone karty i jasny pasek adresu; test `profiles.test.ts` |
| — | Monochromatyczna strona nowej karty | ✅ | tylko szarości, stan pokazuje kształt znacznika i słowo; `internal.css` objęty testem kontrastu i monochromatu |
| — | Pasek zakładek | ✅ | `ui.showBookmarksBar`, menu i Ustawienia → Karty; test waliacji ustawień |
| — | Zmiana folderu danych z kopią i restartem | ✅ | `mgr:pick-folder` + `mgr:move-data`, kopia przed zapisem `bootstrap.json`, stary folder bez zmian |
| — | Cienkie paski przewijania, nie nachodzące na tekst | ✅ | 10 px, `scrollbar-width: thin`, `background-clip: content-box` w każdym arkuszu renderera |
| — | Zamykanie okna: zapis sesji, okno „Zamykanie…”, wymuszenie zamknięcia | ✅ | przechwycenie zdarzenia `close`, `ui:close-request` / `ui:close-ok`; czerwony dopisek „(możliwa utrata danych)” jest jedynym udokumentowanym wyjątkiem od monochromatu |
| — | Windows Sandbox oznaczona jako wersja testowa + ostrzeżenie o VPN | ✅ | `describeIsolation()` dodaje wiersz ostrzegawczy przy aktywnym VPN; opisana naprawa (split tunnelling) |
| — | Wyszukiwarka w pasku adresu (4 silniki, bez podpowiedzi sieciowych) | ✅ | `network.searchEngine`, `searchEngineQueryUrl()`; test waliacji ustawień |
| — | Przełączniki z widocznym stanem (tekst + kształt) | ✅ | `toggle()` dopisuje „Włączone/Wyłączone”; włączony przełącznik ma ciemny wskaźnik na białym torze |
| — | Dokumentacja: model zagrożeń, znane ograniczenia, szyfrowanie, testy, checklista wydania | ✅ | `docs/threat-model.md`, `docs/known-limitations.md`, `docs/encryption.md`, `docs/testing.md`, `docs/release-checklist.md` |
| 18 | Telemetria wyłączona, dokumentacja połączeń | ✅ | [privacy-and-network.md](privacy-and-network.md) |
| 19 | Logi standardowe/diagnostyczne, „Usuń logi” | ✅ | |
| 20 | Testy jednostkowe | ✅ | 20 plików, 144 testy ([testing.md](testing.md)) |
| 20 | Testy E2E (Playwright + Electron) | ✅ | `e2e\*.spec.ts`, uruchamiane w CI na `windows-latest` (job „windows”) |
| 20 | Weryfikacja fuse’ów Electrona w paczce | ✅ | `tools/check-fuses.mjs` po `npm run dist:dir` w CI |
| 21 | Struktura katalogów | ✅ | [architecture.md](architecture.md) |
| 22 | Dokumentacja | ✅ | `docs\` |
| — | Jednorazowy wybór języka i folderu danych | ✅ | |
| — | Wyszukiwarka | ✅ | DuckDuckGo domyślnie, bez podpowiedzi sieciowych |
| — | Świeża instalacja: weryfikacja Ed25519 w `install.bat` | 🟡 | wymaga Node.js lub już zainstalowanej aplikacji; inaczej świadome potwierdzenie |
| — | Funkcje antydetect / antyfraud / losowanie parametrów | ⛔ | poza zakresem projektu |
