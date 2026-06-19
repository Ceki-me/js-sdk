// Smoke: browser.scroll({ deltaY }) moves window.scrollY.
const { evalInPage } = require('../lib/dom');

module.exports = {
  name: 'scroll-changes-scrolltop',
  category: 'smoke',
  async run({ browser, fixtureUrl, mode }) {
    await browser.navigate(`${fixtureUrl}/form.html?case=scroll-${mode}`, 30000);
    await new Promise(r => setTimeout(r, 600));
    await evalInPage(browser, 'window.scrollTo(0,0); 1');
    const before = await evalInPage(browser, 'window.scrollY|0');
    await browser.scroll({ x: 400, y: 300, deltaY: 800 });
    await new Promise(r => setTimeout(r, 800));
    const after = await evalInPage(browser, 'window.scrollY|0');
    if (after <= before) {
      return { status: 'FAIL', detail: `scrollY before=${before} after=${after}` };
    }
    return { status: 'PASS', detail: `mode=${mode} scrollY ${before} → ${after}` };
  },
};
