// Smoke: browser.screenshot() returns a non-empty PNG buffer (or base64).
module.exports = {
  name: 'screenshot-returns-png',
  category: 'smoke',
  async run({ browser, fixtureUrl, mode }) {
    await browser.navigate(`${fixtureUrl}/form.html?case=shot-${mode}`, 30000);
    await new Promise(r => setTimeout(r, 600));
    const shot = await browser.screenshot();
    let bytes = 0;
    if (Buffer.isBuffer(shot)) bytes = shot.length;
    else if (shot && typeof shot.data === 'string') bytes = Buffer.from(shot.data, 'base64').length;
    else return { status: 'FAIL', detail: `unexpected screenshot shape: ${JSON.stringify(shot).slice(0, 120)}` };
    if (bytes < 2000) {
      return { status: 'FAIL', detail: `screenshot too small bytes=${bytes}` };
    }
    return { status: 'PASS', detail: `mode=${mode} bytes=${bytes}` };
  },
};
