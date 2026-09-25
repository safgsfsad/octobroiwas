# OctoDetect.su – audyt prywatności

OctoDetect.su sprawdza, **co strona internetowa może odczytać** o przeglądarce i jak dobrze chroniony jest profil. Niczego nie ukrywa, nie fałszuje i niczego nie wysyła na zewnątrz.

## Cele testu

| Cel | Co jest mierzone |
|---|---|
| **Czysty Chromium** | nowa sesja w pamięci, bez ochrony – punkt odniesienia |
| **OctoBrowser – Standard** | tymczasowy profil z poziomem Standard (ten sam kod ochrony co karty OctoBrowser) |
| **OctoBrowser – Ścisły** | tymczasowy profil z poziomem Ścisły |
| **Inna przeglądarka** | lokalna strona testowa otwierana w domyślnej przeglądarce (ważna 10 min) |

Strona testowa działa lokalnie na `127.0.0.1` (losowy port, jednorazowy token, kontrola `Host`/`Origin`).

## Co jest sprawdzane

* **Tożsamość**: user agent, system, języki, strefa czasowa, spójność (UA vs `navigator.platform`, client hints, języki, ekran);
* **Sprzęt**: ekran, wątki CPU, pamięć, dotyk, interfejsy urządzeń (bateria, Bluetooth, USB, HID, serial, WebGPU);
* **Powierzchnie odcisku**: czcionki (pomiar tekstu), canvas (czy odczyt jest możliwy), WebGL (dostawca/renderer), dźwięk;
* **Sieć**: publiczny IP (tylko za zgodą), WebRTC (kandydaci lokalni), DNS (systemowy/DoH), proxy/VPN/Tor, HTTPS;
* **Pamięć i ciasteczka**, **uprawnienia** (lokalizacja, kamera, mikrofon, powiadomienia), urządzenia multimedialne;
* **Izolacja**: piaskownica renderera, osobny profil, Windows Sandbox.

## Ocena

Każdy element ma status (**widoczne / ograniczone / zablokowane / nie można określić**), siłę identyfikacji (niska/średnia/wysoka), wyjaśnienie „dlaczego” i wskazówkę „jak ograniczyć”.

Punkty ryzyka sumują się: **≥ 8 – wysokie**, **≥ 4 – średnie**, poniżej – **niskie**; bez danych ze strony – **nie można określić**. Szacunek unikalności: prawdopodobnie typowa / możliwie unikalna / prawdopodobnie unikalna.

Komunikaty są celowo ostrożne: „Nie wykryto typowych problemów” nie oznacza gwarancji prywatności.

## Raporty

* zapisywane lokalnie jako zaszyfrowane pliki `.odr`;
* eksport do **JSON** lub statycznego **HTML** (bez skryptów, bez zasobów zewnętrznych, wszystkie wartości ze strony escapowane);
* nigdy nie są wysyłane.

## Świadome ograniczenia

* **WebRTC** – zbierani są tylko kandydaci lokalni (bez serwera STUN), więc test nie ujawnia adresu publicznego przez STUN;
* **Wykrywanie rozszerzeń** – niezaimplementowane celowo (sondowanie zasobów rozszerzeń jest techniką fingerprintingu);
* **Inna przeglądarka** – audyt mierzy jej odcisk (UA, ekran, canvas/WebGL/audio, czcionki, WebRTC, ciasteczka własnej domeny), ale nie może ocenić izolacji profili, polityki ciasteczek osób trzecich ani piaskownicy tej przeglądarki (wynik „nie można określić”);
* wynik jest migawką z chwili testu, nie certyfikatem.
