const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL = 'https://leaderboards.arcaneodyssey.dev/guilds';
const OUT = path.join(__dirname, 'data.json');

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  console.log(`Fetching ${URL}...`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
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

  // Load existing data.json
  let existing = { snapshots: [] };
  if (fs.existsSync(OUT)) {
    try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  }

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const fiveMinutes = 5 * 60 * 1000;

  const existing_snaps = existing.snapshots || [];

  // Split into recent (last 7 days, keep all hourly) and older (keep one per day)
  const recentSnaps = existing_snaps.filter(s => s.ts >= sevenDaysAgo);
  const olderSnaps  = existing_snaps.filter(s => s.ts <  sevenDaysAgo);

  // Dedupe older snapshots to one per day (keep latest of each day)
  const olderByDay = {};
  for (const s of olderSnaps) {
    const dk = dayKey(s.ts);
    if (!olderByDay[dk] || s.ts > olderByDay[dk].ts) olderByDay[dk] = s;
  }
  const dedupedOlder = Object.values(olderByDay).sort((a, b) => a.ts - b.ts);

  // Only drop the last recent snapshot if it was taken within the last hour (true duplicate run)
  const lastSnap = recentSnaps[recentSnaps.length - 1];
  const recentWithoutLast = (lastSnap && now - lastSnap.ts < fiveMinutes)
    ? recentSnaps.slice(0, -1)
    : recentSnaps;

  const snapshots = [...dedupedOlder, ...recentWithoutLast, { ts: now, guilds }];

  fs.writeFileSync(OUT, JSON.stringify({ snapshots }, null, 2));
  console.log(`Wrote ${guilds.length} guilds. Total snapshots: ${snapshots.length} (${dedupedOlder.length} daily + ${recentWithoutLast.length + 1} recent)`);
})();
