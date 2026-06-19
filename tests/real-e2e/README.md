# js-sdk real-e2e suite

Real-Chrome behavioral tests for **@ceki/sdk** — the JS twin of the python
`qa-suite/ui-tests/plugin-integration` cases. Drives the BUILT SDK
(`dist/index.cjs`) against a freshly provisioned dev provider, in both
`main` and `incognito` modes.

Mocks are forbidden here. If the build is missing or the qa-suite
checkout is unreachable the runner fails fast.

## Quick start

```bash
# 1. Build the SDK first — the runner imports from dist/
npm run build

# 2. Build a fresh extension you want to test against and point
#    BROWSERLEND_EXT_DIR at it.
export BROWSERLEND_EXT_DIR=/abs/path/to/extension/dist

# 3. Point the runner at your qa-suite checkout and start it.
export QA_SUITE_ROOT=/abs/path/to/qa-suite
xvfb-run -a node tests/real-e2e/runner.js dev --modes main,incognito
```

The first run **provisions a fresh schedule** via the dev API
(POST `/api/browsers` as the owner whose OTP creds are in
`CEKI_QA_IMAP_USER` / `CEKI_QA_IMAP_PASS`), pivots the renter to allow
`main_profile=true`, boots the qa-suite provider-runner, and only then
begins exercising the SDK.

Reports are written to `tests/real-e2e/reports/JS_SDK_REAL_E2E_*.md`.

## Cases

| File | Asserts |
| --- | --- |
| `cases/01_navigate.js` | `browser.navigate(url)` lands on URL |
| `cases/02_click_counter.js` | `browser.click(x,y)` increments the on-page counter |
| `cases/03_type_no_doubling.js` | `browser.type(text)` leaves exactly `text` (no doubling) |
| `cases/04_type_default_jitter.js` | typing humanizer **ON by default**, stddev ≥ 5 ms in both modes |
| `cases/05_mouse_jitter_default_on.js` | mouse jitter **ON by default**, ≥ 2 unique mousemoves in both modes |
| `cases/06_local_human_disable_typing.js` | per-call `{ human: false }` flattens **only** that call |
| `cases/07_scroll.js` | `browser.scroll({ deltaY })` moves `window.scrollY` |
| `cases/08_screenshot.js` | `browser.screenshot()` returns a non-empty PNG |
| `cases/09_snapshot.js` | `browser.snapshot()` returns `{ screenshot, ... }` |
| _global-human-disable_ (runner spawns a child) | `CEKI_HUMAN_DISABLE=1` silences mouse + typing globally |

Why a child for global-disable: the SDK reads `process.env.CEKI_HUMAN_DISABLE`
at `Client` construction time (in `resolveHumanizer`). Setting the env
after the parent SDK is already loaded has no effect — so the probe
runs in `node lib/global-disable-probe.js` with the env set fresh.

## CLI flags

| Flag | Meaning |
| --- | --- |
| `<profile>` (positional) | qa-suite profile (default `dev`) |
| `--filter X[,Y]` | run only cases whose name or category contains one of the tokens |
| `--modes main,incognito` | which modes to exercise (default `main`) |
| `--skip-provider` | reuse an already-running provider (set `PROVIDER_TOKEN` + `PROVIDER_SCHEDULE_ID`) |

## Required env

Loaded automatically from `qa-suite/ui-tests/browserlend/.env.dev`:

| Var | Meaning |
| --- | --- |
| `RENTER_AGENT_TOKEN` | renter agent token used as `apiKey` for the SDK |
| `CEKI_QA_IMAP_USER` / `CEKI_QA_IMAP_PASS` | IMAP for the OTP login that owns the provisioning |
| `CEKI_API_URL` / `CEKI_RELAY_URL` / `CEKI_CHAT_URL` | env endpoints |
| `QA_SUITE_ROOT` | location of the qa-suite checkout (required) |
| `BROWSERLEND_EXT_DIR` (optional) | extension dist for provider-runner |

## What this suite does **not** do

* No upload / captcha / multi-tab cases yet — the python suite owns those.
  Add them here as the SDK grows the matching surface.
* No mocked endpoints. Every assertion reads real DOM state via
  `Runtime.evaluate` on the rented session.
