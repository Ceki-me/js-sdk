// Bridge to the python qa-suite infrastructure: OTP login, schedule
// provisioning, renter pivot, provider-runner. We deliberately reuse the
// qa-suite modules instead of re-implementing — every change there lands
// here automatically.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// qa-suite root MUST be supplied via QA_SUITE_ROOT — the suite lives
// outside this repo, so there is no portable default we can fall back to.
const QA_SUITE_ROOT = process.env.QA_SUITE_ROOT;

const UI_TESTS = QA_SUITE_ROOT ? path.join(QA_SUITE_ROOT, 'ui-tests') : null;
const SUITE_LIB = QA_SUITE_ROOT ? path.join(QA_SUITE_ROOT, 'lib') : null;
const PROVIDER_RUNNER = UI_TESTS ? path.join(UI_TESTS, 'browserlend', 'provider-runner.js') : null;
const ENV_FILE = UI_TESTS ? path.join(UI_TESTS, 'browserlend', '.env.dev') : null;

function assertQaSuite() {
  if (!QA_SUITE_ROOT) {
    throw new Error('QA_SUITE_ROOT not set — point it at your qa-suite checkout');
  }
  if (!fs.existsSync(PROVIDER_RUNNER)) {
    throw new Error(
      `qa-suite not found at ${QA_SUITE_ROOT} (expected provider-runner at ${PROVIDER_RUNNER})`
    );
  }
}

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^export\s+([A-Z_][A-Z0-9_]*)=['"]?([^'"\n]*)['"]?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function loadProfile(profileName) {
  const fp = path.join(QA_SUITE_ROOT, 'profiles', `${profileName}.js`);
  return require(fp);
}

const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function postJson(url, token, body, profile) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  if (profile && profile.httpCredentials) {
    const { username, password } = profile.httpCredentials;
    headers['X-HTTP-Basic'] = Buffer.from(`${username}:${password}`).toString('base64');
  }
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

async function loginOwnerViaOtp(profile, email) {
  const { loginViaOtp } = require(path.join(SUITE_LIB, 'auth'));
  return loginViaOtp({ profile, email });
}

async function provisionScheduleAsOwner({ profile, ownerEmail, log }) {
  log(`OTP login as ${ownerEmail}…`);
  const { token: ownerToken, user: ownerUser } = await loginOwnerViaOtp(profile, ownerEmail);
  log(`owner login ok user_id=${ownerUser.id}`);
  const brResp = await postJson(profile.apiBase + '/browsers', ownerToken, { price: 0.0167 }, profile);
  if (brResp.status !== 200 && brResp.status !== 201) {
    throw new Error(`POST /api/browsers HTTP ${brResp.status}: ${(brResp.text || '').slice(0, 240)}`);
  }
  const scheduleId = brResp.json && brResp.json.id;
  const extToken   = brResp.json && brResp.json.ext_token;
  if (!scheduleId || !extToken) {
    throw new Error(`POST /api/browsers no id/ext_token: ${(brResp.text || '').slice(0, 240)}`);
  }
  log(`schedule_id=${scheduleId} ext_token=${String(extToken).slice(0, 12)}…`);
  return { ownerToken, scheduleId, extToken };
}

async function pivotRenter({ profile, ownerToken, scheduleId, renterAgentId, log }) {
  log(`pivot renter agent_id=${renterAgentId} main_profile=true on schedule=${scheduleId}…`);
  const resp = await postJson(
    profile.apiBase + `/me/browsers/${scheduleId}/renters`,
    ownerToken,
    { agent_id: renterAgentId, main_profile: true, price: 0 },
    profile
  );
  if (resp.status !== 200 && resp.status !== 201) {
    const body = (resp.text || '').slice(0, 240);
    if (/already|exists|duplicate/i.test(body)) {
      log(`renter pivot already present (HTTP ${resp.status})`);
      return;
    }
    throw new Error(`renter pivot HTTP ${resp.status}: ${body}`);
  }
  log(`renter pivot ok (HTTP ${resp.status})`);
}

function spawnProvider({ profileName, providerLog, providerToken, providerScheduleId, timeoutSec, log }) {
  const env = {
    ...process.env,
    QA_PROFILE: profileName,
    PROVIDER_TOKEN: providerToken,
    PROVIDER_SCHEDULE_ID: String(providerScheduleId),
  };
  const cmd = 'xvfb-run';
  const cmdArgs = ['-a', 'node', PROVIDER_RUNNER, '--scenario', 'A', '--timeout', String(timeoutSec)];
  const out = fs.openSync(providerLog, 'w');
  const proc = spawn(cmd, cmdArgs, { env, stdio: ['ignore', out, out], detached: true });
  proc.unref();
  log(`spawned provider-runner pid=${proc.pid} log=${providerLog}`);
  return proc;
}

function killProvider(proc, log) {
  if (!proc) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
  try { proc.kill('SIGTERM'); } catch {}
  if (log) log(`killed provider pid=${proc.pid}`);
}

async function waitProviderReady(providerLog, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = fs.readFileSync(providerLog, 'utf8');
      if (data.includes('"status":"READY"')) return true;
      if (/ERROR:/m.test(data) && /Extension not online/.test(data)) {
        throw new Error('provider failed to come online');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

module.exports = {
  QA_SUITE_ROOT,
  PROVIDER_RUNNER,
  ENV_FILE,
  assertQaSuite,
  loadEnvFile,
  loadProfile,
  postJson,
  loginOwnerViaOtp,
  provisionScheduleAsOwner,
  pivotRenter,
  spawnProvider,
  killProvider,
  waitProviderReady,
};
