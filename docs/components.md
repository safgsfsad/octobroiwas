# Weryfikacja komponentów open source

Kryteria: licencja zgodna z MPL-2.0, aktywność projektu, wymagane uprawnienia, wpływ na odcisk przeglądarki, źródło pobrania.

| Komponent | Wersja | Licencja | Aktywność | Uprawnienia / zakres | Wpływ na fingerprint | Decyzja |
|---|---|---|---|---|---|---|
| Electron | 44.4.5 | MIT | wydania co ~8 tyg., wsparcie 3 ostatnich linii | cała aplikacja | UA Chromium (czyszczony z tokenów Electron/aplikacji) | ✅ podstawa |
| @ghostery/adblocker | 2.18.x | MPL-2.0 | aktywny (Ghostery) | tylko dopasowanie żądań w procesie głównym | brak (działa poza stroną) | ✅ |
| hash-wasm (Argon2id) | 4.12 | MIT | aktywny | czysty WASM, bez sieci | brak | ✅ |
| tldts | 7.x | MIT | aktywny | parsowanie domen (Public Suffix List) | brak | ✅ |
| Node `crypto` (OpenSSL) | z Electron | Apache-2.0 / OpenSSL | — | AES-256-GCM, Ed25519, SHA-256 | brak | ✅ (bez własnej kryptografii) |
| Windows DPAPI (`safeStorage`) | system | — | — | ochrona klucza kontem Windows | brak | ✅ (tryb domyślny) |
| Windows Credential Manager (`advapi32` przez PowerShell) | system | — | — | opcjonalny magazyn sekretów, per użytkownik, limit 2560 B | brak | ✅ opcjonalnie, wyłączony domyślnie |
| EasyList / EasyPrivacy | pobierane | GPL-3.0 / CC BY-SA 3.0 | aktywne | dane, nie kod | brak | ✅ pobierane z oficjalnych URL |
| uBlock filters (uAssets) | pobierane | GPL-3.0 | aktywne | dane | brak | ✅ pobierane z oficjalnych URL |
| Inno Setup | 6.x | Inno Setup License | aktywny | budowanie instalatora | — | ✅ narzędzie build |
| electron-builder | 26.x | MIT | aktywny | pakowanie | — | ✅ narzędzie build |
| @resvg/resvg-js, png-to-ico | — | MPL-2.0 / MIT | aktywne | generowanie ikon | — | ✅ narzędzie build |
| Tor Browser | zewnętrzny | BSD-3 + MPL | Tor Project | osobny program | ujednolicony przez Tor | ✅ uruchamiany, nie wbudowany |
| Bitwarden desktop | zewnętrzny | GPL-3.0 | aktywny | osobny program | brak | ✅ opcjonalna integracja |

Odrzucone / niewbudowane:

* **Pełne WebExtensions** (np. instalacja z Chrome Web Store) – Electron ich nie wspiera w pełni; dodatkowe rozszerzenia zwiększają odcisk. Funkcje wbudowane.
* **Biblioteki „antidetect”, losujące Canvas/WebGL/UA** – sprzeczne z założeniami projektu (niespójne parametry, podszywanie się).
* **Zewnętrzne menedżery sekretów (np. keytar)** – porzucone projekty i zbędna zależność natywna; Credential Manager jest obsługiwany bezpośrednio przez `advapi32.dll` (P/Invoke w PowerShelu), bez paczek npm.
* **Wykrywanie rozszerzeń przez web-accessible resources** w OctoDetect – to sama w sobie technika fingerprintingu; świadomie niezaimplementowane.

Pełna lista pakietów faktycznie dołączonych do paczek: `licenses/THIRD-PARTY-NOTICES.md` (generowana przez `node tools/collect-licenses.mjs` z metafile esbuild).
