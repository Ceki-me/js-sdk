# @ceki/sdk

TypeScript/Node.js SDK for [browser.ceki.me](https://browser.ceki.me) — rent real browsers from real people for AI agent automation.

## Install

```bash
npm install @ceki/sdk
```

For the CLI (global):

```bash
npm install -g @ceki/sdk
```

## Quickstart

```typescript
import { connect } from '@ceki/sdk';

const client = await connect(process.env.CEKI_API_KEY!);
const options = await client.search({ geo: 'US', language: 'en' });
const browser = await client.rent(options[0].schedule_id);

await browser.navigate('https://example.com');
const snap = await browser.snapshot();
// snap.screenshot — base64 PNG, snap.chat — new messages

await browser.close();
await client.close();
```

## Environment Variables

| Variable | Description |
|---|---|
| `CEKI_API_KEY` | Your API key (required) |

## API

### `connect(apiKey, options?) -> Client`

Establish a WebSocket connection to the relay. Returns a `Client` instance.

### `ConnectOptions`

| Field | Default | Description |
|---|---|---|
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
await browser.type(text)                          // Type text — one Ceki.typeText command; extension does per-char keydown/keyUp + humanizer delays
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

## CLI

The SDK installs a `ceki` CLI binary on your PATH.

### Install

```bash
npm install -g @ceki/sdk
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CEKI_API_KEY` | yes | Agent token (`ag_...`) |

### Quick start

```bash
export CEKI_API_KEY=ag_...

SCHEDULE=$(ceki search --limit 1 | jq -r '.[0].schedule_id')
SID=$(ceki rent --schedule $SCHEDULE | jq -r .session_id)
ceki navigate $SID https://example.com
ceki snapshot $SID -o snap.png
ceki stop $SID
```

The CLI persists session state locally — after `rent` it saves the session ID so subsequent commands resume it by SID without re-renting.

### Commands

#### Discovery and lifecycle

| Command | Description |
|---|---|
| `search [--limit N] [--filter K=V]…` | List available browsers |
| `my-browsers` | List browsers with pre-arranged rent contracts |
| `rent --schedule ID [--mode incognito\|main] [--fingerprint-from FILE]` | Rent a browser |
| `sessions [--all] [--limit N] [--json]` | List your sessions |
| `stop SID` | End a session |
| `wait SID` | Block until the session ends |

#### Browser control

| Command | Description |
|---|---|
| `navigate SID URL` | Open URL |
| `click SID X Y` | Click at viewport coordinates |
| `type SID TEXT [--natural]` | Type text into focused element |
| `scroll SID X Y DY` | Scroll from (X, Y) by `DY` pixels |
| `screenshot SID -o FILE [--format png\|jpeg] [--full]` | Save screenshot |
| `snapshot SID -o FILE` | Screenshot + new chat messages |
| `switch-tab SID` | Switch active tab |
| `upload SID --selector CSS --file PATH [--filename NAME]` | Attach file to `<input type="file">` |

#### Chat with host

| Command | Description |
|---|---|
| `chat SID send TEXT` | Send message to host |
| `chat SID next [--timeout SEC]` | Wait for next host message |
| `chat SID history [--since TS] [--limit N]` | Fetch chat history |
| `chat SID send-image --image PATH [--text MSG]` | Send image to host |

#### Advanced

| Command | Description |
|---|---|
| `profile SID export -o FILE [--domains CSV] [--no-session-storage]` | Export cookies / localStorage |
| `profile SID import -i FILE` | Import previously exported profile |
| `request-captcha SID [--acceptance SEC] [--completion SEC] [--manual]` | Ask host to solve CAPTCHA |
| `configure SID [--masking-mode VAL] [--fingerprint VAL]` | Toggle masking / fingerprint |
| `cdp SID --method METHOD [--params JSON]` | Raw CDP command |

### Output and errors

Successful commands write a single JSON line to stdout. Errors go to stderr as `{"error": "...", "code": "..."}`. Pipe stdout through `jq` to chain commands.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | generic error |
| `2` | `CEKI_API_KEY` not set |
| `3` | session not found or not owner |
| `4` | timeout |
| `5` | network / connection error |
| `130` | interrupted (Ctrl-C) |

Full reference (with EN+RU): https://browser.ceki.me/docs#cli

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
