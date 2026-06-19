#!/usr/bin/env node
// js-sdk real-e2e runner.
//
//   node tests/real-e2e/runner.js [profile] [--filter X[,Y]] [--modes main,incognito] [--skip-provider]
//
// Brings up the same provider-runner stack the python qa-suite uses,
// then drives every case in cases/*.js via the BUILT js-sdk (dist/).
//
// Behavioral cases mirror the python plugin-integration suite:
//   - typing default-ON jitter, no char-doubling, local { human: false } toggle
//   - mouse-jitter default-ON, trail ≥ 2 unique mousemoves
//   - global CEKI_HUMAN_DISABLE=1 — runs in a child process with the env set
//     BEFORE the SDK is imported (so resolveHumanizer sees it)
//
// Env requirements (loaded from qa-suite/ui-tests/browserlend/.env.dev):
//   RENTER_AGENT_TOKEN  — renter agent token used by the SDK as apiKey
//   CEKI_QA_IMAP_USER / CEKI_QA_IMAP_PASS — IMAP OTP creds for owner login
//   QA_SUITE_ROOT       — location of the qa-suite checkout (required)
//
// Exit 0 if every non-SKIP case PASSes, 1 otherwise.

const fs = require('fs');
const path = require('path');

const bridge = require('./lib/qa-bridge');
const fixtureServer = require('./lib/fixture-server');
const { rentBrowser } = require('./lib/sdk-driver');

const ROOT = __dirname;
const FIXTURES = path.join(ROOT, 'fixtures');
const CASES_DIR = path.join(ROOT, 'cases');
const REPORTS_DIR = path.resolve(ROOT, 'reports');

const args = process.argv.slice(2);
const profileName = args.find(a => !a.startsWith('--')) || 'dev';
const filterIdx = args.indexOf('--filter');
const FILTER = filterIdx >= 0 ? args[filterIdx + 1] : null;
const modesIdx = args.indexOf('--modes');
const REQUESTED_MODES = modesIdx >= 0
  ? args[modesIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
  : ['main'];
const SKIP_PROVIDER = args.includes('--skip-provider');
const PROVIDER_TIMEOUT_SEC = parseInt(process.env.PROVIDER_TIMEOUT_SEC || '900', 10);
const RENTER_AGENT_ID = parseInt(process.env.RENTER_AGENT_ID || '14', 10);
const OWNER_EMAIL = process.env.CEKI_QA_IMAP_USER;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [js-sdk-e2e] ${msg}`);
}

function loadProfileEnv(name) {
  if (!bridge.QA_SUITE_ROOT) return;
  const fp = path.join(bridge.QA_SUITE_ROOT, 'ui-tests', 'browserlend', `.env.${name}`);
  if (fs.existsSync(fp)) bridge.loadEnvFile(fp);
}

function discoverCases() {
  const out = [];
  for (const f of fs.readdirSync(CASES_DIR).sort()) {
    if (!f.endsWith('.js') || f.startsWith('_')) continue;
    const mod = require(path.join(CASES_DIR, f));
    if (FILTER) {
      const tokens = FILTER.split(',').map(s => s.trim()).filter(Boolean);
      const name = mod.name || f;
      const cat = mod.category || '';
      const ok = tokens.some(t => name.includes(t) || cat.includes(t));
      if (!ok) continue;
    }
    out.push({ ...mod, _file: f });
  }
  return out;
}

async function runGlobalHumanDisableCase({ scheduleId, fixtureUrl, mode, log }) {
  // Inline (same-process). _resolveHumanizer reads process.env on every
  // rent/resume — so setting CEKI_HUMAN_DISABLE=1 just before a fresh
  // rent gives us a humanizer-null Browser, no child needed.
  const { evalInPage } = require('./lib/dom');
  const prev = process.env.CEKI_HUMAN_DISABLE;
  process.env.CEKI_HUMAN_DISABLE = '1';
  let bundle = null;
  try {
    for (let i = 0; i < 8; i++) {
      try {
        bundle = await rentBrowser({
          apiKey: process.env.RENTER_AGENT_TOKEN,
          scheduleId,
          mode,
        });
        break;
      } catch (e) {
        if (!/Browser is currently in use|busy|in_use/i.test(e.message)) throw e;
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
      }
    }
    if (!bundle) return { status: 'FAIL', detail: 'rent retry exhausted (Browser in use)' };
    const browser = bundle.browser;
    // Provider needs a few seconds after rent to attach to a fresh target.
    await new Promise(r => setTimeout(r, 4000));
    await browser.navigate(`${fixtureUrl}/form.html?case=globdis-${mode}`, 30000);
    await new Promise(r => setTimeout(r, 800));
    await evalInPage(browser, 'window.__qaReset && window.__qaReset(); 1');
    await browser.click(40, 40);
    await new Promise(r => setTimeout(r, 250));
    await evalInPage(browser, 'window.__pointerLog = []; window.__keyTimes = []; 1');

    await browser.click(260, 200);
    await new Promise(r => setTimeout(r, 500));
    const pl = await evalInPage(browser, 'window.__pointerLog || []');
    const uniq = new Set((pl || []).map(p => p[0] + ',' + p[1]));
    if (uniq.size >= 3) {
      return { status: 'FAIL', detail: `mode=${mode} click still traced uniq=${uniq.size} — global flag did not silence mouse jitter` };
    }
    const rect = await evalInPage(browser,
      '(function(){var e=document.getElementById("email2");var b=e.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()'
    );
    await browser.click(rect.x, rect.y);
    await new Promise(r => setTimeout(r, 200));
    await evalInPage(browser, 'window.__keyTimes = []; 1');
    const TEXT = 'global-disable-probe-xyz';
    await browser.type(TEXT);
    await new Promise(r => setTimeout(r, 500));
    const arr = await evalInPage(browser, 'window.__keyTimes || []');
    if (!Array.isArray(arr) || arr.length < TEXT.length) {
      return { status: 'FAIL', detail: `mode=${mode} keyTimes=${arr ? arr.length : '?'} expected ≥${TEXT.length}` };
    }
    const iv = [];
    for (let i = 1; i < arr.length; i++) iv.push(arr[i].t - arr[i - 1].t);
    const mean = iv.reduce((a, b) => a + b, 0) / (iv.length || 1);
    const stddev = Math.sqrt(iv.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (iv.length || 1));
    if (stddev >= 5) {
      return { status: 'FAIL', detail: `mode=${mode} typing still humanized stddev=${stddev.toFixed(1)}ms — global flag did not silence typing` };
    }
    return { status: 'PASS', detail: `mode=${mode} click uniq=${uniq.size} (no trail), typing stddev=${stddev.toFixed(1)}ms (flat)` };
  } finally {
    if (bundle) {
      try { await bundle.browser.close(); } catch {}
      try { await bundle.client.disconnect(); } catch {}
    }
    if (prev === undefined) delete process.env.CEKI_HUMAN_DISABLE;
    else process.env.CEKI_HUMAN_DISABLE = prev;
  }
}

(async () => {
  log(`profile=${profileName} filter=${FILTER || '*'} modes=${REQUESTED_MODES.join(',')}`);
  bridge.assertQaSuite();
  bridge.loadEnvFile(bridge.ENV_FILE);
  loadProfileEnv(profileName);

  if (!process.env.RENTER_AGENT_TOKEN) {
    console.error('[js-sdk-e2e] missing env RENTER_AGENT_TOKEN');
    process.exit(2);
  }
  if (!OWNER_EMAIL) {
    console.error('[js-sdk-e2e] missing env CEKI_QA_IMAP_USER (owner email for OTP login)');
    process.exit(2);
  }

  // Map qa-suite env conventions onto js-sdk env conventions so the SDK
  // resolveConfig picks up the dev endpoints.
  const profile = bridge.loadProfile(profileName);
  if (!process.env.CEKI_API_URL && profile.apiBase) process.env.CEKI_API_URL = profile.apiBase;
  if (!process.env.CEKI_RELAY_URL && process.env.RELAY_URL) process.env.CEKI_RELAY_URL = process.env.RELAY_URL;
  if (!process.env.CEKI_BASIC_AUTH_USER && profile.httpCredentials) {
    process.env.CEKI_BASIC_AUTH_USER = profile.httpCredentials.username;
    process.env.CEKI_BASIC_AUTH_PASS = profile.httpCredentials.password;
  }

  const cases = discoverCases();
  log(`discovered ${cases.length} cases`);
  if (cases.length === 0) {
    console.error('[js-sdk-e2e] no cases discovered');
    process.exit(2);
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORTS_DIR, `JS_SDK_REAL_E2E_${profileName}_${stamp}.md`);
  const providerLog = `/tmp/js-sdk-e2e-provider-${stamp}.log`;

  const results = [];
  let providerProc = null;
  let fxt = null;
  let providerScheduleId = process.env.PROVIDER_SCHEDULE_ID
    ? parseInt(process.env.PROVIDER_SCHEDULE_ID, 10)
    : null;
  let providerToken = process.env.PROVIDER_TOKEN || null;

  try {
    fxt = await fixtureServer.start({ root: FIXTURES });
    log(`fixtures at ${fxt.url}`);

    if (!SKIP_PROVIDER) {
      if (!providerToken || !providerScheduleId) {
        const prov = await bridge.provisionScheduleAsOwner({
          profile,
          ownerEmail: OWNER_EMAIL,
          log,
        });
        providerScheduleId = prov.scheduleId;
        providerToken = prov.extToken;
        // Pivot renter so `rent({ mode: 'main' })` is legal once provider boots.
        if (REQUESTED_MODES.includes('main')) {
          try {
            await bridge.pivotRenter({
              profile,
              ownerToken: prov.ownerToken,
              scheduleId: providerScheduleId,
              renterAgentId: RENTER_AGENT_ID,
              log,
            });
          } catch (e) {
            log(`renter-pivot WARN: ${e.message} — main-mode cases will likely fail`);
          }
        }
      }
      providerProc = bridge.spawnProvider({
        profileName,
        providerLog,
        providerToken,
        providerScheduleId,
        timeoutSec: PROVIDER_TIMEOUT_SEC,
        log,
      });
      const ready = await bridge.waitProviderReady(providerLog, 6 * 60 * 1000);
      if (!ready) {
        const tail = fs.existsSync(providerLog)
          ? fs.readFileSync(providerLog, 'utf8').split('\n').slice(-30).join('\n')
          : '(no log)';
        throw new Error(`provider not READY within 6m. Tail:\n${tail}`);
      }
      log('provider READY — settling 3s');
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!providerScheduleId) {
      throw new Error('no providerScheduleId — set PROVIDER_SCHEDULE_ID or use provisioning');
    }

    // Retry helper for transient "Browser is currently in use" — the relay
    // takes a few seconds to release a schedule after browser.close() and
    // client.disconnect() return; without this every second rent on the
    // same schedule loses the race.
    async function rentWithRetry({ apiKey, scheduleId, mode, attempts = 5, baseDelayMs = 4000 }) {
      let lastErr = null;
      for (let i = 0; i < attempts; i++) {
        try {
          return await rentBrowser({ apiKey, scheduleId, mode });
        } catch (e) {
          lastErr = e;
          if (!/Browser is currently in use|busy|in_use/i.test(e.message)) throw e;
          const delay = baseDelayMs * (i + 1);
          log(`rent retry ${i + 1}/${attempts} after ${delay}ms (${e.message.slice(0, 80)})`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw lastErr || new Error('rent retry exhausted');
    }

    for (let modeIdx = 0; modeIdx < REQUESTED_MODES.length; modeIdx++) {
      const mode = REQUESTED_MODES[modeIdx];
      if (modeIdx > 0) {
        log(`settling 6s before next mode rent…`);
        await new Promise(r => setTimeout(r, 6000));
      }
      log(`=== mode=${mode} ===`);
      let sdkBundle = null;
      let sharedRentError = null;
      try {
        sdkBundle = await rentWithRetry({
          apiKey: process.env.RENTER_AGENT_TOKEN,
          scheduleId: providerScheduleId,
          mode,
        });
        log(`rented session_id=${sdkBundle.browser.sessionId} mode=${mode}`);
        // Sanity navigate so an incognito-without-allow misconfig fails fast.
        try {
          await sdkBundle.browser.navigate(`${fxt.url}/form.html?sanity=1`, 30000);
        } catch (e) {
          if (/win_null|tab_create_failed|incognito/i.test(e.message)) {
            sharedRentError = `mode "${mode}" unusable: ${e.message.slice(0, 240)}`;
            log(sharedRentError);
            try { await sdkBundle.browser.close(); } catch {}
            try { await sdkBundle.client.disconnect(); } catch {}
            sdkBundle = null;
          } else {
            log(`sanity navigate non-fatal: ${e.message.slice(0, 200)}`);
          }
        }
      } catch (e) {
        sharedRentError = e.message;
        log(`rent failed (${mode}): ${e.message}`);
      }

      const ctx = {
        browser: sdkBundle && sdkBundle.browser,
        client: sdkBundle && sdkBundle.client,
        fixtureUrl: fxt.url,
        scheduleId: providerScheduleId,
        mode,
        profileName,
        log: (m) => log(`  · [${mode}] ${m}`),
      };

      const INTER_CASE_SLEEP_MS = 1000;
      const runOne = async (c, idx) => {
        if (idx > 0) await new Promise(r => setTimeout(r, INTER_CASE_SLEEP_MS));
        if (Array.isArray(c.modes) && !c.modes.includes(mode)) return;
        const start = Date.now();
        let res;
        try {
          if (sharedRentError) {
            res = { status: 'SKIP', detail: sharedRentError };
          } else {
            res = await c.run(ctx);
          }
        } catch (e) {
          res = { status: 'FAIL', detail: `THREW: ${e.message}` };
        }
        const elapsed = Date.now() - start;
        const tag = res.status === 'PASS' ? 'PASS' : res.status === 'SKIP' ? 'SKIP' : 'FAIL';
        log(`${tag.padEnd(4)} [${mode}] ${c.name} (${elapsed}ms) — ${res.detail || ''}`);
        results.push({ ...res, name: c.name, mode, category: c.category, elapsedMs: elapsed, file: c._file });
      };

      for (let i = 0; i < cases.length; i++) await runOne(cases[i], i);

      // Free the session BEFORE the inline global-disable probe rents a
      // fresh one on the same schedule.
      if (sdkBundle) {
        try { await sdkBundle.browser.close(); } catch {}
        try { await sdkBundle.client.disconnect(); } catch {}
        sdkBundle = null;
      }

      if (!sharedRentError) {
        // Relay needs a window to mark the schedule free again.
        await new Promise(r => setTimeout(r, 8000));
        const start = Date.now();
        const res = await runGlobalHumanDisableCase({
          scheduleId: providerScheduleId,
          fixtureUrl: fxt.url,
          mode,
          log,
        });
        const elapsed = Date.now() - start;
        const tag = res.status === 'PASS' ? 'PASS' : res.status === 'SKIP' ? 'SKIP' : 'FAIL';
        log(`${tag.padEnd(4)} [${mode}] global-human-disable (${elapsed}ms) — ${res.detail || ''}`);
        results.push({ ...res, name: 'global-human-disable', mode, category: 'plugin-humanizer-flags', elapsedMs: elapsed });
      } else {
        results.push({ status: 'SKIP', name: 'global-human-disable', mode, detail: sharedRentError, elapsedMs: 0 });
      }
    }
  } catch (e) {
    log(`FATAL: ${e.message}`);
    results.push({ status: 'FAIL', name: 'runner-bootstrap', mode: '-', detail: e.message, elapsedMs: 0 });
  } finally {
    if (fxt) await fixtureServer.stop(fxt);
    if (providerProc) {
      log('killing provider-runner');
      bridge.killProvider(providerProc, log);
    }
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip} of ${results.length}`;
  log(`=== ${summary} ===`);

  const lines = [];
  lines.push(`# js-sdk real-e2e report — ${profileName} — ${stamp}`);
  lines.push('');
  lines.push(`Summary: **${summary}**`);
  lines.push('');
  lines.push('| status | mode | case | elapsed | detail |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of results) {
    lines.push(`| ${r.status} | ${r.mode} | ${r.name} | ${r.elapsedMs}ms | ${(r.detail || '').replace(/\|/g, '\\|').slice(0, 300)} |`);
  }
  fs.writeFileSync(reportPath, lines.join('\n') + '\n');
  log(`report → ${reportPath}`);

  process.exit(fail === 0 ? 0 : 1);
})();
