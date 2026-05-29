import * as fs from 'node:fs';
import { connect } from 'ceki-browser';

const client = await connect(process.env.CEKI_API_KEY!);
const browser = await client.rent(parseInt(process.env.BROWSER_ID!));

await browser.navigate('https://example.com/login');
await browser.click(400, 300);
await browser.type('user@example.com');
await browser.click(400, 360);
await browser.type('password123');
await browser.click(400, 420);

const snap = await browser.snapshot();
fs.writeFileSync('/tmp/after-login.png', Buffer.from(snap.screenshot, 'base64'));
console.log('Screenshot saved, chat:', snap.chat.length, 'messages');

if (snap.chat.some(m => m.text?.includes('2FA'))) {
  await browser.chat.send('Please enter the 2FA code');
  const reply = await new Promise<string>((resolve) => {
    browser.chat.onMessage(msg => {
      if (msg.text) resolve(msg.text);
    });
  });
  console.log('Provider replied:', reply);
}

const profile = await browser.profile.export({ domains: ['example.com'] });
fs.writeFileSync('/tmp/login-profile.json', JSON.stringify(profile, null, 2));

await browser.close();
await client.close();
