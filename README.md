# ceki-browser

TypeScript/Node.js SDK for [ceki.me](https://ceki.me) — rent real browsers from real people for AI agent automation.

## Install

```bash
npm install ceki-browser
```

For the CLI (global):

```bash
npm install -g ceki-browser
```

## Quickstart

```typescript
import { connect } from 'ceki-browser';

const client = await connect(process.env.CEKI_API_KEY!);
const options = await client.search({ geo: 'US', language: 'en' });
const browser = await client.rent(options[0].schedule_id);

await browser.navigate('https://example.com');
const snap = await browser.snapshot();
// snap.screenshot — base64 PNG, snap.chat — new messages

await browser.close();
await client.close();
```

Dev / staging with basic-auth:

```typescript
const client = await connect(process.env.CEKI_API_KEY!, {
  apiUrl: 'https://clawapi.ittribe.org',
  relayUrl: 'wss://browser.ittribe.org/ws/agent',
  basicAuth: ['admin', 'clawdev'],
});
```

## Environment Variables

| Variable | Description |
|---|---|
| `CEKI_API_KEY` | Your API key (required) |
| `CEKI_API_URL` | Override REST API base URL |
| `CEKI_RELAY_URL` | Override relay WebSocket URL |
| `CEKI_CHAT_URL` | Override chat API base URL |
| `CEKI_BASIC_AUTH_USER` / `CEKI_BASIC_AUTH_PASS` | nginx htpasswd credentials |

## API

### `connect(apiKey, options?) -> Client`

Establish a WebSocket connection to the relay. Returns a `Client` instance.

### `ConnectOptions`

| Field | Default | Description |
|---|---|---|
| `apiUrl` | `https://api.ceki.me` | REST API base URL |
| `relayUrl` | `wss://browser.ceki.me/ws/agent` | Relay WebSocket URL |
| `chatUrl` | `https://chat.ceki.me/api/chat` | Chat API URL |
| `basicAuth` | `undefined` | `[user, password]` for nginx htpasswd |
| `reconnect` | `true` | Auto-reconnect on disconnect |

### `client.search(filters?, limit?) -> BrowserOption[]`

Search for available browsers. Filters: `geo`, `language`, etc.

### `client.rent(scheduleId, opts?) -> Browser`

Rent a browser by schedule ID. Waits up to 60s for a match. Options:
- `human` — `'natural'` (default), `'careful'`, or `null` (no humanization)
- `maskingMode` — enable masking
- `fingerprint` — `true`, `false`, or fingerprint object

### `client.resume(sessionId, opts?) -> Browser`

Resume an existing session within its 120s grace window.

### `client.close()`

Close all sessions and the connection.

## Browser Methods

```typescript
await browser.navigate(url)                      // Navigate to URL
await browser.click(x, y)                         // Click at coordinates
await browser.type(text)                          // Type text (char-by-char with humanizer)
await browser.scroll({ deltaY: -300 })            // Scroll
await browser.screenshot({ format: 'png' })       // Screenshot as Buffer
await browser.screenshot({ format: 'base64' })    // Screenshot as {data: string}
await browser.snapshot()                           // Screenshot + chat history
await browser.switchTab()                          // Switch browser tab
await browser.configure({ maskingMode: true })     // Configure session
await browser.upload(selector, pathOrBuffer)       // Upload file to input
await browser.send({ method, params })             // Raw CDP command
await browser.close()                              // End session (alias: release)
await browser.waitUntilEnded()                     // Block until session ends
```

## Chat

```typescript
await browser.chat.send('Please solve the captcha')
await browser.chat.sendImage('/tmp/screenshot.png')
const messages = await browser.chat.history({ since: ts, limit: 50 })
browser.chat.onMessage(msg => console.log(msg.text))
```

## Profile (cookies + storage)

```typescript
// Export profile
const profile = await browser.profile.export({
  domains: ['.reddit.com', 'reddit.com'],
});
fs.writeFileSync('profile.json', JSON.stringify(profile));

// Import profile in next session
const saved = JSON.parse(fs.readFileSync('profile.json', 'utf-8'));
await browser.profile.import(saved);
```

## Human Mode

Browser actions include human-like timing by default — delays before/after actions and per-character typing with jitter.

```typescript
// Default: natural profile (enabled by default)
const browser = await client.rent(scheduleId);

// Explicit profile
const browser = await client.rent(scheduleId, { human: 'careful' });

// Disable humanization
const browser = await client.rent(scheduleId, { human: null });
```

### Environment overrides

- `CEKI_HUMAN_PROFILE` — Override default profile name (`careful`)
- `CEKI_HUMAN_PROFILE_PATH` — Path to custom JSON profile file
- `CEKI_HUMAN_DISABLE=1` — Disable humanization entirely

## Error Classes

| Exception | Cause |
|---|---|
| `AuthError` | Invalid API key or token revoked |
| `RateLimitExceeded` | Too many requests. Has `.retryAfter` (seconds) |
| `InsufficientFunds` | Account balance too low |
| `SessionEnded` | Provider ended the session. Has `.reason` |
| `SessionNotFound` | Session ID not found |
| `SessionExpired` | Session grace window expired |
| `NotOwner` | Not the session owner |
| `CdpUnrecoverable` | CDP connection lost permanently |
| `ConnectionLost` | Relay connection lost after max reconnects |
| `TimeoutError` | Operation timed out |
| `TransportError` | WebSocket or HTTP transport error |
| `ChatSendFailed` | Chat message failed to send |

## CLI — `ceki-browser`

The CLI lets AI agents control rented browsers from shell commands. Each command is a short-lived process.

```bash
npm install -g ceki-browser
export CEKI_API_KEY=your_key
```

### Example: Rent + signup flow

```bash
SESSION=$(ceki-browser rent --schedule 42 | jq -r .session_id)

ceki-browser navigate $SESSION "https://example.com/signup"
ceki-browser snapshot $SESSION -o /tmp/page.png
ceki-browser click $SESSION 350 420
ceki-browser type $SESSION "user@example.com"
ceki-browser click $SESSION 350 480
ceki-browser type $SESSION "securepassword123"
ceki-browser click $SESSION 400 550

ceki-browser stop $SESSION
```

### Example: Captcha handoff

```bash
ceki-browser chat $SESSION send "Please solve the captcha on screen"
REPLY=$(ceki-browser chat $SESSION next --timeout 300)
# JSON: {"from": 123, "text": "done", "ts": "..."} or null on timeout
```

### Subcommands

| Command | Description |
|---|---|
| `rent --schedule N [--fingerprint-from PATH]` | Rent browser, print session JSON |
| `search [--limit N] [--filter k=v]...` | Search available browsers |
| `snapshot <sid> -o PATH` | Screenshot + new chat messages |
| `screenshot <sid> -o PATH [--full]` | Save screenshot to file |
| `navigate <sid> <url>` | Navigate to URL |
| `click <sid> <x> <y>` | Click at coordinates |
| `type <sid> "<text>" [--natural]` | Type text |
| `scroll <sid> <x> <y> <dy>` | Scroll at position |
| `switch-tab <sid>` | Switch browser tab |
| `configure <sid> [--masking-mode V] [--fingerprint V]` | Configure session |
| `cdp <sid> --method M [--params JSON]` | Send raw CDP command |
| `upload <sid> --selector CSS --file PATH [--filename NAME]` | Upload file |
| `wait <sid>` | Block until session ends |
| `chat <sid> send "<text>"` | Send chat message |
| `chat <sid> send-image --image PATH [--text "..."]` | Send image |
| `chat <sid> next [--timeout N]` | Wait for next message |
| `chat <sid> history [--since TS] [--limit N]` | Get chat history |
| `profile export <sid> -o FILE [--domains D] [--no-session-storage]` | Export profile |
| `profile import <sid> -i FILE` | Import profile |
| `stop <sid>` | End session |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic error |
| 2 | Auth error (missing `CEKI_API_KEY`) |
| 3 | Session not found / expired / not owner |
| 4 | Timeout |
| 5 | Network / WebSocket error |

All output is JSON on stdout. Errors go to stderr as `{"error":"...","code":"..."}`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
