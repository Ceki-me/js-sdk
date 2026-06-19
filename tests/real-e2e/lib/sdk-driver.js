// Thin loader for js-sdk built artifacts so the runner exercises the SAME
// shape that consumers see on npm. Imports from ../../../dist (the tsup
// build output), NOT from src/. If the build is missing, fail fast with a
// hint to run `npm run build`.

const path = require('path');
const fs = require('fs');

const DIST_DIR = path.resolve(__dirname, '..', '..', '..', 'dist');
const DIST_ENTRY = path.join(DIST_DIR, 'index.cjs');

function loadSdk() {
  if (!fs.existsSync(DIST_ENTRY)) {
    throw new Error(
      `js-sdk dist not built — expected ${DIST_ENTRY}. Run \`npm run build\` first.`
    );
  }
  return require(DIST_ENTRY);
}

async function rentBrowser({ apiKey, scheduleId, mode, opts }) {
  const sdk = loadSdk();
  const { Client } = sdk;
  const connect = {};
  if (process.env.CEKI_API_URL) connect.apiUrl = process.env.CEKI_API_URL;
  if (process.env.CEKI_RELAY_URL) connect.relayUrl = process.env.CEKI_RELAY_URL;
  if (process.env.CEKI_CHAT_URL) connect.chatUrl = process.env.CEKI_CHAT_URL;
  if (process.env.CEKI_BASIC_AUTH_USER && process.env.CEKI_BASIC_AUTH_PASS) {
    connect.basicAuth = [process.env.CEKI_BASIC_AUTH_USER, process.env.CEKI_BASIC_AUTH_PASS];
  }
  const client = await Client.create(apiKey, connect);
  const rentOpts = { ...(opts || {}) };
  if (mode) rentOpts.mode = mode;
  const browser = await client.rent(scheduleId, rentOpts);
  return { client, browser };
}

module.exports = { loadSdk, rentBrowser };
