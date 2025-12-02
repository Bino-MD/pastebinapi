// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Storage, File } = require('megajs');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// ensure db exists
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}, null, 2));

function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Express setup
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));
app.use(bodyParser.json({ limit: '1mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// setup mega storage
const megaOpts = {};
if (process.env.MEGA_EMAIL) megaOpts.email = process.env.MEGA_EMAIL;
if (process.env.MEGA_PASSWORD) megaOpts.password = process.env.MEGA_PASSWORD;

const storage = new Storage(megaOpts);

let storageReady = false;
storage.on('ready', () => {
  storageReady = true;
  console.log('MEGA storage ready. Root children:', storage.root && storage.root.children && storage.root.children.length);
});
storage.on('error', err => {
  console.error('MEGA error:', err);
});

// multer for file uploads
const upload = multer();

// ROUTES

// front page (serves static, but also render a quick page)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: create paste (form submit or AJAX)
app.post('/api/paste', upload.single('file'), async (req, res) => {
  try {
    if (!storageReady) {
      // still let user know we will attempt but warn
      console.warn('MEGA storage not ready yet.');
    }

    const content = req.body.content ?? '';
    const filenameProvided = req.body.filename && req.body.filename.trim() !== '' ? req.body.filename.trim() : null;
    const language = req.body.language || 'text';
    const expire = req.body.expire || null; // not implemented: could delete after expire
    const fileBuffer = req.file ? req.file.buffer : Buffer.from(content || '', 'utf8');

    // create slug
    const slug = crypto.randomBytes(16).toString('hex'); //nanoid(32);

    // pick a friendly filename
    const filename = filenameProvided || `${slug}.${language === 'text' ? 'txt' : language}`;

    // upload to MEGA
    await new Promise((resolve, reject) => {
      storage.upload(filename, fileBuffer, (err, file) => {
        if (err) return reject(err);

        // publish file -> get clickable public link
        file.link((err2, link) => {
          if (err2) return reject(err2);

          // save to local DB
          const db = readDB();
          db[slug] = {
            filename,
            language,
            megaLink: link,
            createdAt: new Date().toISOString()
          };
          writeDB(db);

          // respond with our view URL
          resolve({ slug, link });
        });
      });
    }).then(({slug: s, link}) => {
      // respond
      res.json({
        ok: true,
        slug: slug,
        url: `${process.env.BASE_URL || `http://localhost:${PORT}`}/paste/${slug}`,
        megaUrl: link
      });
    }).catch(err => {
      console.error('upload error', err);
      res.status(500).json({ ok: false, error: err.message || String(err) });
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve paste view
app.get('/paste/:slug', async (req, res) => {
  const slug = req.params.slug;
  const db = readDB();
  const record = db[slug];
  if (!record) {
    return res.status(404).send('Paste not found');
  }

  // Option A (fast): simply redirect to MEGA shared URL
  // return res.redirect(record.megaLink);

  // Option B (we fetch content server-side, then render with syntax highlight)
  try {
    // Use File.fromURL to read the MEGA shared link
    const file = File.fromURL(record.megaLink);
    await file.loadAttributes();
    const buffer = await file.downloadBuffer();
    const text = buffer.toString('utf8');

    // render simple EJS viewer (views/paste.ejs)
    return res.render('paste', {
      slug,
      text,
      filename: record.filename,
      language: record.language,
      megaLink: record.megaLink
    });
  } catch (err) {
    console.error('Error loading from MEGA', err);
    // fallback: redirect to MEGA link
    return res.redirect(record.megaLink);
  }
});

// optional: raw text endpoint
app.get('/raw/:slug', async (req, res) => {
  const slug = req.params.slug;
  const db = readDB();
  const record = db[slug];
  if (!record) return res.status(404).send('Not found');

  try {
    const file = File.fromURL(record.megaLink);
    await file.loadAttributes();
    const buffer = await file.downloadBuffer();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(buffer.toString('utf8'));
  } catch (err) {
    console.error(err);
    return res.redirect(record.megaLink);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
