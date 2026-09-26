# Znane ograniczenia

Lista uczciwa: co w OctoSuite nie działa, działa częściowo albo zależy od
systemu. Nic z poniższych nie jest ukrywane w UI – tam, gdzie to możliwe,
aplikacja mówi o tym wprost.

## Platforma i środowisko

| Ograniczenie | Skutek | Alternatywa / plan |
|---|---|---|
| Tylko Windows 10/11 x64 | na Linux/macOS nie ma DPAPI ani Menedżera poświadczeń; aplikacja startuje, ale ochrona klucza jest ograniczona | ostrzeżenie przy starcie (`firstRun.err.noDpapi`) |
| **Windows Sandbox** wymaga Pro/Enterprise/Education | na Home tryb piaskownicy jest niedostępny | automatyczny powrót do trybu ograniczonego + jasny komunikat |
| **AppContainer** dla całej aplikacji nie jest używany | pełne ograniczenie uprawnień plików/rejestru na poziomie procesu głównego nie jest włączone | piaskownica rendererów Chromium + tryb ograniczony (kamera/mikrofon/USB/schowek) |
| Aplikacje nie zostały uruchomione w prawdziwym Electronie w środowisku budowania kodu | testy jednostkowe i E2E w CI na `windows-latest`, ale test ręczny na docelowym systemie jest wymagany przed wydaniem | checklista w [release-checklist.md](release-checklist.md) |
| Instalator Inno Setup nieprzetestowany automatycznie end-to-end | `tools/ci/installer-e2e.ps1` uruchamia się na Windowsie z ISCC | uruchom przed wydaniem |

## Prywatność i odcisk przeglądarki

| Ograniczenie | Skutek |
|---|---|
| Brak pełnych WebExtensions | funkcje typu blokada reklam, Dark Reader, ClearURLs, kontenery, mikser audio są **wbudowane**; nie można doinstalować dowolnego rozszerzenia. To zmniejsza elastyczność, ale też nie zwiększa odcisku |
| Brak korektora (EQ) i limitera | mikser dźwięku daje głośność/wyciszenie kart i profilu, wybór urządzenia, blokadę autoodtwarzania; **nie** ma equalizera – Electron nie udostępnia grafu audio dla treści stron bez złożonego przechwytywania dźwięku karty |
| WebRTC – kandydaci lokalni | test OctoDetect pokazuje kandydatów lokalnych (host); bez zewnętrznego serwera STUN nie da się w 100% potwierdzić braku wycieku publicznego IP – używamy wtedy sformułowania „nie można potwierdzić” |
| Wykrywanie rozszerzeń | **celowo niezaimplementowane** – to technika fingerprintingu |
| VPN wykrywany heurystycznie | status VPN w panelu ruchu jest wnioskowany z adapterów i tras, nie z informacji od dostawcy |
| Profil Tor nie ukrywa więcej niż Tor Browser | używamy **oficjalnego** Tor Browser; bez dodatkowych rozszerzeń, bez modyfikacji parametrów |

## Kryptografia i dane

| Ograniczenie | Skutek |
|---|---|
| Ciągi w JavaScriptu nie da się wyzerować | bufory kluczy są zerowane (`wipe`), ale hasło wpisane w polu pozostaje w pamięci renderera do zamknięcia okna |
| Bezpieczne usuwanie na SSD | nadpisywanie pliku nie gwarantuje fizycznego usunięcia (wear leveling) – stąd zalecenie szyfrowania profili |
| Menedżer poświadczeń: limit 2560 B na poświadczenie | sekrety większe (np. cała konfiguracja) muszą zostać w `secrets.bin` |
| Poświadczenia nie są w kopiach | przełączenie na Menedżer poświadczeń oznacza, że kopia folderu danych **nie** zawiera sekretów |
| Utracone hasło główne = utracone lokalne dane | nie ma mechanizmu odzyskiwania; profile z 12-wyrazową frazą da się odzyskać |
| Eksport profilu bez danych nie zawiera ciasteczek | to celowe (mniej ryzyka), ale przenosi tylko ustawienia |

## Sieć i aktualizacje

| Ograniczenie | Skutek |
|---|---|
| Aktualizacje tylko z oficjalnego repozytorium (GitHub Releases) | brak mirrorów; brak dostępu do GitHuba = brak aktualizacji (aplikacja działa dalej) |
| Updater wyłączony do wygenerowania klucza | `npm run keygen` musi być wykonany raz przed pierwszym wydaniem; do tego czasu sprawdzanie aktualizacji jest wyłączone (fail-closed) |
| Lista filtrów offline | przed pierwszą aktualizją działa mała lista bazowa z `resources\filters\` |
| Panel ruchu nie zapisuje treści stron | metryki są w pamięci; tryb diagnostyczny może zapisać ograniczone metadane na czas określony |

## UI i język

| Ogranicczenie | Skutek |
|---|---|
| Tylko polski i angielski | inne języki wymagają nowego słownika w `packages/core/src/i18n` |
| Interfejs monochromatyczny | brak kolorów znaczeniowych; stan przekazują ikony, obramowania i tekst |
