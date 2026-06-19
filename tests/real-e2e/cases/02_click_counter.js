// Smoke: browser.click(x, y) on the counter button increments the on-page
// counter. Coords are the fixture's #btn-counter (≈ y=270 in form.html
// at default 1024×768 viewport).
const { evalInPage } = require('../lib/dom');

module.exports = {
  name: 'click-increments-counter',
  category: 'smoke',
  async run({ browser, fixtureUrl, mode }) {
    await browser.navigate(`${fixtureUrl}/form.html?case=click-${mode}`, 30000);
    await new Promise(r => setTimeout(r, 600));
    await evalInPage(browser, 'window.__qaReset && window.__qaReset(); 1');
    const rect = await evalInPage(browser,
      '(function(){var b=document.getElementById("btn-counter");var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()');
    if (!rect || typeof rect.x !== 'number') {
      return { status: 'FAIL', detail: `btn-counter not found: ${JSON.stringify(rect)}` };
    }
    await browser.click(rect.x, rect.y);
    await new Promise(r => setTimeout(r, 400));
    const cnt = await evalInPage(browser, 'parseInt(document.getElementById("cnt").textContent,10)');
    if (cnt !== 1) {
      return { status: 'FAIL', detail: `cnt=${cnt} (expected 1)` };
    }
    return { status: 'PASS', detail: `mode=${mode} cnt=${cnt}` };
  },
};
