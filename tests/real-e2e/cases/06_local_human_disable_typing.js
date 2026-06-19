// Real-e2e mirror of python case 32: per-call { human: false } on type()
// flattens timing for THAT call only; the next default call jitters again.
const { evalInPage } = require('../lib/dom');

const VALUE = 'local-disable-yyyy';

async function captureType(browser, fixtureUrl, mode, raw, label) {
  await browser.navigate(`${fixtureUrl}/form.html?case=${label}-${mode}`, 30000);
  await new Promise(r => setTimeout(r, 600));
  await evalInPage(browser, 'window.__qaReset && window.__qaReset(); 1');
  const r = await evalInPage(browser,
    '(function(){var e=document.getElementById("email2");var b=e.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()'
  );
  // Use raw click to position cursor without leaking jitter into the type call.
  await browser.click(r.x, r.y, { human: false });
  await new Promise(rs => setTimeout(rs, 200));
  await evalInPage(browser, 'window.__keyTimes = []; 1');
  await browser.type(VALUE, raw ? { human: false } : undefined);
  await new Promise(rs => setTimeout(rs, 500));
  const arr = await evalInPage(browser, 'window.__keyTimes || []');
  if (!Array.isArray(arr) || arr.length < VALUE.length) {
    throw new Error(`expected ≥${VALUE.length} keydowns, got ${arr ? arr.length : '?'}`);
  }
  const iv = [];
  for (let i = 1; i < arr.length; i++) iv.push(arr[i].t - arr[i - 1].t);
  const mean = iv.reduce((a, b) => a + b, 0) / (iv.length || 1);
  const stddev = Math.sqrt(iv.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (iv.length || 1));
  return { stddev, mean, n: iv.length };
}

module.exports = {
  name: 'local-humanizer-toggle-typing',
  category: 'plugin-humanizer-flags',
  async run({ browser, fixtureUrl, mode }) {
    let off, on;
    try {
      off = await captureType(browser, fixtureUrl, mode, true,  'local-off');
      on  = await captureType(browser, fixtureUrl, mode, false, 'local-on');
    } catch (e) {
      return { status: 'FAIL', detail: e.message };
    }
    if (off.stddev >= 5) {
      return { status: 'FAIL', detail: `OFF leg ({ human: false }) jitter stddev=${off.stddev.toFixed(1)}ms — humanizer leaked into raw call` };
    }
    if (on.stddev < 5) {
      return { status: 'FAIL', detail: `ON leg (default) flat stddev=${on.stddev.toFixed(1)}ms — default humanizer is off` };
    }
    return {
      status: 'PASS',
      detail: `mode=${mode} OFF={ human: false } stddev=${off.stddev.toFixed(1)}ms ON (default) stddev=${on.stddev.toFixed(1)}ms`,
    };
  },
};
