// Real-e2e mirror of python case 29: default typing humanizer ON in BOTH
// modes. Inter-keystroke intervals have positive variance (stddev ≥ 5 ms).
const { evalInPage } = require('../lib/dom');

const TEXT = 'cadence-probe-abcdef';

module.exports = {
  name: 'type-default-jitter-both-modes',
  category: 'plugin-humanizer-typing',
  async run({ browser, fixtureUrl, mode }) {
    await browser.navigate(`${fixtureUrl}/form.html?case=cadence-${mode}`, 30000);
    await new Promise(r => setTimeout(r, 700));
    await evalInPage(browser, 'window.__qaReset && window.__qaReset(); 1');

    const r = await evalInPage(browser,
      '(function(){var e=document.getElementById("email2");var b=e.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()'
    );
    await browser.click(r.x, r.y);
    await new Promise(rs => setTimeout(rs, 200));
    await evalInPage(browser, 'window.__keyTimes = []; 1');
    await browser.type(TEXT);
    await new Promise(rs => setTimeout(rs, 600));

    const arr = await evalInPage(browser, 'window.__keyTimes || []');
    if (!Array.isArray(arr) || arr.length < TEXT.length) {
      return { status: 'FAIL', detail: `expected ≥${TEXT.length} keydowns, got ${arr ? arr.length : '?'}` };
    }
    const iv = [];
    for (let i = 1; i < arr.length; i++) iv.push(arr[i].t - arr[i - 1].t);
    const mean = iv.reduce((a, b) => a + b, 0) / (iv.length || 1);
    const stddev = Math.sqrt(iv.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (iv.length || 1));
    if (stddev < 5) {
      return { status: 'FAIL', detail: `mode=${mode} stddev=${stddev.toFixed(1)}ms <5 (no jitter)` };
    }
    return { status: 'PASS', detail: `mode=${mode} n=${iv.length} stddev=${stddev.toFixed(1)}ms` };
  },
};
