import { connect } from 'ceki-browser';

const client = await connect(process.env.CEKI_API_KEY!);
const browser = await client.rent(parseInt(process.env.BROWSER_ID!));

await browser.navigate('https://news.ycombinator.com');

const result = await browser.send({
  method: 'Runtime.evaluate',
  params: {
    expression: `JSON.stringify(
      Array.from(document.querySelectorAll('.titleline a'))
        .slice(0, 10)
        .map(a => ({ title: a.textContent, href: a.href }))
    )`,
    returnByValue: true,
  },
});

const items = JSON.parse((result as any)?.result?.value ?? '[]');
console.log('Top 10 HN stories:', items);

await browser.close();
await client.close();
