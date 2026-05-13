import type { ConnectOptions } from './types.js';

export const defaults = {
  apiUrl: 'https://api.ceki.me',
  relayUrl: 'wss://browser.ceki.me/ws/agent',
  chatUrl: 'https://chat.ceki.me/api/chat',
};

export function resolveConfig(opts?: Partial<ConnectOptions>) {
  return {
    apiUrl: opts?.apiUrl ?? process.env.CEKI_API_URL ?? defaults.apiUrl,
    relayUrl: opts?.relayUrl ?? process.env.CEKI_RELAY_URL ?? defaults.relayUrl,
    chatUrl: opts?.chatUrl ?? process.env.CEKI_CHAT_URL ?? defaults.chatUrl,
    basicAuth: opts?.basicAuth ?? (process.env.CEKI_BASIC_AUTH_USER && process.env.CEKI_BASIC_AUTH_PASS
      ? [process.env.CEKI_BASIC_AUTH_USER, process.env.CEKI_BASIC_AUTH_PASS] as [string, string]
      : undefined),
    reconnect: opts?.reconnect ?? true,
  };
}
