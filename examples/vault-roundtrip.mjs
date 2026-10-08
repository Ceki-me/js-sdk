/**
 * Browser Vault roundtrip — save a session snapshot to the vault and restore it.
 *
 * Requires: a user Sanctum token (the vault endpoints resolve to a user).
 * Point CEKI_API_URL at your API environment (defaults to https://api.ceki.me).
 *
 * Three modes:
 *   1. `export-envelope` — read a locally exported profile.json and push it to
 *      the vault (no live browser needed).
 *   2. `save` — rent a browser, export its state, POST/PUT to the vault.
 *   3. `rent-with-vault` — rent a browser and restore a vault session by id.
 *
 * Run (from the repo root, after `npm run build`):
 *   node examples/vault-roundtrip.mjs export-envelope ./profile.json --label "vc.ru"
 *   node examples/vault-roundtrip.mjs save --schedule 123
 *   node examples/vault-roundtrip.mjs rent-with-vault --schedule 123 --vault 8
 */
import { readFileSync } from 'node:fs';
import { Client } from '../dist/index.js';

const apiKey = process.env.CEKI_API_KEY;
const apiUrl = process.env.CEKI_API_URL ?? 'https://api.ceki.me';

if (!apiKey) {
  console.error('CEKI_API_KEY not set (use a user Sanctum token for vault ops)');
  process.exit(2);
}

function makeClient() {
  // No WS connection: vault ops are plain HTTP.
  return new Client(apiKey, {
    apiUrl,
    relayUrl: process.env.CEKI_RELAY_URL ?? 'wss://browser.ceki.me/ws/agent',
    chatUrl: process.env.CEKI_CHAT_URL ?? 'https://chat.ceki.me/api/chat',
    reconnect: false,
  });
}

async function cmdExportEnvelope(file, label) {
  const client = makeClient();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    let envelope;
    if (raw && typeof raw === 'object' && 'data' in raw) {
      envelope = raw.data; // already a vault envelope
    } else {
      const { normalizeProfileForVault } = await import('../dist/index.js');
      envelope = normalizeProfileForVault(raw);
    }
    const id = await client.vault.create(envelope, { label: label ?? null });
    console.log(`created vault session ${id}`);
  } finally {
    await client.disconnect();
  }
}

async function cmdSave(scheduleId) {
  const { connect } = await import('../dist/index.js');
  const client = await connect(apiKey, {
    apiUrl,
    relayUrl: process.env.CEKI_RELAY_URL ?? 'wss://browser.ceki.me/ws/agent',
    chatUrl: process.env.CEKI_CHAT_URL ?? 'https://chat.ceki.me/api/chat',
    reconnect: false,
  });
  try {
    const browser = await client.rent(scheduleId, { human: null });
    await browser.navigate('https://vc.ru');
    await new Promise((r) => setTimeout(r, 3000));
    const id = await browser.vault.save({ label: 'vc.ru snapshot' });
    console.log(`saved vault session ${id}`);
    await browser.close();
  } finally {
    await client.disconnect();
  }
}

async function cmdRentWithVault(scheduleId, vaultId) {
  const { connect } = await import('../dist/index.js');
  const client = await connect(apiKey, {
    apiUrl,
    relayUrl: process.env.CEKI_RELAY_URL ?? 'wss://browser.ceki.me/ws/agent',
    chatUrl: process.env.CEKI_CHAT_URL ?? 'https://chat.ceki.me/api/chat',
    reconnect: false,
  });
  try {
    const browser = await client.rent(scheduleId, { human: null, vault: vaultId });
    console.log(`rented ${browser.sessionId} with vault ${vaultId}`);
    // cookies are applied immediately; navigate to trigger per-origin storage flush
    await browser.navigate('https://vc.ru');
    await new Promise((r) => setTimeout(r, 3000));
    await browser.close();
  } finally {
    await client.disconnect();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'export-envelope') {
  const file = rest[0];
  const label = rest.includes('--label') ? rest[rest.indexOf('--label') + 1] : undefined;
  if (!file) { console.error('usage: vault-roundtrip.mjs export-envelope <file> [--label L]'); process.exit(1); }
  await cmdExportEnvelope(file, label);
} else if (cmd === 'save') {
  const sched = rest.includes('--schedule') ? Number(rest[rest.indexOf('--schedule') + 1]) : NaN;
  if (!Number.isFinite(sched)) { console.error('usage: vault-roundtrip.mjs save --schedule N'); process.exit(1); }
  await cmdSave(sched);
} else if (cmd === 'rent-with-vault') {
  const sched = rest.includes('--schedule') ? Number(rest[rest.indexOf('--schedule') + 1]) : NaN;
  const vault = rest.includes('--vault') ? Number(rest[rest.indexOf('--vault') + 1]) : NaN;
  if (!Number.isFinite(sched) || !Number.isFinite(vault)) {
    console.error('usage: vault-roundtrip.mjs rent-with-vault --schedule N --vault ID'); process.exit(1);
  }
  await cmdRentWithVault(sched, vault);
} else {
  console.error(`unknown command: ${cmd ?? '(none)'}`);
  process.exit(1);
}