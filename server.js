require('dotenv').config();
const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const manifest = require('./manifest');

const app = express();
const PORT = process.env.PORT || 7860;

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

// MongoDB Setup
let db = null;
if (process.env.MONGODB_URI) {
  const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10 });
  client.connect()
    .then(() => {
      db = client.db('subnova_cache');
      db.collection('translations').createIndex({ cacheKey: 1 }, { unique: true });
      console.log('✅ Verbonden met MongoDB Atlas Cache');
    })
    .catch(err => console.error('⚠️ MongoDB connectiefout (draait zonder persistente cache):', err.message));
}

// Helper: Parse configuratie uit URL (Base64 JSON)
function parseConfig(rawConfig) {
  if (!rawConfig) return {};
  try {
    const decoded = Buffer.from(rawConfig, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    return {};
  }
}

// Helper: Opschonen en scoren van release namen
function parseReleaseInfo(releaseName = '', targetFilename = '') {
  const cleanName = (releaseName || '').replace(/[\._]/g, ' ').trim();
  let score = 0;
  if (targetFilename) {
    const targetTerms = targetFilename.toLowerCase().split(/[\._ -]+/);
    const releaseTerms = cleanName.toLowerCase().split(/[\._ -]+/);
    for (const term of targetTerms) {
      if (term.length > 2 && releaseTerms.includes(term)) {
        score += 1;
      }
    }
  }
  return { cleanName: cleanName || 'Onbekende Release', score };
}

// 1. Zoeker: OpenSubtitles.com
async function fetchOpenSubtitles(imdbNumeric, season, episode, userKey) {
  const apiKey = userKey || process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) return [];

  try {
    const params = {
      imdb_id: imdbNumeric,
      languages: 'nl,en'
    };
    if (season && episode) {
      params.season_number = season;
      params.episode_number = episode;
    }

    const res = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      params,
      headers: {
        'Api-Key': apiKey,
        'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SubNova-v1.0'
      },
      timeout: 5000
    });

    return (res.data?.data || []).map(item => ({
      source: 'OpenSubtitles',
      id: item.attributes.files?.[0]?.file_id,
      lang: item.attributes.language, // 'nl' of 'en'
      release: item.attributes.release || item.attributes.movie_name,
      fileId: item.attributes.files?.[0]?.file_id
    })).filter(s => s.fileId);
  } catch (err) {
    console.error('OpenSubtitles error:', err.message);
    return [];
  }
}

// 2. Zoeker: SubDL
async function fetchSubDL(imdbId, season, episode, userKey) {
  const apiKey = userKey || process.env.SUBDL_API_KEY;
  if (!apiKey) return [];

  try {
    const params = {
      api_key: apiKey,
      imdb_id: imdbId,
      languages: 'nl,en',
      type: season ? 'tv' : 'movie'
    };
    if (season && episode) {
      params.season_number = season;
      params.episode_number = episode;
    }

    const res = await axios.get('https://api.subdl.com/api/v1/subtitles', { params, timeout: 5000 });
    return (res.data?.subtitles || []).map(item => ({
      source: 'SubDL',
      id: item.url,
      lang: item.lang?.toLowerCase().startsWith('dut') || item.lang?.toLowerCase().startsWith('nl') ? 'nl' : 'en',
      release: item.release_name || item.name,
      directUrl: `https://dl.subdl.com${item.url}`
    }));
  } catch (err) {
    console.error('SubDL error:', err.message);
    return [];
  }
}

// 3. Zoeker: SubSource
async function fetchSubSource(imdbId, season, episode, userKey) {
  const apiKey = userKey || process.env.SUBSOURCE_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await axios.get(`https://api.subsource.net/api/v1/subtitles`, {
      params: { imdb_id: imdbId, lang: 'dutch,english' },
      headers: { 'X-API-Key': apiKey },
      timeout: 5000
    });

    return (res.data?.subtitles || []).map(item => ({
      source: 'SubSource',
      id: item.id,
      lang: item.lang?.toLowerCase().includes('dutch') ? 'nl' : 'en',
      release: item.release_name || item.movie_name,
      downloadUrl: `https://api.subsource.net/api/v1/subtitles/${item.id}/download`
    }));
  } catch (err) {
    console.error('SubSource error:', err.message);
    return [];
  }
}

// SRT vertaal-functie met Gemini
async function translateSrtWithGemini(srtContent, geminiKey, customModel) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Geen Gemini API Key geconfigureerd');

  const modelName = customModel || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  const prompt = `Je bent een meester film- en serievertaler. Vertaal de onderstaande Engelse SRT ondertiteling naar natuurlijk, eigentijds en vlot gesproken Nederlands.
Regels:
1. Behoud exact de originele nummering en timestamps (bijv. 00:01:20,000 --> 00:01:23,000).
2. Vertaal alleen de ondertitelteksten. Vertaal filmisch (geen houterige vertaling).
3. Geef DIRECT en UITSLUITEND de geldige SRT output terug, zonder markdown backticks (\`\`\` of \`\`\`srt), toelichting of introducties.

Engelse SRT:
${srtContent}`;

  const result = await model.generateContent(prompt);
  let translatedText = result.response.text();
  return translatedText.replace(/^```(?:srt)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

// VTT converter helper voor optimale Stremio-compatibiliteit
function srtToVtt(srtText) {
  return 'WEBVTT\n\n' + srtText
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// ================= ROUTES ================= //

// Manifest
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  res.json(manifest);
});

// Stremio Subtitles Handler
app.get(['/subtitles/:type/:id.json', '/subtitles/:type/:id/:extra.json',
         '/:config/subtitles/:type/:id.json', '/:config/subtitles/:type/:id/:extra.json'], async (req, res) => {
  const { type, id, extra, config: rawConfig } = req.params;
  const config = parseConfig(rawConfig);
  const host = `${req.protocol}://${req.get('host')}`;

  let imdbId = id;
  let season = null;
  let episode = null;

  if (id.includes(':')) {
    const parts = id.split(':');
    imdbId = parts[0];
    season = parts[1];
    episode = parts[2];
  }

  const numericImdb = imdbId.replace('tt', '');
  let extraArgs = {};
  if (extra) {
    extra.split('&').forEach(item => {
      const [k, v] = item.split('=');
      extraArgs[k] = decodeURIComponent(v || '');
    });
  }
  const filename = extraArgs.filename || '';

  // Parallel ophalen van alle 3 bronnen
  const [osResults, dlResults, ssResults] = await Promise.allSettled([
    fetchOpenSubtitles(numericImdb, season, episode, config.openSubtitlesKey),
    fetchSubDL(imdbId, season, episode, config.subdlKey),
    fetchSubSource(imdbId, season, episode, config.subsourceKey)
  ]);

  const allSubs = [
    ...(osResults.status === 'fulfilled' ? osResults.value : []),
    ...(dlResults.status === 'fulfilled' ? dlResults.value : []),
    ...(ssResults.status === 'fulfilled' ? ssResults.value : [])
  ];

  const nlSubs = allSubs.filter(s => s.lang === 'nl');
  const enSubs = allSubs.filter(s => s.lang === 'en');

  let subtitles = [];

  if (nlSubs.length > 0) {
    // Nederlandse ondertitels gevonden: sorteer op releasematch
    subtitles = nlSubs.map((sub, idx) => {
      const { cleanName, score } = parseReleaseInfo(sub.release, filename);
      const downloadParam = encodeURIComponent(JSON.stringify(sub));
      return {
        id: `nl_${sub.source}_${idx}`,
        url: `${host}/sub/stream?data=${downloadParam}`,
        lang: 'dut',
        label: `[${sub.source}] ${cleanName}`,
        score
      };
    }).sort((a, b) => b.score - a.score);
  } else if (enSubs.length > 0 && config.enableAi !== false) {
    // Geen Nederlands: Engelse ondertitels aanbieden met Gemini AI vertaling
    const rankedEnSubs = enSubs.map((sub, idx) => {
      const { cleanName, score } = parseReleaseInfo(sub.release, filename);
      return { ...sub, cleanName, score, originalIdx: idx };
    }).sort((a, b) => b.score - a.score).slice(0, 3); // Bied de top 3 matches aan

    subtitles = rankedEnSubs.map(sub => {
      const translationPayload = encodeURIComponent(JSON.stringify({
        ...sub,
        mediaId: id,
        geminiKey: config.geminiKey,
        geminiModel: config.geminiModel
      }));

      return {
        id: `ai_nl_${sub.source}_${sub.originalIdx}`,
        url: `${host}/sub/translate?data=${translationPayload}`,
        lang: 'dut',
        label: `[AI NL • Gemini] ${sub.cleanName}`
      };
    });
  }

  res.setHeader('Cache-Control', 'max-age=3600, stale-while-revalidate=86400');
  res.json({ subtitles });
});

// Download/Stream Endpoint voor native ondertitels
app.get('/sub/stream', async (req, res) => {
  try {
    const sub = JSON.parse(decodeURIComponent(req.query.data));
    let srtText = '';

    if (sub.source === 'OpenSubtitles') {
      const downloadRes = await axios.post('https://api.opensubtitles.com/api/v1/download', 
        { file_id: sub.fileId },
        { headers: { 'Api-Key': process.env.OPENSUBTITLES_API_KEY, 'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SubNova-v1.0' } }
      );
      const fileRes = await axios.get(downloadRes.data.link, { responseType: 'text' });
      srtText = fileRes.data;
    } else if (sub.source === 'SubDL') {
      const fileRes = await axios.get(sub.directUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(fileRes.data);
      try {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntries().find(e => e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt'));
        srtText = entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
      } catch (e) {
        srtText = buffer.toString('utf8');
      }
    } else if (sub.source === 'SubSource') {
      const fileRes = await axios.get(sub.downloadUrl, { 
        headers: { 'X-API-Key': process.env.SUBSOURCE_API_KEY },
        responseType: 'arraybuffer' 
      });
      const buffer = Buffer.from(fileRes.data);
      try {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntries().find(e => e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt'));
        srtText = entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
      } catch (e) {
        srtText = buffer.toString('utf8');
      }
    }

    const vttContent = srtText.includes('WEBVTT') ? srtText : srtToVtt(srtText);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vttContent);
  } catch (err) {
    console.error('Fout bij streamen van ondertitel:', err.message);
    res.status(500).send('Fout bij ophalen ondertitel');
  }
});

// Gemini Vertaling Endpoint met MongoDB Cache
app.get('/sub/translate', async (req, res) => {
  try {
    const data = JSON.parse(decodeURIComponent(req.query.data));
    const cacheKey = `ai_nl_${data.mediaId}_${data.source}_${data.id || data.fileId}`;

    // 1. Check MongoDB Cache
    if (db) {
      const cached = await db.collection('translations').findOne({ cacheKey });
      if (cached && cached.vtt) {
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        return res.send(cached.vtt);
      }
    }

    // 2. Download Engelse bron-tekst
    let rawSrt = '';
    if (data.source === 'OpenSubtitles') {
      const downloadRes = await axios.post('https://api.opensubtitles.com/api/v1/download', 
        { file_id: data.fileId },
        { headers: { 'Api-Key': process.env.OPENSUBTITLES_API_KEY, 'User-Agent': process.env.OPENSUBTITLES_USER_AGENT || 'SubNova-v1.0' } }
      );
      const fileRes = await axios.get(downloadRes.data.link, { responseType: 'text' });
      rawSrt = fileRes.data;
    } else if (data.directUrl) {
      const fileRes = await axios.get(data.directUrl, { responseType: 'arraybuffer' });
      const zip = new AdmZip(Buffer.from(fileRes.data));
      const entry = zip.getEntries().find(e => e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt'));
      rawSrt = entry ? entry.getData().toString('utf8') : fileRes.data.toString('utf8');
    } else if (data.downloadUrl) {
      const fileRes = await axios.get(data.downloadUrl, { 
        headers: { 'X-API-Key': process.env.SUBSOURCE_API_KEY }, 
        responseType: 'arraybuffer' 
      });
      const zip = new AdmZip(Buffer.from(fileRes.data));
      const entry = zip.getEntries().find(e => e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt'));
      rawSrt = entry ? entry.getData().toString('utf8') : fileRes.data.toString('utf8');
    }

    if (!rawSrt) throw new Error('Kon Engelse brontekst niet inladen');

    // 3. Vertaal via Gemini
    const translatedSrt = await translateSrtWithGemini(rawSrt, data.geminiKey, data.geminiModel);
    const vttContent = srtToVtt(translatedSrt);

    // 4. Bewaar in MongoDB Cache
    if (db) {
      await db.collection('translations').updateOne(
        { cacheKey },
        { $set: { cacheKey, vtt: vttContent, createdAt: new Date() } },
        { upsert: true }
      );
    }

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vttContent);
  } catch (err) {
    console.error('Fout bij vertalen via Gemini:', err.message);
    res.status(500).send('Vertaling mislukt');
  }
});

// Slick Web Configuration Interface
app.get(['/', '/configure', '/:config/configure'], (req, res) => {
  const currentConfig = parseConfig(req.params.config);
  
  res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SubNova AI - Configuratie</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(18, 24, 38, 0.7);
      --border: rgba(255, 255, 255, 0.08);
      --primary: #38bdf8;
      --primary-glow: rgba(56, 189, 248, 0.25);
      --emerald: #34d399;
      --text: #f1f5f9;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(56, 189, 248, 0.12) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(52, 211, 153, 0.08) 0px, transparent 50%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .wrapper {
      width: 100%;
      max-width: 680px;
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 40px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
    }
    .header { text-align: center; margin-bottom: 32px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(56, 189, 248, 0.1);
      color: var(--primary);
      border: 1px solid rgba(56, 189, 248, 0.2);
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 12px;
    }
    .title { font-size: 2rem; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 8px; }
    .title span { background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: var(--muted); font-size: 0.95rem; }
    .section-title { font-size: 0.85rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 24px 0 12px; }
    .field { margin-bottom: 16px; }
    .field label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; }
    .field input, .field select {
      width: 100%;
      background: rgba(10, 15, 26, 0.8);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 16px;
      color: var(--text);
      font-size: 0.95rem;
      transition: all 0.2s;
    }
    .field input:focus, .field select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      background: rgba(10, 15, 26, 0.5);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 16px;
    }
    .toggle-row label { font-size: 0.9rem; font-weight: 600; cursor: pointer; }
    .switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
    }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
      background-color: #334155; transition: .3s; border-radius: 24px;
    }
    .slider:before {
      position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px;
      background-color: white; transition: .3s; border-radius: 50%;
    }
    input:checked + .slider { background-color: var(--primary); }
    input:checked + .slider:before { transform: translateX(20px); }
    .actions { display: flex; flex-direction: column; gap: 12px; margin-top: 32px; }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 14px 20px;
      border-radius: 14px;
      font-weight: 700;
      font-size: 0.95rem;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: linear-gradient(135deg, #38bdf8 0%, #3b82f6 100%);
      color: #04101e;
      border: none;
      box-shadow: 0 10px 25px -5px var(--primary-glow);
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 15px 30px -5px var(--primary-glow); }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.1); }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="badge">🚀 Gemini 3.5 Powered</div>
      <h1 class="title">SubNova <span>AI</span></h1>
      <p class="subtitle">Multi-source Nederlandse ondertitels met automatische AI-fallback</p>
    </div>

    <div class="section-title">AI Vertaalmotor (Google Gemini)</div>
    <div class="toggle-row">
      <label for="enableAi">Automatische AI Vertaling als Fallback</label>
      <label class="switch">
        <input type="checkbox" id="enableAi" checked>
        <span class="slider"></span>
      </label>
    </div>
    <div class="field">
      <label for="geminiKey">Gemini API Key (optioneel als de host er een heeft ingesteld)</label>
      <input type="password" id="geminiKey" placeholder="AIzaSy..." value="${currentConfig.geminiKey || ''}">
    </div>
    <div class="field">
      <label for="geminiModel">Model</label>
      <select id="geminiModel">
        <option value="gemini-3.5-flash-lite" selected>gemini-3.5-flash-lite (Aanbevolen: snelste & laagste latency)</option>
        <option value="gemini-2.5-flash">gemini-2.5-flash</option>
      </select>
    </div>

    <div class="section-title">Ondertitelbronnen (Optionele API Keys)</div>
    <div class="field">
      <label for="openSubtitlesKey">OpenSubtitles.com API Key</label>
      <input type="text" id="openSubtitlesKey" placeholder="Jouw OpenSubtitles API key" value="${currentConfig.openSubtitlesKey || ''}">
    </div>
    <div class="field">
      <label for="subdlKey">SubDL API Key</label>
      <input type="text" id="subdlKey" placeholder="Jouw SubDL API key" value="${currentConfig.subdlKey || ''}">
    </div>
    <div class="field">
      <label for="subsourceKey">SubSource API Key</label>
      <input type="text" id="subsourceKey" placeholder="Jouw SubSource API key" value="${currentConfig.subsourceKey || ''}">
    </div>

    <div class="actions">
      <button class="btn btn-primary" onclick="installAddon()">Installeer in Stremio</button>
      <button class="btn btn-secondary" onclick="copyManifestUrl()">Kopieer Add-on Manifest Link</button>
    </div>
  </div>

  <script>
    function generateManifestUrl() {
      const config = {
        enableAi: document.getElementById('enableAi').checked,
        geminiKey: document.getElementById('geminiKey').value.trim(),
        geminiModel: document.getElementById('geminiModel').value,
        openSubtitlesKey: document.getElementById('openSubtitlesKey').value.trim(),
        subdlKey: document.getElementById('subdlKey').value.trim(),
        subsourceKey: document.getElementById('subsourceKey').value.trim(),
      };
      const encoded = btoa(JSON.stringify(config));
      return window.location.origin + '/' + encoded + '/manifest.json';
    }

    function installAddon() {
      const url = generateManifestUrl();
      const stremioUrl = url.replace(/^https?:\\/\\//, 'stremio://');
      window.location.href = stremioUrl;
    }

    function copyManifestUrl() {
      const url = generateManifestUrl();
      navigator.clipboard.writeText(url).then(() => {
        alert('Manifest link gekopieerd naar klembord!');
      });
    }
  </script>
</body>
</html>`);
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SubNova AI Add-on draait succesvol op poort ${PORT}`);
  console.log(`🌐 Configuratie UI: http://localhost:${PORT}`);
});