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

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  method?: string;
  params?: Record<string, unknown>;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}
