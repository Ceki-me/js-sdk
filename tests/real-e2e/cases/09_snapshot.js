// Smoke: browser.snapshot() returns { screenshot, chat, ... } and a
// non-empty PNG. We don't assert chat shape because the fixture has no
// agent chat traffic — just that the call resolves.
module.exports = {
  name: 'snapshot-returns-shape',
  category: 'smoke',
  async run({ browser, fixtureUrl, mode }) {
    await browser.navigate(`${fixtureUrl}/form.html?case=snap-${mode}`, 30000);
    await new Promise(r => setTimeout(r, 700));
    const snap = await browser.snapshot();
    if (!snap || typeof snap !== 'object') {
      return { status: 'FAIL', detail: `snapshot not object: ${typeof snap}` };
    }
    const shot = snap.screenshot;
    let bytes = 0;
    if (Buffer.isBuffer(shot)) bytes = shot.length;
    else if (shot && typeof shot === 'object' && typeof shot.data === 'string') bytes = Buffer.from(shot.data, 'base64').length;
    else if (typeof shot === 'string') bytes = Buffer.from(shot, 'base64').length;
    if (bytes < 2000) {
      return { status: 'FAIL', detail: `snapshot.screenshot too small bytes=${bytes}` };
    }
    return { status: 'PASS', detail: `mode=${mode} screenshot_bytes=${bytes} keys=${Object.keys(snap).join(',')}` };
  },
};
