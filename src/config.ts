import type { ConnectOptions } from './types.js';

export const defaults = {
  apiUrl: 'https://api.ceki.me',
  relayUrl: 'wss://browser.ceki.me/ws/agent',
  chatUrl: 'https://chat.ceki.me/api/chat',
};

// Browser-safe env accessor: `process` does not exist in the browser bundle.
function env(name: string): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env[name];
}

export function resolveConfig(opts?: Partial<ConnectOptions>) {
  const basicUser = env('CEKI_BASIC_AUTH_USER');
  const basicPass = env('CEKI_BASIC_AUTH_PASS');
  return {
    apiUrl: opts?.apiUrl ?? env('CEKI_API_URL') ?? defaults.apiUrl,
    relayUrl: opts?.relayUrl ?? env('CEKI_RELAY_URL') ?? defaults.relayUrl,
    chatUrl: opts?.chatUrl ?? env('CEKI_CHAT_URL') ?? defaults.chatUrl,
    basicAuth: opts?.basicAuth ?? (basicUser && basicPass
      ? [basicUser, basicPass] as [string, string]
      : undefined),
    reconnect: opts?.reconnect ?? true,
  };
}