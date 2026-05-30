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
 * Try to extract a leaderboard array from an arbitrary JSON response.
 * Returns the array if it looks like leaderboard data, otherwise null.
 */
function extractLeaderboardArray(json) {
  // Direct array
  if (Array.isArray(json) && json.length >= 5) {
    const first = json[0];
    if (first && typeof first === 'object' && ('username' in first || 'name' in first || 'rank' in first)) {
      return json;
    }
  }
  // Wrapped: { data: [...] } or { players: [...] } or { entries: [...] } etc.
  if (json && typeof json === 'object') {
    for (const key of ['data', 'players', 'entries', 'results', 'leaderboard', 'users']) {
      if (Array.isArray(json[key]) && json[key].length >= 5) {
        const first = json[key][0];
        if (first && typeof first === 'object' && ('username' in first || 'name' in first || 'rank' in first)) {
          return json[key];
        }
      }
    }
  }
  return null;
}

/**
 * Map a raw API leaderboard entry to our storage shape.
 */
function mapPlayerEntry(item, idx) {
  return {
    rank:     item.rank     ?? idx + 1,
    name:     item.username ?? item.name ?? item.displayName ?? '',
    saveFile: item.saveFile ?? item.save_file ?? item.saveSlot ?? null,
    rep:      item.renown   ?? item.bounty   ?? item.reputation
           ?? item.navyRep  ?? item.syndicateRep
           ?? item.rep      ?? item.score    ?? item.value ?? 0,
  };
}

/**
 * Parse plain-text lines (from innerText or stripped HTML) using the
 * "Save File:" anchor. Used as a last-resort fallback.
 */
function parsePlayerBoardText(lines, maxRank = 500) {
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const rankMatch = lines[i].match(/^#(\d+)$/);
    if (!rankMatch) continue;
    const rank = parseInt(rankMatch[1]);
    if (rank > maxRank) continue;
    let sfIdx = -1;
    for (let j = i + 1; j < Math.min(i + 11, lines.length); j++) {
      if (/^Save File:/i.test(lines[j])) { sfIdx = j; break; }
    }
    if (sfIdx === -1) continue;
    let name = lines[sfIdx - 1] || '';
    if (/^\d+$/.test(name)) name = lines[sfIdx - 2] || '';
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
    i = sfIdx + 2;
  }
  return results;
}

// ── Scrapers ──────────────────────────────────────────────

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

/**
 * Scrape a player leaderboard using a three-tier strategy:
 *
 * 1. Intercept JSON API responses fired during page load — most reliable
 *    since we get the raw data before any rendering.
 * 2. Read window.__NEXT_DATA__ embedded in the page — works for Next.js SSR.
 * 3. Fall back to innerText parsing — only gets visible DOM rows due to
 *    virtual scrolling, but better than nothing.
 */
async function scrapePlayerBoard(page, url, maxRank = 500) {
  // ── Tier 1: intercept JSON API responses ──────────────
  const captured = [];
  const responseHandler = async (response) => {
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      if (response.status() !== 200) return;
      const json = await response.json();
      const arr  = extractLeaderboardArray(json);
      if (arr) captured.push({ url: response.url(), arr });
    } catch(e) {}
  };

  page.on('response', responseHandler);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  page.off('response', responseHandler);

  if (captured.length) {
    // Prefer the largest array found (most complete leaderboard)
    const best = captured.reduce((a, b) => b.arr.length > a.arr.length ? b : a);
    console.log(`  [API] ${best.arr.length} entries from ${best.url}`);
    return best.arr
      .filter(item => (item.rank ?? 0) <= maxRank)
      .map(mapPlayerEntry);
  }

  // ── Tier 2: __NEXT_DATA__ ─────────────────────────────
  const nextDataStr = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent : null;
  });

  if (nextDataStr) {
    try {
      const nextData  = JSON.parse(nextDataStr);
      const pageProps = nextData?.props?.pageProps ?? {};
      for (const val of Object.values(pageProps)) {
        const arr = extractLeaderboardArray(val);
        if (arr) {
          console.log(`  [__NEXT_DATA__] ${arr.length} entries`);
          return arr
            .filter(item => (item.rank ?? 0) <= maxRank)
            .map(mapPlayerEntry);
        }
      }
    } catch(e) {}
  }

  // ── Tier 3: innerText fallback ────────────────────────
  console.log('  [fallback] using innerText (may be incomplete due to virtual scroll)');
  const lines = await page.evaluate(() =>
    document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean)
  );
  return parsePlayerBoardText(lines, maxRank);
}

// ── Main ──────────────────────────────────────────────────

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

  console.log('Scraping guilds...');
  const guilds = await scrapeGuildOrClan(page, URLS.guilds);
  console.log(`  ${guilds.length} guilds`);

  console.log('Scraping clans...');
  const clans = await scrapeGuildOrClan(page, URLS.clans);
  console.log(`  ${clans.length} clans`);

  console.log('Scraping ranked...');
  const ranked = await scrapeRanked(page);
  console.log(`  ${ranked.length} ranked players`);

  console.log('Scraping fame...');
  const fame = await scrapePlayerBoard(page, URLS.fame);
  console.log(`  ${fame.length} fame entries`);

  console.log('Scraping bounty...');
  const bounty = await scrapePlayerBoard(page, URLS.bounty);
  console.log(`  ${bounty.length} bounty entries`);

  console.log('Scraping grand-navy...');
  const grandNavy = await scrapePlayerBoard(page, URLS.grandNavy);
  console.log(`  ${grandNavy.length} grand-navy entries`);

  console.log('Scraping assassin-syndicate...');
  const assassinSyndicate = await scrapePlayerBoard(page, URLS.assassinSyndicate);
  console.log(`  ${assassinSyndicate.length} assassin-syndicate entries`);

  await browser.close();

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
