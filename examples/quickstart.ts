import { connect } from 'ceki-browser';

const client = await connect(process.env.CEKI_API_KEY!);

const options = await client.search({ geo: 'US' });
console.log(`Found ${options.length} browsers`);

const browser = await client.rent(options[0].schedule_id);
console.log(`Session: ${browser.sessionId}`);

await browser.navigate('https://example.com');
const snap = await browser.snapshot();
console.log(`Screenshot: ${snap.screenshot.length} chars, ${snap.chat.length} messages`);

await browser.close();
await client.close();
