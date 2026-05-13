import type { Browser } from './browser.js';
import type { Profile, ProfileExportOptions } from './types.js';

export class BrowserProfile {
  private _browser: Browser;

  constructor(browser: Browser) {
    this._browser = browser;
  }

  async export(opts?: ProfileExportOptions): Promise<Profile> {
    // 1. Try fingerprint (graceful fail)
    let fingerprint: Record<string, unknown> | null = null;
    try {
      const fpResult = await this._browser.send({ method: 'Browser.getFingerprint' });
      fingerprint = (fpResult as Record<string, unknown>) ?? null;
    } catch {
      fingerprint = null;
    }

    // 2. Get cookies
    let cookies: Record<string, unknown>[] = [];
    try {
      const cookieResult = await this._browser.send({ method: 'Network.getCookies' }) as Record<string, unknown>;
      const allCookies = (cookieResult?.cookies ?? []) as Record<string, unknown>[];

      if (opts?.domains && opts.domains.length > 0) {
        const domainSet = new Set(opts.domains.map(d => d.toLowerCase()));
        cookies = allCookies.filter(c => {
          const cookieDomain = String(c.domain ?? '').toLowerCase().replace(/^\./, '');
          return domainSet.has(cookieDomain) || opts!.domains!.some(d =>
            cookieDomain.endsWith('.' + d.toLowerCase()) || cookieDomain === d.toLowerCase()
          );
        });
      } else {
        cookies = allCookies;
      }
    } catch {
      cookies = [];
    }

    // 3. Get localStorage
    let localStorage: Record<string, string> = {};
    try {
      const lsResult = await this._browser.send({
        method: 'Runtime.evaluate',
        params: { expression: 'JSON.stringify(localStorage)', returnByValue: true },
      }) as Record<string, unknown>;
      const resultObj = lsResult?.result as Record<string, unknown> | undefined;
      if (resultObj?.value) {
        localStorage = JSON.parse(String(resultObj.value)) as Record<string, string>;
      }
    } catch {
      localStorage = {};
    }

    // 4. Get sessionStorage
    let sessionStorage: Record<string, string> = {};
    if (opts?.includeSessionStorage !== false) {
      try {
        const ssResult = await this._browser.send({
          method: 'Runtime.evaluate',
          params: { expression: 'JSON.stringify(sessionStorage)', returnByValue: true },
        }) as Record<string, unknown>;
        const resultObj = ssResult?.result as Record<string, unknown> | undefined;
        if (resultObj?.value) {
          sessionStorage = JSON.parse(String(resultObj.value)) as Record<string, string>;
        }
      } catch {
        sessionStorage = {};
      }
    }

    // 5. Get origin
    let origin = '';
    try {
      const originResult = await this._browser.send({
        method: 'Runtime.evaluate',
        params: { expression: 'location.origin', returnByValue: true },
      }) as Record<string, unknown>;
      const resultObj = originResult?.result as Record<string, unknown> | undefined;
      if (resultObj?.value) {
        origin = String(resultObj.value);
      }
    } catch {
      origin = '';
    }

    return {
      schema_version: 2,
      fingerprint,
      origin,
      cookies,
      localStorage,
      sessionStorage,
    };
  }

  async import(profile: Profile): Promise<void> {
    if (profile.schema_version !== 1 && profile.schema_version !== 2) {
      throw new Error(`Unsupported profile schema_version: ${profile.schema_version}`);
    }

    // Set cookies
    if (profile.cookies && profile.cookies.length > 0) {
      await this._browser.send({
        method: 'Network.setCookies',
        params: { cookies: profile.cookies },
      });
    }

    // Inject localStorage
    if (profile.localStorage && Object.keys(profile.localStorage).length > 0) {
      const entries = JSON.stringify(profile.localStorage);
      await this._browser.send({
        method: 'Runtime.evaluate',
        params: {
          expression: `(function(){var d=${entries};for(var k in d)localStorage.setItem(k,d[k])})()`,
          returnByValue: true,
        },
      });
    }

    // Inject sessionStorage
    if (profile.sessionStorage && Object.keys(profile.sessionStorage).length > 0) {
      const entries = JSON.stringify(profile.sessionStorage);
      await this._browser.send({
        method: 'Runtime.evaluate',
        params: {
          expression: `(function(){var d=${entries};for(var k in d)sessionStorage.setItem(k,d[k])})()`,
          returnByValue: true,
        },
      });
    }
  }
}
