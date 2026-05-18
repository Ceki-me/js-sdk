export class CekiBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CekiBrowserError';
  }
}

export class AuthError extends CekiBrowserError {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthError';
  }
}

export class SessionNotFound extends CekiBrowserError {
  constructor(message = 'Session not found') {
    super(message);
    this.name = 'SessionNotFound';
  }
}

export class SessionExpired extends SessionNotFound {
  constructor(message = 'Session expired') {
    super(message);
    this.name = 'SessionExpired';
  }
}

export class NotOwner extends CekiBrowserError {
  constructor(message = 'Not session owner') {
    super(message);
    this.name = 'NotOwner';
  }
}

export class TransportError extends CekiBrowserError {
  constructor(message = 'Transport error') {
    super(message);
    this.name = 'TransportError';
  }
}

export class TimeoutError extends CekiBrowserError {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class SessionEnded extends CekiBrowserError {
  reason: string;
  constructor(reason: string) {
    super(`Session ended: ${reason}`);
    this.name = 'SessionEnded';
    this.reason = reason;
  }
}

export class InsufficientFunds extends CekiBrowserError {
  constructor(message = 'Insufficient funds') {
    super(message);
    this.name = 'InsufficientFunds';
  }
}

export class RateLimitExceeded extends CekiBrowserError {
  retryAfter: number;
  constructor(retryAfter = 0, message = 'Rate limit exceeded') {
    super(message);
    this.name = 'RateLimitExceeded';
    this.retryAfter = retryAfter;
  }
}

export class ConnectionLost extends CekiBrowserError {
  constructor(message = 'Connection lost') {
    super(message);
    this.name = 'ConnectionLost';
  }
}

export class ProviderOffline extends CekiBrowserError {
  constructor(message = 'Provider offline') {
    super(message);
    this.name = 'ProviderOffline';
  }
}

export class ProviderDisconnected extends CekiBrowserError {
  constructor(message = 'Provider disconnected') {
    super(message);
    this.name = 'ProviderDisconnected';
  }
}

export class CdpUnrecoverable extends CekiBrowserError {
  lastError: string;
  constructor(lastError: string) {
    super(`CDP unrecoverable: ${lastError}`);
    this.name = 'CdpUnrecoverable';
    this.lastError = lastError;
  }
}

export class CaptchaError extends CekiBrowserError {
  constructor(message = 'Captcha error') {
    super(message);
    this.name = 'CaptchaError';
  }
}

export class CaptchaTimeoutError extends CaptchaError {
  phase: 'acceptance' | 'completion';
  constructor(phase: 'acceptance' | 'completion') {
    super(`Captcha timeout: ${phase}`);
    this.name = 'CaptchaTimeoutError';
    this.phase = phase;
  }
}

export class ChatSendFailed extends CekiBrowserError {
  status: number;
  messageText: string;
  constructor(status: number, messageText: string) {
    super(`Chat send failed (${status})`);
    this.name = 'ChatSendFailed';
    this.status = status;
    this.messageText = messageText;
  }
}
