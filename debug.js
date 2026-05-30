const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  const jsonResponses = [];
  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') && res.status() === 200) {
      try {
        const json = await res.json();
        jsonResponses.push({ url: res.url(), keys: Object.keys(json).slice(0, 10), len: Array.isArray(json) ? json.length : '(object)' });
      } catch(e) {}
    }
  });

  await page.goto('https://leaderboards.arcaneodyssey.dev/fame', { waitUntil: 'networkidle2', timeout: 30000 });

  console.log('\n=== JSON API responses ===');
  for (const r of jsonResponses) console.log(r.url, '|', r.len, '|', r.keys);

  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent.slice(0, 500) : 'NOT FOUND';
  });
  console.log('\n=== __NEXT_DATA__ (first 500 chars) ===\n', nextData);

  const lines = await page.evaluate(() =>
    document.body.innerText.split('\n').map(l=>l.trim()).filter(Boolean).slice(0, 40)
  );
  console.log('\n=== First 40 innerText lines ===\n', JSON.stringify(lines, null, 2));

  await browser.close();
})();
