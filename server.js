const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YOUTUBE_API_KEY = 'AIzaSyBjJpmGdvt8Ag6-uE-4_v3_ouWQRVvPFAs';
const DB_FILE = path.join(__dirname, 'library.json');

const INVIDIOUS_HOSTS = [
  'inv.nadeko.net',
  'invidious.nerdvpn.de',
  'iv.melmac.space',
  'invidious.privacyredirect.com'
];

// ─── Helpers ─────────────────────────────────────────────────
function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveLibrary(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

// ─── /api/search ─────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY}`;

  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    });
  }).on('error', err => res.status(500).json({ error: err.message }));
});

// ─── /api/stream ─────────────────────────────────────────────
app.get('/api/stream', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'No video id' });

  for (const host of INVIDIOUS_HOSTS) {
    try {
      const data = await httpsGet(`https://${host}/api/v1/videos/${videoId}?fields=adaptiveFormats,title`);
      if (!data.adaptiveFormats) continue;

      const format = data.adaptiveFormats
        .filter(f => f.type?.startsWith('audio/') && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (!format?.url) continue;

      return res.json({ url: format.url, mimeType: format.type });
    } catch (err) {
      console.warn(`Host ${host} failed:`, err.message);
    }
  }

  res.status(404).json({ error: 'No audio stream found' });
});

// ─── /api/favorite ───────────────────────────────────────────
app.post('/api/favorite', (req, res) => {
  const { userId, action, track } = req.body;

  if (!userId || !action || !track?.id) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const db = loadLibrary();
  let tracks = db[String(userId)] || [];

  if (action === 'add') {
    if (!tracks.find(t => t.id === track.id)) {
      tracks.push({ id: track.id, title: track.title, channel: track.channel, thumbnail: track.thumbnail || '' });
    }
  } else if (action === 'remove') {
    tracks = tracks.filter(t => t.id !== track.id);
  }

  db[String(userId)] = tracks;
  saveLibrary(db);

  res.json({ ok: true, count: tracks.length });
});

// ─── /api/library ────────────────────────────────────────────
app.get('/api/library', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'No userId' });

  const db = loadLibrary();
  res.json(db[String(userId)] || []);
});

// ─── /api/tgfile — проксируем аудио из Telegram ─────────────
app.get('/api/tgfile', async (req, res) => {
  const fileId = req.query.id;
  if (!fileId) return res.status(400).json({ error: 'No file id' });

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ error: 'No bot token' });

  try {
    const infoResp = await new Promise((resolve, reject) => {
      https.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });

    if (!infoResp.ok) return res.status(404).json({ error: 'File not found' });

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${infoResp.result.file_path}`;
    res.json({ url: fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
