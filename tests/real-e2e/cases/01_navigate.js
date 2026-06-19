// Smoke: browser.navigate(url) lands on the expected URL.
const { evalInPage } = require('../lib/dom');

module.exports = {
  name: 'navigate-url-changed',
  category: 'smoke',
  async run({ browser, fixtureUrl, mode }) {
    const target = `${fixtureUrl}/form.html?case=nav-${mode}`;
    await browser.navigate(target, 30000);
    await new Promise(r => setTimeout(r, 600));
    const href = await evalInPage(browser, 'location.href');
    if (typeof href !== 'string' || !href.includes('case=nav-')) {
      return { status: 'FAIL', detail: `unexpected location.href=${href}` };
    }
    return { status: 'PASS', detail: `mode=${mode} href=${href}` };
  },
};
