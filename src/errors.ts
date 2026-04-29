export class CekiBrowserError extends Error {
  code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.name = 'CekiBrowserError';
    this.code = code;
  }
}

export class AuthError extends CekiBrowserError {
  constructor(message: string, code = 401) {
    super(message, code);
    this.name = 'AuthError';
  }
}

export class ProviderDisconnected extends CekiBrowserError {
  constructor(message: string, code = -1010) {
    super(message, code);
    this.name = 'ProviderDisconnected';
  }
}

export class NavigationTimeout extends CekiBrowserError {
  constructor(message: string, code = -1020) {
    super(message, code);
    this.name = 'NavigationTimeout';
  }
}

export class CommandTimeout extends CekiBrowserError {
  constructor(message: string, code = -1020) {
    super(message, code);
    this.name = 'CommandTimeout';
  }
}

export class RateLimited extends CekiBrowserError {
  constructor(message: string, code = -1013) {
    super(message, code);
    this.name = 'RateLimited';
  }
}

export class ProviderNotVerified extends CekiBrowserError {
  constructor(message: string, code = -1014) {
    super(message, code);
    this.name = 'ProviderNotVerified';
  }
}

export class HumanActionDeclined extends CekiBrowserError {
  constructor(message: string, code = -1030) {
    super(message, code);
    this.name = 'HumanActionDeclined';
  }
}

export class HumanActionTimeout extends CekiBrowserError {
  constructor(message: string, code = -1031) {
    super(message, code);
    this.name = 'HumanActionTimeout';
  }
}

export class NoMatchError extends CekiBrowserError {
  constructor(message: string, code = 0) {
    super(message, code);
    this.name = 'NoMatchError';
  }
}

export class SessionEndedError extends CekiBrowserError {
  constructor(message: string, code = 0) {
    super(message, code);
    this.name = 'SessionEndedError';
  }
}

export const ERROR_CODE_MAP: Record<number, new (msg: string, code: number) => CekiBrowserError> = {
  [-1010]: ProviderDisconnected,
  [-1013]: RateLimited,
  [-1014]: ProviderNotVerified,
};
