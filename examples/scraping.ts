import { Browser } from 'ceki-browser';

const br = new Browser({ token: 'YOUR_TOKEN' });
await br.connect();

const s = await br.openSession({ mode: 'incognito' });
await s.navigate('https://news.ycombinator.com');

const items = await s.queryAll('a.titlelink', ['textContent', 'href'], 10);
for (const el of items.elements) {
  console.log(`${el.textContent} — ${el.href}`);
}

const html = await s.getHtml('body', false);
console.log(`Body HTML length: ${html.html.length}`);

await s.close();
await br.close();
