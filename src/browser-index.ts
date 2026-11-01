/**
 * Browser entry for @ceki/sdk.
 *
 * Exports the same core API as the Node entry (Client, Browser, Vault,
 * errors, types) but OMITS the Node-only surfaces: CLI, daemon, contract-CLI,
 * and anything that pulls `node:fs` / `node:http` / `child_process`.
 *
 * Build-time aliases (tsup.config.ts `esbuildOptions.alias`) swap the two
 * Node transports for browser twins:
 *   - `ws`            -> `./ws-browser.js`   (native WebSocket adapter)
 *   - `./webrtc.js`   -> `./webrtc-browser.js` (native RTCPeerConnection)
 *
 * Usage on the front (user circuit — rent a session server-side first):
 *
 *   import { connectAsUserSession } from '@ceki/sdk/browser';
 *   // 1. POST /api/sessions {browser_id, mode} as the logged-in user
 *   //    -> { session_id, renter_token, ws_url }
 *   // 2. const client = await connectAsUserSession({ renterToken, relayUrl, apiUrl })
 *   // 3. const browser = await client.rent(scheduleId, { mode })
 *   //    (relay matches the same session; CDP flows over the P2P ceki-cmd DC)
 */
import { Client } from './client.js';
import type { ConnectOptions } from './types.js';

export { Client } from './client.js';
export { Browser } from './browser.js';
export { Humanizer } from './humanize/humanizer.js';
export { BrowserProfile } from './profile.js';
export {
  ClientVault,
  BrowserVault,
  VaultSession,
} from './vault.js';
export {
  CekiBrowserError,
  AuthError,
  SessionNotFound,
  SessionExpired,
  NotOwner,
  TransportError,
  TimeoutError,
  SessionEnded,
  InsufficientFunds,
  RateLimitExceeded,
  ConnectionLost,
  ProviderOffline,
  ProviderDisconnected,
  CdpUnrecoverable,
  ChatSendFailed,
  CaptchaError,
  CaptchaTimeoutError,
} from './errors.js';
export type {
  ConnectOptions,
  BrowserOption,
  Match,
  ChatMessage,
  ReadReceipt,
  Snapshot,
  Profile,
  VaultEnvelope,
  RentOptions,
  ScreenshotOptions,
  ScreencastOptions,
  ScrollOptions,
  ChatHistoryOptions,
  CaptchaOptions,
  CaptchaResult,
  SessionInfo,
} from './types.js';
export { WebRTCTransport, CaptureChunkReassembler } from './webrtc-browser.js';
export type { WebRTCConfig, RTCIceServer } from './webrtc-browser.js';

/**
 * Options for driving the user circuit: the session is created server-side via
 * POST /api/sessions (as the logged-in user), which returns a renter token and
 * a /ws/user URL. Pass those here — no agent apiKey needed.
 */
export interface UserSessionConnectOptions extends ConnectOptions {
  /** Bearer token returned by POST /api/sessions (`renter_token`). */
  renterToken: string;
  /** ws_url returned by POST /api/sessions — normally wss://…/ws/user. */
  relayUrl: string;
}

/**
 * Connect a Client to the USER circuit (`/ws/user`-style signaling), using a
 * server-created session's renter token instead of an agent apiKey.
 *
 * The relay matches the existing session when the client sends `rent`, so a
 * pre-created session (POST /api/sessions) is resumed/attached by this client.
 */
export async function connectAsUserSession(opts: UserSessionConnectOptions): Promise<Client> {
  const { renterToken, relayUrl, ...rest } = opts;
  return Client.create(renterToken, { ...rest, relayUrl });
}