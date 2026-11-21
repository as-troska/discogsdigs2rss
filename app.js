const express = require('express');
const cheerio = require('cheerio');
const initSqlJs = require('sql.js');
const fs = require('fs');
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
  
  saveDatabase();
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
      saveDatabase();
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
    saveDatabase();

    const newOnes = digs.filter(d => !beforeLinks.has(d.link));
    console.log(`Fetched ${digs.length} articles from API (${newOnes.length} new)`);
    newOnes.forEach(d => console.log(`  + ${d.pubDate}  ${d.title}`));
    return digs.length;
  } catch (error) {
    console.error('Error fetching digs:', error.message);
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
    
    res.type('application/rss+xml; charset=utf-8');
    res.set('Content-Disposition', 'inline');
    res.send(rss);
  } catch (error) {
    console.error('Error in /rss route:', error.message);
    res.status(500).send('Error generating RSS feed');
  }
});

app.get('/', (req, res) => {
  const digs = getAllDigs();
  const lastUpdate = digs.length > 0 ? new Date(digs[0].createdAt).toLocaleString() : 'Never';
  res.send(`
    <h1>Discogs Digs RSS Feed</h1>
    <p>📡 RSS feed available at: <a href="/rss">/rss</a></p>
    <p>📰 Articles in database: <strong>${digs.length}</strong></p>
    <p>🕐 Last update: ${lastUpdate}</p>
    <p>⏰ Auto-updates every 2 hours</p>
    <hr>
    <p><a href="/admin">⚙️ Admin Panel</a> - View status, force update, reset database</p>
  `);
});

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
  const lastUpdate = digs.length > 0 ? new Date(digs[0].createdAt).toLocaleString() : 'Never';
  
  res.send(`
    <h1>Discogs Digs RSS - Admin Panel</h1>
    <h2>Database Status</h2>
    <p><strong>Articles in database:</strong> ${digs.length}</p>
    <p><strong>Last update:</strong> ${lastUpdate}</p>
    <p><strong>Database file:</strong> ${DB_PATH}</p>
    <p><strong>Update interval:</strong> Every 2 hours (automatic)</p>
    
    <h2>Actions</h2>
    <ul>
      <li><a href="/update">🔄 Force Update Now</a> (fetch latest articles)</li>
      <li><a href="/reset" onclick="return confirm('Are you SURE? This will DELETE all ${digs.length} articles and reset the database!');">🗑️ Reset Database</a> (WARNING: This deletes everything!)</li>
    </ul>
    
    <h2>Links</h2>
    <ul>
      <li><a href="/">📰 Home</a></li>
      <li><a href="/rss">📡 RSS Feed</a></li>
    </ul>
  `);
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



