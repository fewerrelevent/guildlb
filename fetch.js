const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URLS = {
  guilds:            'https://leaderboards.arcaneodyssey.dev/guilds',
  clans:             'https://leaderboards.arcaneodyssey.dev/clans',
  ranked:            'https://leaderboards.arcaneodyssey.dev/ranked',
  fame:              'https://leaderboards.arcaneodyssey.dev/fame',
  bounty:            'https://leaderboards.arcaneodyssey.dev/bounty',
  grandNavy:         'https://leaderboards.arcaneodyssey.dev/grand-navy',
  assassinSyndicate: 'https://leaderboards.arcaneodyssey.dev/assassin-syndicate',
};
const OUT = path.join(__dirname, 'data.json');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── Helpers ───────────────────────────────────────────────

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function mergeSnapshots(existing, newEntry) {
  const now          = newEntry.ts;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const fiveMinutes  = 5 * 60 * 1000;

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

/**
 * Fetch the raw server-rendered HTML for a URL and return it as plain text.
 * Strips all HTML tags, removes script/style blocks, and decodes entities.
 * This bypasses client-side virtual scrolling entirely.
 */
async function fetchPageText(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

// ── Puppeteer scrapers (guilds/clans/ranked — no virtual scroll) ──────────

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
        const rank     = parseInt(rankMatch[1]);
        const abbr     = lines[i + 1] || '';
        const name     = lines[i + 2] || '';
        const repStr   = (lines[i + 3] || '').replace(/,/g, '');
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
        const rank       = parseInt(rankMatch[1]);
        const name       = lines[i + 2] || '';
        const scoreStr   = (lines[i + 3] || '').replace(/,/g, '');
        const scoreMatch = scoreStr.match(/^(\d+)$/);
        if (name && scoreMatch && rank <= 500) {
          results.push({ rank, name, rep: parseInt(scoreMatch[1]) });
          i += 5;
          continue;
        }
      }
      i++;
    }
    return results;
  });
}

// ── HTTP scrapers (fame/bounty/grandNavy/assassinSyndicate) ───────────────
//
// These pages use client-side virtual scrolling, so Puppeteer only sees a
// handful of rows in the DOM at any moment. Instead we fetch the raw
// server-rendered HTML (which always contains all 100 entries) and parse it
// before React has a chance to replace it with a virtual list.
//
// Entry structure in the server-rendered text (after stripping HTML tags):
//   #N
//   <avatar digit>          ← optional, skip if present
//   PlayerName
//   Save File: N            ← anchor line
//   999,999                 ← score
//   Renown / Bounty / …    ← label

async function scrapePlayerBoard(url, maxRank = 500) {
  const text  = await fetchPageText(url);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const rankMatch = lines[i].match(/^#(\d+)$/);
    if (!rankMatch) continue;

    const rank = parseInt(rankMatch[1]);
    if (rank > maxRank) continue;

    // Scan forward (up to 10 lines) for the "Save File:" anchor
    let sfIdx = -1;
    for (let j = i + 1; j < Math.min(i + 11, lines.length); j++) {
      if (/^Save File:/i.test(lines[j])) { sfIdx = j; break; }
    }
    if (sfIdx === -1) continue;

    // The line immediately before the Save File line is the player name.
    // Guard against it being a bare digit (avatar initial) — if so, step back one more.
    let nameIdx = sfIdx - 1;
    const candidateName = lines[nameIdx] || '';
    const name = /^\d+$/.test(candidateName) ? (lines[nameIdx - 1] || '') : candidateName;
    if (!name) continue;

    const saveMatch  = lines[sfIdx].match(/Save File:\s*(\d+)/i);
    const scoreStr   = (lines[sfIdx + 1] || '').replace(/,/g, '');
    const scoreMatch = scoreStr.match(/^(\d+)$/);
    if (!scoreMatch) continue;

    results.push({
      rank,
      name,
      saveFile: saveMatch ? parseInt(saveMatch[1]) : null,
      rep:      parseInt(scoreMatch[1]),
    });

    // Skip past the label line so we don't re-parse this entry
    i = sfIdx + 2;
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(FETCH_HEADERS['User-Agent']);

  // Puppeteer for the three boards that render fully in the DOM
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

  // Plain HTTP fetch for the four virtual-scroll boards
  console.log('Scraping fame...');
  const fame = await scrapePlayerBoard(URLS.fame);
  console.log(`  ${fame.length} fame entries`);

  console.log('Scraping bounty...');
  const bounty = await scrapePlayerBoard(URLS.bounty);
  console.log(`  ${bounty.length} bounty entries`);

  console.log('Scraping grand-navy...');
  const grandNavy = await scrapePlayerBoard(URLS.grandNavy);
  console.log(`  ${grandNavy.length} grand-navy entries`);

  console.log('Scraping assassin-syndicate...');
  const assassinSyndicate = await scrapePlayerBoard(URLS.assassinSyndicate);
  console.log(`  ${assassinSyndicate.length} assassin-syndicate entries`);

  const anyData = [guilds, clans, ranked, fame, bounty, grandNavy, assassinSyndicate].some(a => a.length > 0);
  if (!anyData) {
    console.error('No data scraped from any page.');
    process.exit(1);
  }

  // ── Load existing data ──────────────────────────────────
  let existing = {
    guilds: [], clans: [], ranked: [],
    fame: [], bounty: [], grandNavy: [], assassinSyndicate: [],
  };
  if (fs.existsSync(OUT)) {
    try {
      const raw = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (Array.isArray(raw.guilds)) {
        existing = { ...existing, ...raw };
      } else if (Array.isArray(raw.snapshots)) {
        existing.guilds = raw.snapshots;
      }
      console.log(
        `Loaded existing: ${existing.guilds.length} guild, ${existing.clans.length} clan, ` +
        `${existing.ranked.length} ranked, ${existing.fame.length} fame, ` +
        `${existing.bounty.length} bounty, ${existing.grandNavy.length} grandNavy, ` +
        `${existing.assassinSyndicate.length} assassinSyndicate snapshots`
      );
    } catch (e) { console.warn('Could not parse existing data.json:', e.message); }
  } else {
    console.warn('No existing data.json found — starting fresh.');
  }

  for (const k of ['guilds','clans','ranked','fame','bounty','grandNavy','assassinSyndicate']) {
    existing[k] = existing[k] || [];
  }

  const now = Date.now();

  if (guilds.length) {
    existing.guilds = mergeSnapshots(existing.guilds, { ts: now, guilds });
    console.log(`Guilds: ${existing.guilds.length} snapshots`);
  }
  if (clans.length) {
    existing.clans = mergeSnapshots(existing.clans, { ts: now, guilds: clans });
    console.log(`Clans: ${existing.clans.length} snapshots`);
  }
  if (ranked.length) {
    existing.ranked = mergeSnapshots(existing.ranked, { ts: now, guilds: ranked });
    console.log(`Ranked: ${existing.ranked.length} snapshots`);
  }
  if (fame.length) {
    existing.fame = mergeSnapshots(existing.fame, { ts: now, guilds: fame });
    console.log(`Fame: ${existing.fame.length} snapshots`);
  }
  if (bounty.length) {
    existing.bounty = mergeSnapshots(existing.bounty, { ts: now, guilds: bounty });
    console.log(`Bounty: ${existing.bounty.length} snapshots`);
  }
  if (grandNavy.length) {
    existing.grandNavy = mergeSnapshots(existing.grandNavy, { ts: now, guilds: grandNavy });
    console.log(`Grand Navy: ${existing.grandNavy.length} snapshots`);
  }
  if (assassinSyndicate.length) {
    existing.assassinSyndicate = mergeSnapshots(existing.assassinSyndicate, { ts: now, guilds: assassinSyndicate });
    console.log(`Assassin Syndicate: ${existing.assassinSyndicate.length} snapshots`);
  }

  fs.writeFileSync(OUT, JSON.stringify(existing, null, 2));
  console.log('Done.');
})();
