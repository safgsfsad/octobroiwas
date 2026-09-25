# OctoBrowser.su – instrukcja użytkownika

## 1. Pierwsze uruchomienie

Kreator pojawia się tylko raz: **język** (English/Polski), **folder danych** (domyślnie `Dokumenty\OctoSuite`; unikaj folderów synchronizowanych z chmurą dla profili szyfrowanych) oraz **ochrona klucza**:

* **Konto Windows (zalecane)** – klucz chroni DPAPI; brak dodatkowego hasła;
* **Hasło główne** – wymagane przy starcie i po auto-blokadzie; nie da się go odzyskać.

Opcje prywatności: sprawdzanie publicznego IP (domyślnie wyłączone), automatyczne aktualizacje (domyślnie włączone).

## 2. Profile

Okno **Profile i ustawienia** (menedżer) pokazuje wszystkie profile. Domyślnie tworzone są: Osobisty, Praca, Prywatny, Testowy, Tymczasowy, Tor; możesz dodać **Własny**.

| Typ | Poziom | Domyślnie |
|---|---|---|
| Osobisty | Standard | historia i przywracanie sesji włączone, kamera/mikrofon na żądanie |
| Praca | Standard | j.w., osobne logowania |
| Prywatny | Ścisły | tryb ograniczony, schowek tylko do zapisu, bez historii |
| Testowy | Standard | tryb ograniczony, łatwy reset |
| Tymczasowy | Ścisły | dane usuwane po zamknięciu, schowek tylko do zapisu |
| Tor | Tor | otwiera oficjalny Tor Browser (instalowany osobno z torproject.org), bez dodatków |
| Własny | Standard | pełna konfiguracja |

Akcje: **utwórz, edytuj, duplikuj** (opcjonalnie z danymi), **importuj, eksportuj** (zawsze zaszyfrowane hasłem eksportu), **szyfruj/wyłącz szyfrowanie**, **zablokuj wszystkie**, **resetuj** (usuwa ciasteczka, dane stron, historię i sesję – zostają ustawienia i zakładki), **usuń**. Każdy profil ma własne dane, ustawienia prywatności, sieć (proxy/DNS), piaskownicę i wbudowane dodatki.

Profile działają jako osobne procesy – można mieć otwarte kilka profili jednocześnie. Operacje na plikach profilu (reset, eksport, szyfrowanie) wymagają jego zamknięcia.

### Pusty ekran startowy

Gdy nie ma żadnego profilu (np. po usunięciu wszystkich), zamiast pustej listy na środku pojawia się ekran startowy z dwoma przyciskami: **Przeglądanie prywatne** i **Nowy profil**. Ten sam przycisk **Przeglądanie prywatne** znajduje się też na górze widoku Profile.

### Przeglądanie prywatne

Jednym kliknięciem tworzy tymczasowy profil w poziomie **Ścisły** i od razu go otwiera. Historia, ciasteczka, pamięć podręczna i dane witryn są usuwane po zamknięciu okna, a sam profil znika z listy. Nazwa profilu zawiera datę i godzinę startu, np. `Prywatne 2026-09-25 14:03`.

Przeglądanie prywatne **nie** zapewnia anonimowości w internecie: adres IP pozostaje widoczny, a witryny i dostawca nadal widzą odwiedzone strony. Chroni ono dane przed innymi osobami korzystającymi z tego komputera.

### Tworzenie profilu

Okno **Nowy profil** ma zakładki (**Ogólne**, **Prywatność**, **Sieć**, **Piaskownica**) po lewej i **podsumowanie** po prawej. Podsumowanie pokazuje na żywo, co profil faktycznie będzie robił: nazwę, typ, poziom ochrony, tryb sieci, zasady WebRTC, odczyt canvas, WebGL, informacje o sprzęcie, izolację, historię, czyszczenie danych przy zamknięciu i usuwanie profilu. Nad zakładkami znajduje się informacja, że wszystkie parametry są stałe i opisowe – ta sama konfiguracja przy każdym uruchomieniu, bez losowania i bez podszywania się pod inny sprzęt.

W zakładce **Sieć** można od razu ustawić proxy (reguły, lista wyjątków, nazwę użytkownika i hasło). Hasło trafia tylko do zaszyfrowanego magazynu sekretów – nigdy do zwykłego pliku JSON ani do logów.

### Motyw okna (ciemny szary / biały)

W zakładce **Ogólne** (tworzenie profilu) i w oknie edycji profilu znajduje się wybór **Motyw okna**: *ciemny szary* (domyślnie) albo *biały*. Wybór jest zapisany w profilu i obowiązuje wszystkie jego okna: pasek kart, pasek narzędzi, panele i wbudowana strona nowej karty. Motyw **nie** zmienia treści ani wyglądu odwiedzanych stron – witryny dostają swoje własne kolory. W motywie białym karty są zaokrąglone, a pasek adresu jest jasny i mocno zaokrąglony, co przypomina nowoczesne minimalistyczne przeglądarki.

Cały interfejs jest czarno-biały: nie ma kolorów „na ozdobę”. Stan (np. ochrona aktywna, wymagana uwaga) pokazuje kształt znacznika – pełne kółko, obwódka, pusty prostokąt – oraz słowo w etykiecie, więc nie zależy od rozróżniania barw.

## 3. Poziomy ochrony

Wartości są **stałe dla profilu** – nic nie jest losowane przy uruchomieniu.

| Ustawienie | Standard | Ścisły |
|---|---|---|
| Reklamy / elementy śledzące | blokowane | blokowane |
| Tylko HTTPS | tak (ostrzeżenie przed HTTP) | tak |
| Ciasteczka stron trzecich | blokowane | blokowane |
| Parametry śledzące w linkach | usuwane | usuwane |
| Śledzenie przez przekierowania | – | ograniczane, potwierdzanie przekierowań między witrynami |
| WebRTC | tylko publiczny interfejs | tylko przez proxy |
| Odczyt canvas | dozwolony | blokowany |
| WebGL | dozwolony | wyłączony |
| Szczegóły sprzętu | rzeczywiste | typowe stałe wartości |
| Autoodtwarzanie z dźwiękiem | blokowane | blokowane |
| Wyskakujące okna | blokowane | blokowane |
| Odsyłacz do innych witryn | pełny | tylko domena |
| Global Privacy Control | wysyłany | wysyłany |
| Lokalizacja / powiadomienia | pytaj | blokuj |
| Czyszczenie przy zamknięciu | – | tak |

**Tor** – strony otwierają się w oficjalnym Tor Browser. OctoBrowser nie udaje Tora.

Każde ustawienie można nadpisać w edytorze profilu (zakładka Prywatność). Panel prywatności pokazuje ostrzeżenia o niespójnych kombinacjach (np. proxy + WebRTC poza proxy).

## 4. Okno przeglądarki

* pasek kart (poziomy lub pionowy), wyszukiwanie kart (Ctrl+E), przypinanie, grupy (etykieta), usypianie nieaktywnych kart;
* **widok podzielony** (dwie karty obok siebie), **obraz w obrazie**;
* pasek adresu z ikoną stanu połączenia, liczbą zablokowanych elementów, zakładkami;
* **pasek zakładek** – włącza się w menu (trzech kresek → *Pasek zakładek*) albo w Ustawieniach → Karty; pokazuje zakładki jako zwykłe przyciski;
* plakietka profilu (kolor, typ, poziom ochrony, szyfrowanie, izolacja);
* cienkie paski przewijania (10 px), które nie nachodzą na tekst – domyślny pasek Windows jest szerszy i rysowany jest nad treścią.

### Zamykanie okna

Zamykanie okna profilu nie ucina procesu od razu. Najpierw pojawia się małe, monochromatyczne okno **„Zamykanie…”** z obracającym się znacznikiem i informacją, co właśnie się dzieje:

* profil z włączonym przywracaniem sesji – „Zapisywanie sesji i *n* kart, opróżnianie ciasteczek i danych profilu”;
* profil tymczasowy / bez przywracania – „Zamykanie *n* kart. Ten profil nie zapisuje sesji – jego dane są usuwane”.

Pod spodem są dwie możliwości: **Wymuś zamknięcie** z małym, czerwonym dopiskiem *(możliwa utrata danych)* oraz **Kontynuuj przeglądanie**, które zamyka tylko to okienko. Wymuszenie zamknięcia jest zapisywane w logu (`window.force-closed`). Zachowanie wyłącza się w Ustawieniach → Karty (**Pytaj przed zamknięciem okna**) – wtedy okno zamyka się od razu.

### Strona nowej karty

Wbudowana strona `octo://newtab` jest monochromatyczna: jedno pole wyszukiwania, plakietka profilu i kafelki z aktualnym stanem (ochrona, publiczny IP, DNS, WebRTC, trasa, ruch, zablokowane elementy, izolacja, szyfrowanie, aktualizacje) oraz przycisk „Otwórz w Piaskownicy Windows”. Kafelki nie używają kolorów – znacznik ma inny kształt, a wartość jest wypisana słowiem. Na dole zawsze znajduje się zastrzeżenie, że nie gwarantujemy pełnej anonimowości.

### Panele

| Panel | Zawartość |
|---|---|
| **Ruch i sieć** | tryb połączenia, proxy, VPN (heurystyka), Tor, DNS/DoH, publiczny IP (za zgodą), WebRTC, certyfikat strony, liczba żądań, zablokowane reklamy/trackery/skrypty/ciasteczka, usunięte parametry, przełączenia na HTTPS, domeny kontaktowane przez kartę (tylko w pamięci), dane wysłane/odebrane |
| **Dźwięk** | karty odtwarzające dźwięk, głośność karty, wyciszanie karty/profilu, urządzenie wyjściowe (korektora nie ma) |
| **Prywatność** | poziom, stan wszystkich zabezpieczeń, ostrzeżenia spójności, czyszczenie danych witryny, „Sprawdź w OctoDetect.su”, „Otwórz w Piaskownicy Windows” |
| **Wbudowane dodatki** | metadane (wersja, licencja, źródło, uprawnienia, integralność, status) |
| **Pobrane / Zakładki / Historia / Aktualizacje / Skróty** | jak w nazwie |

### Ustawienia, które warto znać

W Ustawieniach → Karty i Sieć znajdują się przełączniki i listy, z których każdy pokazuje swój stan nie tylko kształtem:

* **Przełączniki** mają biały wskaźnik na ciemnym torze (wyłączone) albo ciemny wskaźnik na białym torze (włączone) – oba stany są widoczne – obok etykiety jest dopisany tekst *Włączone / Wyłączone*;
* **Pasek zakładek**, **Pytaj przed zamknięciem okna**, **Otwieraj linki z zakładek i historii w tle**, usypianie kart, karty pionowe;
* **Wyszukiwarka w pasku adresu**: DuckDuckGo (domyślnie), Startpage, Brave Search, Mojeek – żadna z nich nie wysyła podpowiedzi sieciowych;
* **Auto-blokada** (0–60 minut), tryb logów, kanał aktualizacji.

## 5. Piaskownica i tryb ograniczony

Przed uruchomieniem profilu z izolacją pojawia się podsumowanie: tryb, kamera, mikrofon, urządzenia USB, schowek, udostępnione foldery, trasa sieci, VPN, brak uprawnień administratora.

* **Windows Sandbox** – oznaczona jako **wersja testowa**. Wymaga Windows Pro/Enterprise/Education i włączonej funkcji „Piaskownica systemu Windows”;
* **VPN a Piaskarnica**: Piaskarnica systemu Windows to jednorazowa maszyna wirtualna z własnym przełącznikiem wirtualnym. Filtry niektórych klientów VPN – zwłaszcza funkcja „kill switch” – blokują w niej sieć, dlatego przy wykrytym VPN przed uruchomieniem pojawia się ostrzeżenie. Naprawa po stronie użytkownika: dodać Piaskownicę do wyjątków VPN (split tunnelling) albo uruchomić profil w trybie ograniczonym. Aplikacja nie wyłącza VPN-a sama – byłaby to zmiana konfiguracji systemu bez wiedzy użytkownika;
* gdy niedostępna, używany jest **tryb ograniczony** (blokada kamery/mikrofonu/USB, schowek tylko do zapisu, pobieranie tylko do folderu profilu).

## 6. Sieć per profil

Tryb: systemowy / bezpośredni / proxy (`http`, `https`, `socks4`, `socks5`), lista wyjątków, dane logowania proxy (przechowywane zaszyfrowane). DNS: systemowy lub DNS przez HTTPS (Quad9, Cloudflare, Mullvad, własny adres `https://`).

## 7. Skróty klawiszowe

| Skrót | Akcja |
|---|---|
| Ctrl+T / Ctrl+W (Ctrl+F4) | nowa / zamknij kartę |
| Ctrl+Shift+T | przywróć zamkniętą kartę |
| Ctrl+Tab / Ctrl+Shift+Tab | następna / poprzednia karta |
| Ctrl+L | pasek adresu |
| Ctrl+R, F5 / Ctrl+Shift+R, Shift+F5 | odśwież / odśwież bez cache |
| Ctrl+F | znajdź na stronie |
| Ctrl+E | szukaj kart |
| Ctrl+D | dodaj zakładkę |
| Ctrl+J | pobrane |
| Ctrl+Shift+O | zakładki |
| Ctrl+Shift+N | panel ruchu |
| Ctrl+Shift+P | panel prywatności |
| Ctrl+Shift+A | panel dźwięku |
| Ctrl+M / Ctrl+Shift+M | wycisz kartę / profil |
| Ctrl+Shift+↑ / ↓ | głośność karty |
| Ctrl+Shift+S | widok podzielony |
| Alt+P | obraz w obrazie |
| Ctrl+Shift+U | przełącz profil |
| Ctrl+ + / Ctrl+ − | powiększ / pomniejsz |
| Ctrl+P | drukuj |
| F11 | pełny ekran |
| F12, Ctrl+Shift+I | narzędzia deweloperskie |

## 8. Bezpieczeństwo, kopie, logi

* **Bezpieczeństwo**:
  * aktualna ochrona klucza – „Konto Windows (DPAPI) – bez hasła” albo „Hasło główne”;
  * **Ustaw / zmień / usuń hasło główne** (minimum 10 znaków; zmiana hasła nie zmienia klucza, więc zaszyfrowane dane pozostają czytelne);
  * **Gdzie przechowywać sekrety** – zaszyfrowany plik w folderze danych (domyślnie, jest w kopiach) albo Menedżer poświadczeń Windows (ten użytkownik, bez kopii);
  * auto-blokada: po bezczynności zamykane są zaszyfrowane profile, a przy haśle głównym blokowany jest także lokalny klucz (aplikacja pyta o hasło ponownie);
  * listy filtrów i data ich ostatniej aktualizacji;
  * szczegóły: [encryption.md](encryption.md);
* **Folder danych**: w Ustawieniach → Ogólne widoczna jest ścieżka. Przycisk **Zmień…** kopiuje profile, ustawienia, logi i kopie do nowego folderu, zapisuje go w pliku `bootstrap.json` i uruchamia aplikację ponownie. Kopiowanie jest wykonywane przed zapisem nowej ścieżki, więc przerwana operacja nie pozostawia aplikacji bez danych; stary folder zostaje bez zmian i można go usunąć ręcznie. Folder wewnątrz katalogu instalacji i w katalogach systemowych jest odrzucany;
* **Kopie zapasowe**: tworzone automatycznie przed każdą zmianą konfiguracji; przywracanie jednym kliknięciem;
* **Logi**: tryb standardowy/diagnostyczny, „Otwórz folder logów”, **„Usuń logi”**;
* **O programie**: wersja, lista połączeń sieciowych, telemetria wyłączona, licencje.

## 9. Ograniczenia

Patrz [feature-matrix.md](feature-matrix.md) – m.in. brak korektora dźwięku, brak obsługi zewnętrznych rozszerzeń WebExtensions (funkcje wbudowane), okna wyskakujące otwierane jako karty bez `window.opener`. Pełna, uczciwa lista: [known-limitations.md](known-limitations.md).
