export interface QueryResult {
  elements: Record<string, string | null>[];
}

export interface NavigateResult {
  url: string;
  title: string;
  status: number;
}

export interface ScreenshotResult {
  data: string;
  width: number;
  height: number;
}

export interface HtmlResult {
  html: string;
}

export interface HumanActionResult {
  status: string;
  requestId: string;
}

export interface SessionOptions {
  mode?: string;
  domainHints?: string[];
  geo?: string;
  language?: string;
  maxPricePerMin?: number;
  estimatedDurationMin?: number;
  waitTimeout?: number;
}

export interface BrowserOptions {
  token: string;
  relayUrl?: string;
}

export interface ChatMessage {
  _id: string;
  topic_id: string;
  author_id: number;
  author_name: string;
  type: 'text' | 'image' | 'file';
  content: string;
  media?: { url: string; mime: string; name: string; size?: number } | null;
  created_at: string;
}

export interface TypingEvent {
  user_id: number;
  is_typing: boolean;
}

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  method?: string;
  params?: Record<string, unknown>;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}
