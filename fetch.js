const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URLS = {
  guilds: 'https://leaderboards.arcaneodyssey.dev/guilds',
  clans:  'https://leaderboards.arcaneodyssey.dev/clans',
  ranked: 'https://leaderboards.arcaneodyssey.dev/ranked',
};
const OUT = path.join(__dirname, 'data.json');

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function mergeSnapshots(existing, newEntry) {
  const now = newEntry.ts;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const fiveMinutes = 5 * 60 * 1000;

  const recentSnaps = existing.filter(s => s.ts >= sevenDaysAgo);
  const olderSnaps  = existing.filter(s => s.ts <  sevenDaysAgo);

  const olderByDay = {};
  for (const s of olderSnaps) {
    const dk = dayKey(s.ts);
    if (!olderByDay[dk] || s.ts > olderByDay[dk].ts) olderByDay[dk] = s;
  }
  const dedupedOlder = Object.values(olderByDay).sort((a, b) => a.ts - b.ts);

  const lastSnap = recentSnaps[recentSnaps.length - 1];
  const recentWithoutLast = (lastSnap && now - lastSnap.ts < fiveMinutes)
    ? recentSnaps.slice(0, -1)
    : recentSnaps;

  return [...dedupedOlder, ...recentWithoutLast, newEntry];
}

async function scrapeGuildOrClan(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('h2, [class*="guild"], [class*="clan"], [class*="rank"]', { timeout: 15000 }).catch(() => {});
  return page.evaluate(() => {
    const results = [];
    const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
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
          i += 5; continue;
        }
      }
      i++;
    }
    return results;
  });
}

async function scrapeRanked(page) {
  await page.goto(URLS.ranked, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('h2, [class*="player"], [class*="rank"], [class*="user"]', { timeout: 15000 }).catch(() => {});
  return page.evaluate(() => {
    const results = [];
    const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
    let i = 0;
    while (i < lines.length) {
      const rankMatch = lines[i].match(/^#(\d+)$/);
      if (rankMatch) {
        const rank = parseInt(rankMatch[1]);
        const name = lines[i + 1] || '';
        const scoreStr = (lines[i + 2] || '').replace(/,/g, '');
        const scoreMatch = scoreStr.match(/^(\d+)$/);
        if (name && scoreMatch && rank <= 500) {
          results.push({ rank, name, rep: parseInt(scoreMatch[1]) });
          i += 4; continue;
        }
      }
      i++;
    }
    return results;
  });
}

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  // Scrape all three
  console.log('Scraping guilds...');
  const guilds = await scrapeGuildOrClan(page, URLS.guilds);
  console.log(`  ${guilds.length} guilds`);

  console.log('Scraping clans...');
  const clans = await scrapeGuildOrClan(page, URLS.clans);
  console.log(`  ${clans.length} clans`);

  console.log('Scraping ranked...');
  const ranked = await scrapeRanked(page);
  console.log(`  ${ranked.length} ranked players`);

  await browser.close();

  if (!guilds.length && !clans.length && !ranked.length) {
    console.error('No data scraped from any page.');
    process.exit(1);
  }

  // Load existing data
  let existing = { guilds: [], clans: [], ranked: [] };
  if (fs.existsSync(OUT)) {
    try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  }

  const now = Date.now();

  if (guilds.length) {
    existing.guilds = mergeSnapshots(existing.guilds || [], { ts: now, guilds });
    console.log(`Guilds: ${existing.guilds.length} snapshots`);
  }
  if (clans.length) {
    existing.clans = mergeSnapshots(existing.clans || [], { ts: now, guilds: clans });
    console.log(`Clans: ${existing.clans.length} snapshots`);
  }
  if (ranked.length) {
    existing.ranked = mergeSnapshots(existing.ranked || [], { ts: now, guilds: ranked });
    console.log(`Ranked: ${existing.ranked.length} snapshots`);
  }

  fs.writeFileSync(OUT, JSON.stringify(existing, null, 2));
  console.log('Done.');
})();
