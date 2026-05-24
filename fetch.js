const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL = 'https://leaderboards.arcaneodyssey.dev/guilds';
const OUT = path.join(__dirname, 'data.json');

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  console.log(`Fetching ${URL}...`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for guild entries to appear in the DOM
  await page.waitForSelector('h2, [class*="guild"], [class*="rank"]', { timeout: 15000 }).catch(() => {});

  const guilds = await page.evaluate(() => {
    const results = [];
    const text = document.body.innerText;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    let i = 0;
    while (i < lines.length) {
      const rankMatch = lines[i].match(/^#(\d+)$/);
      if (rankMatch) {
        const rank = parseInt(rankMatch[1]);
        const abbr = lines[i + 1] || '';
        const name = lines[i + 2] || '';
        const repStr = (lines[i + 3] || '').replace(/,/g, '');
        const repMatch = repStr.match(/^(\d+)$/);
        if (name && repMatch && abbr.length <= 8 && rank <= 200) {
          results.push({ rank, abbr, name, rep: parseInt(repMatch[1]) });
          i += 5;
          continue;
        }
      }
      i++;
    }
    return results;
  });

  await browser.close();

  if (!guilds.length) {
    console.error('No guilds found — page may not have rendered correctly.');
    process.exit(1);
  }

  // Load existing data.json to append to history
  let existing = { snapshots: [] };
  if (fs.existsSync(OUT)) {
    try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  }

  // Keep last 168 snapshots (1 week of hourly)
  const snapshots = (existing.snapshots || []).slice(-167);
  snapshots.push({ ts: Date.now(), guilds });

  fs.writeFileSync(OUT, JSON.stringify({ snapshots }, null, 2));
  console.log(`✓ Wrote ${guilds.length} guilds to data.json (${snapshots.length} snapshots total)`);
})();
