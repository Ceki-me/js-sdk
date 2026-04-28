import { Browser } from 'ceki-browser';

const br = new Browser({ token: 'YOUR_TOKEN' });
await br.connect();

const s = await br.openSession({ mode: 'incognito', domainHints: ['example.com'] });
await s.navigate('https://example.com');
const title = await s.query('h1');
console.log(title.elements[0]?.textContent);

await s.close();
await br.close();
