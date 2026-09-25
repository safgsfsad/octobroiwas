# Model zagrożeń OctoSuite

Szczery opis: co chronimy, przed kim, przed czym **nie** chronimy i dlaczego
projekt celowo nie zawiera funkcji antydetect/antyfraud.

## 1. Co chronimy (zasoby)

| Zasób | Gdzie żyje | Ochrona |
|---|---|---|
| Ciasteczka, localStorage, IndexedDB, sesja profilu | `profiles\<id>\engine` | osobny katalog i osobny proces na profil; opcjonalny `engine.vault` (AES-256-GCM) |
| Zakładki, historia, sesja zapisanych kart | `profiles\<id>\*.enc` | AES-256-GCM kluczem danych |
| Ustawienia i lista profili | `config\*.json` | koperta SHA-256 + kopia przed każdą zmianą |
| Sekrety (hasła proxy) | `config\secrets.bin` lub Menedżer poświadczeń Windows | AES-256-GCM / skarbiec systemowy |
| Klucz danych | `config\keyring.bin` (tylko postać opakowana) | DPAPI albo hasło główne (Argon2id) |
| Aktualizacje | plik instalatora + manifest | SHA-256, podpis Ed25519, Authenticode (gdy wydanie podpisane) |

## 2. Przed kim chronimy

| Podmiot | Czego nie potrafi zrobić |
|---|---|
| Inny użytkownik tego samego komputera (bez uprawnień administratora) | odczytać zaszyfrowanych profili i sekretów; powiązać profili przez wspólne ciasteczka |
| Ktoś z kopią dysku / folderu danych | odczytać dane w spoczynku (klucz jest opakowany DPAPI lub hasłem) |
| Śledzące strony i sieci reklamowe | powiązać profilu przez wspólne źródła; zobaczyć, co blokują presety ochrony |
| Przypadkowe wycieki (DNS, WebRTC, referery) | wyjść poza skonfigurowaną trasę – presety je ograniczają, OctoDetect je mierzy |

## 3. Przed czym **nie** chronimy

* **Złośliwe oprogramowanie na odblokowanym komputerze** – może odczytać klucz z
  pamięci procesu, nasłuchiwać klawiatury, zrzucić ekran. Żadne lokalne
  szyfrowanie przed tym nie chroni. Komunikat jest w UI.
* **Administrator komputera / uprawnienia jądra** – kontroluje wszystko, w tym
  DPAPI i pamięć procesów.
* **Anonimowości w sieci** – standardowe profile nie ukrywają adresu IP. Służą
  do tego VPN/proxy lub profil Tor (oficjalny Tor Browser).
* **Niewykrywalności przeglądarki** – ograniczamy powierzchnie odcisku
  (canvas, WebGL, WebRTC, szczegóły sprzętu), ale przeglądarka nadal jest
  rozpoznawalna. Nie obiecujemy „100% prywatności”.
* **Serwisów, którym sam się logujesz** – widzą to, co im przekażesz.
* **Fizycznego usunięcia danych na SSD** – patrz [known-limitations.md](known-limitations.md).

## 4. Dlaczego nie ma funkcji antydetect / antyfraud

Projekt świadomie **nie implementuje** i nigdy nie będzie implementował:

* losowania parametrów sprzętu (UA, rozdzielczości, strefy, WebGL, canvas,
  audio) – niespójny odcisk jest łatwiejszy do wykrycia niż stała, sensowna
  wartość;
* podszywania się pod inne urządzenia lub systemy;
* omijania CAPTCHA, blokad kont i systemów antyfraudowych;
* ukrywania automatyzacji, masowego tworzenia kont, fałszowania tożsamości.

Zamiast tego: **stałe, przewidywalne ustawienia per profil** (bez losowania),
presety ochrony, izolacja profili i OctoDetect do pomiaru tego, co faktycznie
ujawnia przeglądarka. To narzędzie do ochrony prywatności i testowania własnych
stron, nie do obchodzenia zabezpieczeń cudzych serwisów.

## 5. Zakładone właściwości

* system Windows 10/11 (x64), użytkownik bez uprawnień administratora;
* zainstalowany program nie jest modyfikowany (weryfikacja fuse’ów Electrona w
  CI, weryfikacja SHA-256 i podpisu przy aktualizacji);
* dane zapisane w folderze wybranym przez użytkownika, nie w folderze
  instalacyjnym;
* dostęp do sieci tylko do opisanych adresów
  ([privacy-and-network.md](privacy-and-network.md)).

## 6. Ograniczenia zaufania (trust boundaries)

```
┌─ zaufane: proces główny (menedżer), okna UI z dist/, kanał IPC
├─ półzaufane: proces profilu (osobny Electron, własny userData)
└─ niezaufane: strony w kartach (piaskownica Chromium, bez Node)
```

Reguły: renderery nie mają dostępu do Node, IPC przyjmuje wyłącznie żądania z
zaufanych `webContents` wewnątrz `dist\`, strony nie mogą wywołać akcji
menedżera, a klucz danych nie trafia ani do argumentów procesu, ani do zmiennych
środowiskowych (tylko przez prywatny potok).
