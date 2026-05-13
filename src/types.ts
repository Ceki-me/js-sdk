export interface ConnectOptions {
  apiUrl?: string;
  relayUrl?: string;
  chatUrl?: string;
  basicAuth?: [string, string];
  reconnect?: boolean;
}

export interface BrowserOption {
  schedule_id: number;
  user_id?: number | null;
  geo?: string | null;
  language?: string | null;
  languages?: string[];
  domain_allowed?: string[] | null;
  skills?: string[];
  price_per_min: number;
  rating?: number | null;
  online: boolean;
  currency?: string | null;
  kal_id?: number | null;
}

export interface Match {
  session_id: string;
  schedule_id: number;
  event_id?: string | null;
  chat_topic_id?: string | null;
  provider_user_id?: number | null;
  started_at?: number;
  browser_info?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  topic_id: string;
  sender_id?: number | null;
  text?: string | null;
  media?: Record<string, unknown>[] | null;
  type: string;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
}

export interface ReadReceipt {
  topic_id: string;
  last_read_message_id: string;
  read_at: number;
}

export interface Snapshot {
  screenshot: string;
  chat: ChatMessage[];
  ts: Date;
}

export interface Profile {
  schema_version: number;
  fingerprint?: Record<string, unknown> | null;
  origin?: string;
  cookies?: Record<string, unknown>[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface RentOptions {
  human?: 'natural' | 'careful' | null;
  maskingMode?: boolean;
  fingerprint?: boolean | Record<string, unknown>;
}

export interface ScreenshotOptions {
  format?: 'base64' | 'png';
  fullPage?: boolean;
}

export interface ScrollOptions {
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
}

export interface ProfileExportOptions {
  domains?: string[];
  includeSessionStorage?: boolean;
}

export interface ChatHistoryOptions {
  limit?: number;
  beforeId?: string;
  since?: string;
}
