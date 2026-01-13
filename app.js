const express = require('express');
const puppeteer = require('puppeteer');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const testData = require('./test-data');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, process.env.DATA_DIR || '.', 'digs.db');
const USE_TEST_DATA = process.env.USE_TEST_DATA === 'true';

let db;
let browser;

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
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  saveDatabase();
}

// Save database to disk
function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Helper functions for database operations
function insertDig(link, title, description, pubDate, imageUrl, author) {
  try {
    db.run(
      `INSERT OR IGNORE INTO digs (link, title, description, pubDate, imageUrl, author) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [link, title, description, pubDate || new Date().toISOString(), imageUrl, author]
    );
    saveDatabase();
  } catch (error) {
    console.log('Skipping duplicate article:', link);
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

// Fetch and parse Discogs Digs page with Puppeteer
async function fetchDigsData() {
  let page;
  try {
    // Use test data if enabled
    if (USE_TEST_DATA) {
      console.log('Using test data...');
      for (const dig of testData) {
        insertDig(
          dig.link,
          dig.title,
          dig.description,
          dig.pubDate,
          dig.imageUrl,
          dig.author
        );
      }
      console.log(`Successfully loaded ${testData.length} test articles`);
      return testData.length;
    }
    
    console.log('Fetching from Discogs with Puppeteer... (this may take a moment)');
    
    // Initialize browser if not already running
    if (!browser) {
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ]
      });
    }
    
    page = await browser.newPage();
    
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Random delay to seem more human
    const delay = 2000 + Math.random() * 3000;
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Navigate to page
    console.log('Navigating to Discogs Digs...');
    await page.goto('https://www.discogs.com/digs', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Wait a bit for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Extract articles from the page
    const result = await page.evaluate(() => {
      const articles = [];
      const skipped = [];
      
      // Collect elements from multiple selectors to avoid missing items when markup varies
      const selectors = ['article', '.card', '.dig', '.post'];
      const elements = [];
      const seenElements = new Set();
      const usedSelectors = new Set();
      
      selectors.forEach(selector => {
        const found = Array.from(document.querySelectorAll(selector));
        if (found.length > 0) {
          usedSelectors.add(selector);
        }
        found.forEach(el => {
          if (!seenElements.has(el)) {
            seenElements.add(el);
            elements.push(el);
          }
        });
      });
      
      const normalizeLink = (raw) => {
        if (!raw) return '';
        try {
          const url = new URL(raw, window.location.origin);
          url.hash = '';
          url.search = '';
          // Keep a single trailing slash for consistency
          url.pathname = url.pathname.replace(/\/+$/, '/') || '/';
          return url.toString();
        } catch {
          return raw.trim();
        }
      };

      elements.forEach((element, index) => {
        try {
          // Try to find title
          const titleEl = element.querySelector('h1, h2, h3, h4, .title, [class*="title"]');
          const title = titleEl ? titleEl.textContent.trim() : '';
          
          // Try to find link (prefer the first anchor)
          const linkEl = element.querySelector('a');
          const link = normalizeLink(linkEl ? linkEl.href : '');
          
          // Try to find image
          const imgEl = element.querySelector('img');
          const imageUrl = imgEl ? (imgEl.src || imgEl.dataset.src || '') : '';
          
          // Try to find description
          const descEl = element.querySelector('p, .description, .excerpt, [class*="description"]');
          const description = descEl ? descEl.textContent.trim() : '';
          
          // Try to find author
          const authorEl = element.querySelector('.author, .byline, [class*="author"]');
          const author = authorEl ? authorEl.textContent.trim() : 'Discogs';
          
          // Try to find published date
          const dateEl = element.querySelector('time, .date, .publish-date, [class*="date"]');
          let pubDate = null;
          if (dateEl) {
            const datetime = dateEl.getAttribute('datetime') || dateEl.textContent.trim();
            try {
              pubDate = new Date(datetime).toISOString();
            } catch {
              pubDate = null;
            }
          }
          
          if (title && link) {
            articles.push({
              title,
              link,
              description,
              imageUrl,
              author,
              pubDate
            });
          } else {
            skipped.push({
              index,
              title: title || '(no title)',
              link: link || '(no link)',
              hasTitle: !!title,
              hasLink: !!link
            });
          }
        } catch (err) {
          skipped.push({
            index,
            error: err.message
          });
        }
      });
      
      // Deduplicate by link on the client side to avoid losing articles when Discogs repeats cards
      const uniqueArticles = [];
      const seenLinks = new Set();
      const duplicateLinks = [];
      articles.forEach(a => {
        if (!seenLinks.has(a.link)) {
          seenLinks.add(a.link);
          uniqueArticles.push(a);
        } else {
          duplicateLinks.push(a);
        }
      });
      
      return {
        articles: uniqueArticles,
        skipped,
        duplicateLinks,
        totalElements: elements.length,
        usedSelectors: Array.from(usedSelectors)
      };
    });
    
    const digs = result.articles;
    
    console.log(`Found ${result.totalElements} elements using selectors ${JSON.stringify(result.usedSelectors)}`);
    console.log(`Extracted ${digs.length} unique articles, skipped ${result.skipped.length}`);
    console.log('--- Scraped articles (unique) ---');
    digs.forEach((dig, i) => {
      console.log(`  ${i + 1}. "${dig.title}"`);
      console.log(`     ${dig.link}`);
    });
    
    if (result.duplicateLinks && result.duplicateLinks.length > 0) {
      console.log(`\n🔍 Client-side deduped ${result.duplicateLinks.length} repeated links in page markup:`);
      result.duplicateLinks.forEach((dup, i) => {
        console.log(`  ${i + 1}. "${dup.title}"`);
        console.log(`     ${dup.link}`);
      });
    }

    if (result.skipped.length > 0) {
      console.log('Skipped elements:');
      result.skipped.forEach(skip => {
        if (skip.error) {
          console.log(`  [${skip.index}] Error: ${skip.error}`);
        } else {
          console.log(`  [${skip.index}] title=${skip.hasTitle ? '✓' : '✗'}, link=${skip.hasLink ? '✓' : '✗'} - "${skip.title}"`);
        }
      });
    }
    
    await page.close();
    
    // Store in database with detailed duplicate reporting (already-present in DB)
    const existing = getAllDigs();
    const beforeCount = existing.length;
    const existingLinks = new Set(existing.map(d => d.link));
    const existingTitleByLink = new Map(existing.map(d => [d.link, d.title]));
    const duplicatesInDb = [];
    
    digs.forEach(dig => {
      if (existingLinks.has(dig.link)) {
        duplicatesInDb.push({
          link: dig.link,
          scrapedTitle: dig.title,
          existingTitle: existingTitleByLink.get(dig.link) || '(unknown title)'
        });
      }
      insertDig(
        dig.link,
        dig.title,
        dig.description,
        dig.pubDate,
        dig.imageUrl,
        dig.author
      );
    });
    const afterCount = getAllDigs().length;
    const newArticles = afterCount - beforeCount;
    
    if (duplicatesInDb.length > 0) {
      console.log(`\n⚠️ Already in database (skipped on insert): ${duplicatesInDb.length}`);
      duplicatesInDb.forEach((dup, i) => {
        console.log(`  ${i + 1}. scraped="${dup.scrapedTitle}"`);
        console.log(`     link=${dup.link}`);
        console.log(`     existing title in DB="${dup.existingTitle}"`);
      });
    }
    
    console.log(`Successfully fetched ${digs.length} digs from Discogs (${newArticles} new, ${digs.length - newArticles} duplicates)`);
    return digs.length;
  } catch (error) {
    console.error('Error fetching digs:', error.message);
    if (page) await page.close().catch(() => {});
    
    // Return count from database instead if fetch fails
    const existingDigs = getAllDigs();
    return existingDigs.length;
  }
}

// Generate RSS feed
function generateRSS(digs) {
  const items = digs.map(dig => `
    <item>
      <title><![CDATA[${dig.title}]]></title>
      <link>${dig.link}</link>
      <guid isPermaLink="true">${dig.link}</guid>
      <pubDate>${new Date(dig.pubDate).toUTCString()}</pubDate>
      ${dig.author ? `<author>${dig.author}</author>` : ''}
      ${dig.description ? `<description><![CDATA[${dig.description}]]></description>` : ''}
      ${dig.imageUrl ? `<enclosure url="${dig.imageUrl}" type="image/jpeg"/>` : ''}
    </item>
  `).join('');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
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
  if (browser) {
    await browser.close();
  }
  if (db) {
    db.close();
  }
  process.exit(0);
});



