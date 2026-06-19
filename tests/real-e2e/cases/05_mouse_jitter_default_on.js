// Real-e2e mirror of python case 28: mouse jitter default ON in BOTH
// modes — one browser.click() produces a mousemove trail (≥2 unique
// points), not just a teleport.
const { evalInPage } = require('../lib/dom');

const TARGET = [200, 180];

module.exports = {
  name: 'mouse-jitter-default-on-both-modes',
  category: 'plugin-humanizer-mouse',
  async run({ browser, fixtureUrl, mode }) {
    await browser.navigate(`${fixtureUrl}/form.html?case=jitter-${mode}`, 30000);
    await new Promise(r => setTimeout(r, 800));
    await evalInPage(browser, 'window.__qaReset && window.__qaReset(); 1');
    // Park pointer somewhere far so a trail HAS to be generated.
    await browser.click(40, 40);
    await new Promise(r => setTimeout(r, 200));
    await evalInPage(browser, 'window.__pointerLog = []; 1');
    await browser.click(TARGET[0], TARGET[1]);
    await new Promise(r => setTimeout(r, 500));

    const log = await evalInPage(browser, 'window.__pointerLog || []');
    if (!Array.isArray(log)) {
      return { status: 'FAIL', detail: `pointerLog not array: ${JSON.stringify(log)}` };
    }
    const uniq = new Set(log.map(p => p[0] + ',' + p[1]));
    if (uniq.size < 2) {
      return {
        status: 'FAIL',
        detail: `mode=${mode} mousemoves=${log.length} uniq=${uniq.size} — humanizer OFF or teleport (expected default-ON)`,
      };
    }
    return { status: 'PASS', detail: `mode=${mode} mousemoves=${log.length} uniq=${uniq.size}` };
  },
};
