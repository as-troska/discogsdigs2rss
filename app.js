const express = require('express');
const cheerio = require('cheerio');
const initSqlJs = require('sql.js');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const testData = require('./test-data');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, process.env.DATA_DIR || '.', 'digs.db');
const USE_TEST_DATA = process.env.USE_TEST_DATA === 'true';

let db;

// Initialize SQLite database
async function initDatabase() {
  const SQL = await initSqlJs();
  
  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  // Create table for storing digs (articles about music)
  db.run(`
    CREATE TABLE IF NOT EXISTS digs (
      link TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      pubDate TEXT,
      imageUrl TEXT,
      author TEXT,
      content TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrate older databases that lack the content column
  const cols = db.exec('PRAGMA table_info(digs)')[0].values.map(r => r[1]);
  if (!cols.includes('content')) db.run('ALTER TABLE digs ADD COLUMN content TEXT');

  // Key/value store for status info (last check etc.)
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  
  saveDatabase();
}

function getMeta(key) {
  const stmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  stmt.bind([key]);
  const value = stmt.step() ? stmt.getAsObject().value : null;
  stmt.free();
  return value;
}

function setMeta(key, value) {
  db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

// Record the outcome of a fetch attempt
function recordCheck(status, details) {
  setMeta('lastCheck', new Date().toISOString());
  setMeta('lastCheckStatus', status);
  setMeta('lastCheckDetails', details);
  if (status === 'ok') setMeta('lastSuccess', new Date().toISOString());
  saveDatabase();
}

function checkStatusHtml() {
  const status = getMeta('lastCheckStatus');
  const icon = status === 'ok' ? '✅' : status === 'error' ? '❌' : '';
  const details = escapeXml(getMeta('lastCheckDetails') || '');
  return `${formatTimestamp(getMeta('lastCheck'))} ${icon} ${details}`.trim();
}

// Save database to disk
function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Insert or update an article. Data from the WordPress API is authoritative,
// so existing rows get their fields refreshed (fixes old rows with bad dates).
function upsertDig({ link, title, description, pubDate, imageUrl, author, content }) {
  try {
    db.run(
      `INSERT INTO digs (link, title, description, pubDate, imageUrl, author, content)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(link) DO UPDATE SET
         title = excluded.title,
         description = COALESCE(NULLIF(excluded.description, ''), digs.description),
         pubDate = COALESCE(excluded.pubDate, digs.pubDate),
         imageUrl = COALESCE(NULLIF(excluded.imageUrl, ''), digs.imageUrl),
         author = COALESCE(NULLIF(excluded.author, ''), digs.author),
         content = COALESCE(NULLIF(excluded.content, ''), digs.content)`,
      [link, title, description || '', pubDate || new Date().toISOString(), imageUrl || '', author || 'Discogs', content || '']
    );
  } catch (error) {
    console.log('Error with article:', link, error.message);
  }
}

const DISPLAY_TZ = process.env.DISPLAY_TZ || process.env.TZ || 'Europe/Oslo';

// SQLite CURRENT_TIMESTAMP is stored as UTC without a zone marker ("YYYY-MM-DD HH:MM:SS")
function formatTimestamp(value) {
  if (!value) return 'Never';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const date = new Date(iso);
  if (isNaN(date)) return String(value);
  return date.toLocaleString('nb-NO', { timeZone: DISPLAY_TZ, dateStyle: 'short', timeStyle: 'medium' });
}

function getAllDigs() {
  const stmt = db.prepare('SELECT * FROM digs ORDER BY pubDate DESC NULLS LAST');
  const digs = [];
  while (stmt.step()) {
    digs.push(stmt.getAsObject());
  }
  stmt.free();
  return digs;
}

// Discogs Digs is WordPress. The REST API on content.discogs.com is not behind
// the Cloudflare challenge that blocks scraping www.discogs.com/digs.
const WP_API = process.env.WP_API || 'https://content.discogs.com/digs/wp-json/wp/v2';
const FETCH_PAGES = parseInt(process.env.FETCH_PAGES || '2', 10); // 50 posts per page
const USER_AGENT = 'Mozilla/5.0 (compatible; discogsdigs2rss/1.0)';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Strip tags and decode HTML entities
function htmlToText(html) {
  if (!html) return '';
  return cheerio.load(`<div>${html}</div>`)('div').first().text().replace(/\s+/g, ' ').trim();
}

function extractByline(contentHtml) {
  if (!contentHtml) return '';
  const $ = cheerio.load(contentHtml);
  const credit = $('p.author-credit, p.author-credit-2026').first().text().trim();
  return credit.replace(/^by\s+/i, '').trim();
}

// Turn the WordPress article HTML into something RSS readers render well:
// drop header bits already in the item (title, excerpt, byline), UI widgets,
// related-posts grids and inline SVG, and strip classes/inline styles.
function cleanContent(contentHtml) {
  if (!contentHtml) return '';
  const $ = cheerio.load(contentHtml, null, false);

  // Album blocks: rebuild as a compact "cover + Title – Artist (year, format)" paragraph
  $('.release-item').each((_, el) => {
    const r = $(el);
    const img = r.find('.release-block-image img').attr('src');
    const titleLink = r.find('a.release-link');
    const title = r.find('.release-block-title').text().trim();
    const artistEl = r.find('.release-block-artist');
    const artist = artistEl.text().trim();
    const artistHref = artistEl.closest('a').attr('href');
    const meta = [r.find('.release-block-year').text().trim(), r.find('.release-block-format').text().trim()]
      .filter(Boolean).join(' · ');
    let html = '<p>';
    if (img) html += `<img src="${escapeXml(img)}" alt="" width="300"><br>`;
    if (title) html += titleLink.attr('href') ? `<a href="${escapeXml(titleLink.attr('href'))}"><strong>${escapeXml(title)}</strong></a>` : `<strong>${escapeXml(title)}</strong>`;
    if (artist) html += ' – ' + (artistHref ? `<a href="${escapeXml(artistHref)}">${escapeXml(artist)}</a>` : escapeXml(artist));
    if (meta) html += `<br><small>${escapeXml(meta)}</small>`;
    html += '</p>';
    r.closest('section.wp-block-single-release').length
      ? r.closest('section.wp-block-single-release').replaceWith(html)
      : r.replaceWith(html);
  });

  $([
    'script', 'style', 'noscript', 'svg', 'button', 'form', 'template',
    'h1.wp-block-post-title', '.wp-block-post-excerpt', '.taxonomy-category',
    'p.author-credit', 'p.author-credit-2026', '.wp-block-spacer',
    '.wantlist-icon', '.release-block-cta', '.release-block-genre',
    '.ultp-post-grid-block', '.wp-block-ultimate-post-heading', '.keep-digging',
    '.keep-digging-footer', '.email-signup', '.swiper-pagination',
    '.wp-block-post-featured-image'
  ].join(',')).remove();

  // Lazy-loaded images: make sure src is set, use absolute URLs
  $('img').each((_, el) => {
    const img = $(el);
    const src = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src');
    if (!src) { img.remove(); return; }
    img.attr('src', src);
  });

  // Embedded players rarely work in readers; replace with a plain link
  $('iframe').each((_, el) => {
    const src = $(el).attr('src');
    if (src) $(el).replaceWith(`<p><a href="${escapeXml(src)}">▶ Open embedded media</a></p>`);
    else $(el).remove();
  });

  const keepAttrs = { a: ['href'], img: ['src', 'alt', 'width', 'height'] };
  $('*').each((_, el) => {
    const allowed = keepAttrs[el.tagName] || [];
    for (const name of Object.keys(el.attribs || {})) {
      if (!allowed.includes(name)) $(el).removeAttr(name);
    }
  });

  // Unwrap layout-only containers and drop empty ones
  $('div, section, figure:not(:has(img))').each((_, el) => {
    if (!$(el).text().trim() && !$(el).find('img').length) $(el).remove();
  });
  $('div, section').each((_, el) => { $(el).replaceWith($(el).contents()); });

  return $.html().replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s*\n+/g, '\n').trim();
}

function firstImage(contentHtml) {
  if (!contentHtml) return '';
  const $ = cheerio.load(contentHtml);
  return $('img').first().attr('src') || '';
}

async function fetchMediaUrls(ids) {
  const urls = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const media = await getJson(`${WP_API}/media?per_page=100&include=${chunk.join(',')}&_fields=id,source_url,media_details`);
      for (const m of media) {
        const sizes = (m.media_details && m.media_details.sizes) || {};
        const url = (sizes.large && sizes.large.source_url) ||
                    (sizes.medium_large && sizes.medium_large.source_url) ||
                    m.source_url;
        if (url) urls.set(m.id, url);
      }
    } catch (err) {
      console.log('Could not fetch media:', err.message);
    }
  }
  return urls;
}

// Fetch latest Discogs Digs articles from the WordPress REST API
async function fetchDigsData() {
  try {
    if (USE_TEST_DATA) {
      console.log('Using test data...');
      testData.forEach(upsertDig);
      recordCheck('ok', `${testData.length} test articles`);
      console.log(`Successfully loaded ${testData.length} test articles`);
      return testData.length;
    }

    console.log('Fetching latest posts from Discogs Digs API...');
    const posts = [];
    for (let page = 1; page <= FETCH_PAGES; page++) {
      const batch = await getJson(
        `${WP_API}/posts?per_page=50&page=${page}&orderby=date&order=desc` +
        '&_fields=id,date_gmt,link,title,excerpt,content,featured_media'
      );
      posts.push(...batch);
      if (batch.length < 50) break;
    }

    const mediaUrls = await fetchMediaUrls(posts.map(p => p.featured_media));
    const beforeLinks = new Set(getAllDigs().map(d => d.link));

    const digs = posts.map(p => ({
      link: p.link,
      title: htmlToText(p.title && p.title.rendered),
      description: htmlToText(p.excerpt && p.excerpt.rendered),
      pubDate: p.date_gmt ? new Date(p.date_gmt + 'Z').toISOString() : null,
      imageUrl: mediaUrls.get(p.featured_media) || firstImage(p.content && p.content.rendered),
      author: extractByline(p.content && p.content.rendered) || 'Discogs',
      content: cleanContent(p.content && p.content.rendered)
    })).filter(d => d.link && d.title);

    digs.forEach(upsertDig);

    const newOnes = digs.filter(d => !beforeLinks.has(d.link));
    recordCheck('ok', `${digs.length} fetched, ${newOnes.length} new`);
    console.log(`Fetched ${digs.length} articles from API (${newOnes.length} new)`);
    newOnes.forEach(d => console.log(`  + ${d.pubDate}  ${d.title}`));
    return digs.length;
  } catch (error) {
    console.error('Error fetching digs:', error.message);
    recordCheck('error', error.message);
    return getAllDigs().length;
  }
}

// Generate RSS feed
function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const cdata = s => `<![CDATA[${String(s || '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

function generateRSS(digs) {
  const items = digs.map(dig => {
    let content = '';
    if (dig.imageUrl) {
      content += `<img src="${escapeXml(dig.imageUrl)}" alt="${escapeXml(dig.title)}" style="max-width: 100%; height: auto;"/><br/><br/>`;
    }
    if (dig.content) {
      content += dig.content;
    } else if (dig.description) {
      content += escapeXml(dig.description);
    }

    return `
    <item>
      <title>${cdata(dig.title)}</title>
      <link>${escapeXml(dig.link)}</link>
      <guid isPermaLink="true">${escapeXml(dig.link)}</guid>
      <pubDate>${new Date(dig.pubDate).toUTCString()}</pubDate>
      ${dig.author ? `<dc:creator>${cdata(dig.author)}</dc:creator>` : ''}
      ${dig.description ? `<description>${cdata(dig.description)}</description>` : ''}
      ${content ? `<content:encoded>${cdata(content)}</content:encoded>` : ''}
      ${dig.imageUrl ? `<enclosure url="${escapeXml(dig.imageUrl)}" length="0" type="image/jpeg"/>` : ''}
    </item>
  `;
  }).join('');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Discogs Digs RSS Feed</title>
    <link>https://www.discogs.com/digs</link>
    <description>Latest articles from Discogs Digs</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${process.env.BASE_URL || 'http://localhost:' + PORT}/rss" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
}

// Routes
app.get('/rss', async (req, res) => {
  try {
    // Just serve from database, don't fetch on every request
    const digs = getAllDigs();
    
    if (digs.length === 0) {
      res.status(503).send('RSS feed temporarily unavailable - no data cached');
      return;
    }
    
    // Generate RSS feed
    const rss = generateRSS(digs);
    
    // Browsers download application/rss+xml, so serve plain XML to them;
    // feed readers (which don't ask for text/html) still get the RSS type.
    const isBrowser = (req.get('Accept') || '').includes('text/html');
    res.type(isBrowser ? 'text/xml; charset=utf-8' : 'application/rss+xml; charset=utf-8');
    res.set('Vary', 'Accept');
    res.set('Content-Disposition', 'inline');
    res.send(rss);
  } catch (error) {
    console.error('Error in /rss route:', error.message);
    res.status(500).send('Error generating RSS feed');
  }
});

// Shared HTML page wrapper with styling
function layout(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; --bg: #f5f5f7; --card: #fff; --text: #1d1d1f; --muted: #6e6e73; --border: #e3e3e8; --accent: #2563eb; --danger: #dc2626; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111113; --card: #1c1c1f; --text: #ececf0; --muted: #9a9aa3; --border: #2c2c31; --accent: #60a5fa; --danger: #f87171; } }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
    h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 .75rem; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1.5rem; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-size: .85em; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .btn { display: inline-block; padding: .5rem .9rem; border-radius: 8px; border: 1px solid var(--border); color: var(--text); text-decoration: none; font-weight: 500; }
    .btn:hover { border-color: var(--accent); color: var(--accent); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover { filter: brightness(1.1); color: #fff; }
    .btn.danger { color: var(--danger); }
    .btn.danger:hover { border-color: var(--danger); background: var(--danger); color: #fff; }
    a:not(.btn) { color: var(--accent); }
    .lead { margin: 0 0 1rem; }
    .footer { text-align: center; color: var(--muted); font-size: .9rem; }
  </style>
</head>
<body>
<main>
${content}
</main>
</body>
</html>`;
}

app.get('/', (req, res) => {
  const digs = getAllDigs();
  const lastUpdate = digs.length > 0 ? formatTimestamp(digs[0].createdAt) : 'Never';
  res.send(layout('Discogs Digs RSS', `
  <h1>🎧 Discogs Digs RSS</h1>

  <section class="card">
    <h2>Feed</h2>
    <p class="lead">Unofficial RSS feed for <a href="https://www.discogs.com/digs/">Discogs Digs</a>, with full article content.</p>
    <div class="actions">
      <a class="btn primary" href="/rss">📡 Open RSS feed</a>
    </div>
  </section>

  <section class="card">
    <h2>Status</h2>
    <dl>
      <dt>Articles in database</dt><dd><strong>${digs.length}</strong></dd>
      <dt>Last check</dt><dd>${checkStatusHtml()}</dd>
      <dt>Newest article added</dt><dd>${lastUpdate}</dd>
      <dt>Update interval</dt><dd>Every 2 hours (automatic)</dd>
    </dl>
  </section>

  <p class="footer"><a href="/admin">⚙️ Admin panel</a></p>
`));
});

// Basic auth for admin routes. Any username; password from ADMIN_PASSWORD.
// If no password is configured, admin routes are disabled.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('Admin disabled: ADMIN_PASSWORD is not set.');
  const [scheme, encoded] = (req.get('Authorization') || '').split(' ');
  const password = scheme === 'Basic' && encoded
    ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':')
    : '';
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Discogs Digs RSS admin", charset="UTF-8"');
  res.status(401).send('Authentication required');
}

app.use(['/admin', '/update', '/reset'], requireAdmin);

app.get('/update', async (req, res) => {
  try {
    console.log('Manual update requested...');
    const count = await fetchDigsData();
    res.send(`Updated! Fetched ${count} articles. <a href="/">Back</a>`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}. <a href="/">Back</a>`);
  }
});

app.get('/admin', (req, res) => {
  const digs = getAllDigs();
  const lastUpdate = digs.length > 0 ? formatTimestamp(digs[0].createdAt) : 'Never';
  
  res.send(layout('Admin – Discogs Digs RSS', `
  <h1>🎧 Discogs Digs RSS – Admin</h1>

  <section class="card">
    <h2>Status</h2>
    <dl>
      <dt>Articles in database</dt><dd><strong>${digs.length}</strong></dd>
      <dt>Last check</dt><dd>${checkStatusHtml()}</dd>
      <dt>Last successful check</dt><dd>${formatTimestamp(getMeta('lastSuccess'))}</dd>
      <dt>Newest article added</dt><dd>${lastUpdate}</dd>
      <dt>Update interval</dt><dd>Every 2 hours (automatic)</dd>
      <dt>Database file</dt><dd><code>${DB_PATH}</code></dd>
    </dl>
  </section>

  <section class="card">
    <h2>Actions</h2>
    <div class="actions">
      <a class="btn primary" href="/update">🔄 Force update now</a>
      <a class="btn" href="/rss">📡 RSS feed</a>
      <a class="btn" href="/">📰 Home</a>
      <a class="btn danger" href="/reset" onclick="return confirm('Are you SURE? This will DELETE all ${digs.length} articles and reset the database!');">🗑️ Reset database</a>
    </div>
  </section>
`));
});

app.get('/reset', async (req, res) => {
  try {
    const confirmation = req.query.confirm === 'true';
    
    if (!confirmation) {
      return res.send(`
        <h1>Reset Database - Confirmation Required</h1>
        <p style="color: red; font-weight: bold;">WARNING: This will delete ALL ${getAllDigs().length} articles!</p>
        <p><a href="/reset?confirm=true" onclick="return confirm('This action cannot be undone. Continue?');" style="padding: 10px; background: red; color: white; text-decoration: none; border-radius: 5px;">✓ Yes, Reset Everything</a></p>
        <p><a href="/admin">✗ Cancel</a></p>
      `);
    }
    
    // Drop the table and recreate it
    db.run('DROP TABLE IF EXISTS digs');
    db.run(`
      CREATE TABLE digs (
        link TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        pubDate TEXT,
        imageUrl TEXT,
        author TEXT,
        content TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    saveDatabase();
    
    console.log('Database reset at', new Date().toLocaleString());
    res.send(`
      <h1>✓ Database Reset Successfully</h1>
      <p>All articles have been deleted. The database is now empty.</p>
      <p><a href="/update">Start fetching new articles</a> or <a href="/admin">Back to admin</a></p>
    `);
  } catch (error) {
    res.status(500).send(`Error resetting database: ${error.message}. <a href="/admin">Back</a>`);
  }
});

// Update digs every 2 hours (to be respectful to Discogs)
setInterval(async () => {
  try {
    console.log('Starting scheduled update...');
    const count = await fetchDigsData();
    console.log(`Updated ${count} digs at ${new Date().toLocaleString()}`);
  } catch (error) {
    console.error('Error updating digs:', error.message);
  }
}, 2 * 60 * 60 * 1000); // 2 hours

// Start server
async function startServer() {
  await initDatabase();
  
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`RSS feed available at http://localhost:${PORT}/rss`);
    
    // Initial fetch
    fetchDigsData().then(count => {
      console.log(`Initial fetch: ${count} digs loaded`);
    }).catch(err => {
      console.error('Initial fetch failed:', err.message);
    });
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  if (db) {
    db.close();
  }
  process.exit(0);
});



