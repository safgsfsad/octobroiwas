# Wybór technologii

## Wymagania decydujące

1. Osobne profile z pełną izolacją danych (ciasteczka, pamięć, cache) i możliwością szyfrowania „w spoczynku”.
2. Pełna kontrola nad żądaniami sieciowymi (blokowanie, HTTPS-only, parametry śledzące, proxy per profil, DoH).
3. Własny, spójny interfejs PL/EN i dwie osobne aplikacje z jednej bazy kodu.
4. Budowanie i podpisywanie na Windows 10/11, aktualizacje z weryfikacją podpisu.
5. Brak losowania parametrów – ustawienia stałe per profil.

## Porównanie

| Kryterium | **Electron 44 (Chromium)** | Firefox / LibreWolf (fork) | Tauri (WebView2) | CEF / Qt WebEngine |
|---|---|---|---|---|
| Izolacja profili | osobny proces + `userData` + partycja sesji | profile Firefoksa (dojrzałe) | WebView2 – ograniczona kontrola nad profilami | dobra, ale dużo kodu natywnego |
| Kontrola sieci | `webRequest`, proxy per sesja, DoH | pełna, ale wymaga utrzymania forka | ograniczona | pełna (C++) |
| Koszt utrzymania | niski (aktualizacje Electron co ~8 tyg.) | **bardzo wysoki** (rebase forka co 4 tyg.) | niski | wysoki |
| Aktualizacje bezpieczeństwa silnika | wraz z Electronem | zależne od forka | zależne od WebView2 w systemie | ręczne |
| UI | HTML/CSS/TS | XUL/HTML w forku | HTML/CSS + Rust | Qt/C++ |
| Rozszerzenia WebExtensions | częściowe | pełne | brak | brak |
| Rozmiar | ~100 MB / aplikację | ~80 MB | ~10 MB | ~120 MB |

## Decyzja

**Electron 44 + TypeScript 5.9**, bundlowanie esbuild, pakowanie electron-builder, instalator Inno Setup.

* Najlepszy stosunek kontroli do kosztu utrzymania dla małego zespołu.
* Silnik Chromium dostaje poprawki bezpieczeństwa wraz z Electronem (trzeba regularnie podbijać wersję – patrz checklista wydania).
* Tor **nie jest** emulowany: profil Tor uruchamia oficjalny Tor Browser. Przeglądarka Chromium nie zapewni ochrony zbiorowej anonimowości Tor Browsera.

Odrzucone:

* **Fork Firefoksa/LibreWolfa** – najlepsza baza prywatności, ale utrzymanie forka przekracza możliwości projektu; opóźnione łatki bezpieczeństwa byłyby większym ryzykiem.
* **Tauri/WebView2** – brak kontroli nad izolacją profili i żądaniami na poziomie wymaganym przez specyfikację.

## Rozszerzenia

Electron nie obsługuje w pełni WebExtensions (brak m.in. pełnego `chrome.webRequest` z blokowaniem dla MV3, popupów akcji). Dlatego funkcje popularnych rozszerzeń są **wbudowane** i przejrzane:

| Zamiast | Wbudowana funkcja |
|---|---|
| uBlock Origin | blokowanie reklam/trackerów (`@ghostery/adblocker`, listy EasyList/EasyPrivacy/uBlock z oficjalnych URL) |
| ClearURLs | usuwanie parametrów śledzących |
| HTTPS Everywhere | tryb tylko HTTPS z ostrzeżeniem |
| Multi-Account Containers | osobne profile (osobne procesy) |
| Dark Reader | ciemne strony (opcjonalne, domyślnie wyłączone) |
| Bitwarden | integracja z oficjalną aplikacją desktop (hasła nie są przechowywane przez OctoBrowser) |
