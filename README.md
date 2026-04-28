# ceki-browser

> Real browsers of real people. 5-line API.

TypeScript/JavaScript SDK for [browser.ceki.me](https://browser.ceki.me) — rent real browsers from real people for AI agent automation.

## Installation

```bash
npm install ceki-browser
```

## Quickstart

```ts
import { Browser } from 'ceki-browser';

const br = new Browser({ token: 'YOUR_TOKEN' });
await br.connect();

const s = await br.openSession({ mode: 'incognito', domainHints: ['example.com'] });
await s.navigate('https://example.com');
const title = await s.query('h1');
console.log(title.elements[0]?.textContent);

await s.close();
await br.close();
```

## Configuration

| Parameter | Default | Description |
|---|---|---|
| `token` | — | Sanctum API token from your [dashboard](https://browser.ceki.me/dashboard) |
| `relayUrl` | `wss://browser.ceki.me/ws/agent` | WebSocket relay endpoint |

### Session options

| Parameter | Default | Description |
|---|---|---|
| `mode` | `"incognito"` | `"incognito"` (clean browser) or `"persona"` (real user cookies) |
| `domainHints` | `[]` | Preferred domains for provider matching |
| `geo` | `""` | Preferred provider geo (e.g. `"US"`, `"DE"`) |
| `language` | `""` | Preferred browser language |
| `maxPricePerMin` | `1.0` | Maximum price you're willing to pay per minute (USD) |
| `estimatedDurationMin` | `30` | Estimated session duration for provider matching |

## Methods

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `navigate(url)` | `url`, `timeoutMs=120000` | `NavigateResult` | Navigate to URL |
| `query(selector)` | `selector`, `attributes?` | `QueryResult` | Query first matching element |
| `queryAll(selector)` | `selector`, `attributes?`, `limit=20` | `QueryResult` | Query all matching elements |
| `getHtml(selector)` | `selector="html"`, `outer=true` | `HtmlResult` | Get element HTML |
| `click(selector)` | `selector?` or `x`/`y` coordinates | `void` | Click element or coordinates |
| `type(selector, text)` | `selector`, `text`, `delayMs=0` | `void` | Type text into input |
| `scroll(selector)` | `selector?` or `direction`/`amount` | `void` | Scroll to element or direction |
| `screenshot()` | `format="png"`, `quality=80` | `ScreenshotResult` | Capture visible tab |
| `back()` / `forward()` / `reload()` | — | `NavigateResult` | Navigation controls |
| `injectCredentials(secretId, target)` | `secretId`, `target` selectors | `object` | Fill credentials from vault |
| `requestHumanAction(type, message)` | `actionType`, `message`, `timeoutSec=120` | `HumanActionResult` | Ask browser owner for help |

### Credential Vault

`injectCredentials` fills login forms using encrypted secrets stored on the provider side.
The SDK sends a `secretId` — the provider extension decrypts and injects credentials locally (RSA-OAEP + AES-256-GCM).

Create secrets via dashboard: **API Keys & Secrets** section.

## Errors

| Error | When |
|---|---|
| `AuthError` | Invalid or expired token |
| `ProviderDisconnected` | Provider went offline during session |
| `NavigationTimeout` | `navigate()` exceeded timeout |
| `CommandTimeout` | Any command exceeded timeout |
| `RateLimited` | Too many sessions/commands per hour |
| `ProviderNotVerified` | `injectCredentials` requires a verified provider |
| `HumanActionDeclined` | Browser owner declined the action |
| `HumanActionTimeout` | Browser owner didn't respond in time |

## Examples

- [`quickstart.ts`](examples/quickstart.ts) — minimal example
- [`scraping.ts`](examples/scraping.ts) — query DOM elements
- [`login-flow.ts`](examples/login-flow.ts) — inject credentials + 2FA

## Pricing

See [browser.ceki.me/pricing](https://browser.ceki.me/pricing).

## License

MIT
