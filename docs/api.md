# Local REST API

OctoBrowser exposes everything the launcher can do - profiles, proxies,
fingerprints, start/stop - over a small local HTTP API, so profiles can be
driven from scripts and automation tools (Puppeteer, Playwright, Selenium).

Enable it in **Launcher → API** (`Włącz lokalne API`). Default port: `35555`.

## Security model

* Listens on **127.0.0.1 only** - never on the network.
* Every request (except `GET /v1/health`) needs `Authorization: Bearer <token>`.
  The token is generated on first use, stored in the encrypted secret store and
  can be rotated in the API page (`Nowy token`); the old one stops working
  immediately.
* Requests carrying an `Origin` header, or a `Host` other than
  `127.0.0.1:<port>` / `localhost:<port>`, are rejected with **403**. This
  blocks websites (including DNS-rebinding tricks) from calling the API even
  though it runs locally.
* Request bodies are limited to 1 MB and must be JSON.
* Proxy passwords are write-only: they are accepted in requests but never
  returned (`hasProxyCredentials: true` instead).

Errors are returned as `{ "error": "message" }` with an HTTP status
(`400` bad input, `401` missing/wrong token, `403` origin/host, `404` unknown
profile/proxy/route, `405` wrong method, `413` body too large, `500` internal).

## Endpoints

Base URL: `http://127.0.0.1:35555/v1`

### Health

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | No token. `{ ok: true, version }` |

### Profiles

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| GET | `/profiles` | query: `q`, `folder`, `status`, `tag`, `running=true\|false` | list of profiles (+ `running`, `hasProxyCredentials`, `fingerprintWarnings`, …) |
| POST | `/profiles` | `{ name?, kind?, os?, proxy?, ...profileFields }` | created profile |
| GET | `/profiles/:id` | | profile |
| PATCH | `/profiles/:id` | any profile fields, `os`, `proxy` | updated profile (running profiles get the change live) |
| DELETE | `/profiles/:id` | | `{ ok: true }` |
| POST | `/profiles/:id/start` | `{ debug?: true }` | `{ status: "started", debugPort?, wsEndpoint? }` |
| POST | `/profiles/:id/stop` | `{ force?: true }` | `{ ok }` - closes the profile (force kills it) |
| POST | `/profiles/:id/fingerprint` | `{ os? }` | profile with a new realistic fingerprint |
| PUT | `/profiles/:id/proxy` | ProxyInput (below) | profile |
| POST | `/profiles/:id/proxy/check` | | ProxyCheckResult |
| POST | `/profiles/:id/cookies` | `{cookies}` - JSON array (EditThisCookie / Puppeteer / Playwright shape) or the text of a JSON / Netscape cookies.txt export | `{imported, applied: "now" \| "next-start"}` |
| POST | `/profiles/bulk` | `{ action, ids: [...], arg? }` | action = `start`, `stop`, `remove`, `folder`, `status`, `tags` |

* `kind`: `antidetect` (default), `personal`, `work`, `private`, `testing`,
  `temporary`, `tor`, `custom`. `antidetect` uses protection level **normal**:
  nothing is blocked, so sites behave like in plain Chrome. Only the fingerprint
  and network identity are changed.
* `os`: `windows11`, `windows10`, `macos`, `linux`. It generates a matching
  fingerprint (UA, UA-CH, GPU, screen, CPU, memory).
* `fingerprint`: you can also pass a full or partial `FingerprintConfig`
  object. It is sanitised server-side. See [antidetect.md](antidetect.md).

`POST /profiles` and `PATCH /profiles/:id` also accept `cookies` (same format). Cookies of a closed profile are kept encrypted and written into its cookie jar at the next start; a running profile gets them immediately.

### ProxyInput

```jsonc
{ "mode": "none" }                                            // no proxy (system/direct)
{ "mode": "new", "text": "1.2.3.4:8080:user:pass", "type": "http",
  "changeIpUrl": "", "name": "", "save": false }             // any supported format, auto-detected
{ "mode": "saved", "savedId": "<id from /proxies>" }
{ "mode": "keep" }                                            // leave unchanged
```

### Proxies

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/proxies` | | saved proxies (no passwords) |
| POST | `/proxies` | `{ text, type?, name? }` - one proxy per line | `{ added: [...], errors: [{ line, error }] }` |
| PATCH | `/proxies/:id` | `{ name?, changeIpUrl? }` | saved proxy |
| DELETE | `/proxies/:id` | | `{ ok: true }` |
| POST | `/proxies/:id/check` | | ProxyCheckResult |
| POST | `/proxies/parse` | `{ text, type? }` | `{ ok, proxy?, format?, error? }` - no network access; the password is masked as `***` |
| POST | `/proxies/check` | `{ text, type? }` | ProxyCheckResult `{ ok, ip, country, countryCode, city, timezone, latencyMs, error? }` |

### Fingerprints

| Method | Path | Result |
| --- | --- | --- |
| POST | `/fingerprints` `{ os? }` | a fresh realistic `FingerprintConfig` (not saved) |
| GET | `/fingerprints/meta?os=windows11` | `{ gpus, userAgent, engine }` - presets for UIs |

## Examples

```bash
TOKEN=...   # from Launcher → API → Kopiuj
API=http://127.0.0.1:35555/v1

# create a Windows 11 profile with a SOCKS5 proxy
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Shop 1","os":"windows11","proxy":{"mode":"new","text":"socks5://user:pass@1.2.3.4:1080"}}' \
  $API/profiles

# start it for automation and stop it again
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"debug":true}' $API/profiles/<ID>/start
curl -X POST -H "Authorization: Bearer $TOKEN" $API/profiles/<ID>/stop
```

On Windows `cmd.exe`, use double quotes for `-d` and escape the inner ones, or
use PowerShell's `Invoke-RestMethod`:

```powershell
$h = @{ Authorization = "Bearer $env:OCTO_TOKEN" }
Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' `
  -Body '{"name":"Shop 1","os":"windows11"}' http://127.0.0.1:35555/v1/profiles
```

### Puppeteer

```js
const r = await fetch(`http://127.0.0.1:35555/v1/profiles/${id}/start`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ debug: true }),
});
const { wsEndpoint } = await r.json();
const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
```

`debug: true` opens a Chrome DevTools Protocol port on 127.0.0.1 for that
profile run only. Playwright can connect with `chromium.connectOverCDP(wsEndpoint)`.
The debugging port is powerful (full control of the profile), so only
request it when you need automation.
