# Checklista przed publikacją wydania

Odpowiadaj „tak” tylko wtedy, gdy faktycznie sprawdziłeś punkt na docelowym
systemie (Windows 10/11 x64, użytkownik bez uprawnień administratora).

## Kod i jakość

- [ ] `npm run typecheck` – bez błędów
- [ ] `npm test` – wszystkie testy jednostkowe przechodzą
- [ ] `npm run i18n:check` – słowniki PL/EN w parji (0 brakujących)
- [ ] `npm run build` – oba bundlą się bez ostrzeżeń
- [ ] `npm run e2e` – Playwright + Electron na `windows-latest` zielony
- [ ] `npm run test:scripts` – Pester zielony
- [ ] Wersja w `package.json`, `CHANGELOG.md` i komentarzu wydania są zgodne

## Bezpieczeństwo

- [ ] W repozytorium **nie ma** sekretów: `git grep -iE "password|secret|token|BEGIN (RSA|EC|OPENSSH)"` (poza dokumentacją)
- [ ] Klucz prywatny aktualizacji (`update-private-key*`) **nie** jest w repo ani w paczce
- [ ] `npm run keygen` wykonany raz; publiczny klucz w `packages/core/src/update-public-key.ts`
- [ ] `npm run check-fuses` – fuse’y Electrona zgodne z polityką
- [ ] Żaden komunikat UI nie obiecuje „100% bezpieczeństwa / anonimowości / niewykrywalności” (test i18n to pilnuje)
- [ ] Logi nie zawierają haseł, tokenów, ciasteczek ani adresów stron (sprawdź `logs\` po sesji testowej)
- [ ] Sprawdzone: brak funkcji antydetect / antyfraud / omijania CAPTCHA w diffie

## Budowa i podpis

- [ ] `npm run icons` – PNG 16–256 + ICO dla obu aplikacji i instalatora
- [ ] `npm run dist` – `release\<app>\win-unpacked` + zip dla obu aplikacji
- [ ] `npm run installer` – `release\OctoSuite-Setup-<wersja>.exe`
- [ ] Pliki podpisane Authenticode (certyfikat EV/OV): `OctoBrowser.su.exe`, `OctoDetect.su.exe`, instalator
- [ ] `npm run hashes` – `release\SHA256SUMS.txt`
- [ ] `npm run sign-manifest -- --severity ... --notes-en ... --notes-pl ...` – manifest aktualizacji podpisany Ed25519
- [ ] `npm run licenses` – `licenses\THIRD-PARTY-NOTICES.md` aktualne

## Testy ręczne na czystym Windowsie

- [ ] Instalacja z `OctoSuite-Setup-<wersja>.exe`, katalog niestandardowy **ze spacją i polskimi znakami**
- [ ] Kreator pierwszego uruchomienia: język, folder danych, ochrona klucza (DPAPI **i** hasło główne)
- [ ] Start z `open.bat`, `open-detect.bat`, `run.bat`, `start-all.bat`
- [ ] Okno hasła głównego: poprawne hasło, błędne hasło (3 próby), „nie pamiętam hasła” (kwarantanna)
- [ ] Każdy z 7 profili: utworzenie, uruchomienie, izolacja ciasteczek, zamknięcie
- [ ] Profil tymczasowy czyści się po zamknięciu; profil zaszyfrowany zamyka się w `engine.vault`
- [ ] Eksport profilu (zaszyfrowany) → import na „innym komputerze” (inny folder danych) z tą samą 12-wyrazową frazą
- [ ] Menedżer poświadczeń: włączenie, zapisanie haseł proxy, przełączenie z powrotem na plik
- [ ] Windows Sandbox: start profilu, podsumowanie przed startem, brak kamery/mikrofonu/schowka, dane znikają po zamknięciu
- [ ] Tryb ograniczony na systemie bez Windows Sandbox
- [ ] Panel ruchu: IP, DNS, WebRTC, HTTPS, liczniki, certyfikat
- [ ] OctoDetect: audyt `baseline`, `standard`, `strict`, `external`; raport HTML/JSON; poziom ryzyka
- [ ] Aktualizacja: sprawdzenie ręczne, pobranie, instalacja, restart, rollback
- [ ] `repair.bat`, `reset-profile.bat`, `backup-profile.bat`, `restore-profile.bat`, `uninstall.bat`
- [ ] Restart komputera i ponowny start aplikacji (auto-blokada, stan profili)
- [ ] Deinstalacja: skróty i rejestry usunięte, folder danych zachowany i wyraźnie oznaczony

## Po publikacji

- [ ] Tag wydania i opis z changelogiem PL/EN
- [ ] Sprawdzone, że `latest.json` i `.sig` są dostępne publicznie
- [ ] Szybki test aktualizacji z poprzedniej wersji (ścieżka upgrade)
