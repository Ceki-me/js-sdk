// Real-e2e mirror of python case 22: typing once via SDK leaves exactly
// the typed string in the input — no char-doubling caused by SDK + ext
// both processing humanizer.
const { evalInPage } = require('../lib/dom');

const TEXT = 'e2e-no-doubling-1';

module.exports = {
  name: 'type-no-doubling',
  category: 'plugin-typing',
  async run({ browser, fixtureUrl, mode }) {
    await browser.navigate(`${fixtureUrl}/form.html?case=nodbl-${mode}`, 30000);
    await new Promise(r => setTimeout(r, 600));
    await evalInPage(browser, 'window.__qaReset && window.__qaReset(); 1');

    const r = await evalInPage(browser,
      '(function(){var e=document.getElementById("email");var b=e.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()'
    );
    await browser.click(r.x, r.y);
    await new Promise(rs => setTimeout(rs, 200));
    await browser.type(TEXT);
    await new Promise(rs => setTimeout(rs, 800));

    const value = await evalInPage(browser, 'document.getElementById("email").value');
    if (value !== TEXT) {
      return { status: 'FAIL', detail: `value="${value}" expected "${TEXT}"` };
    }
    return { status: 'PASS', detail: `mode=${mode} value="${value}"` };
  },
};
