require('dotenv').config();
const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const manifest = require('./manifest');

const app = express();
const PORT = process.env.PORT || 7860;

// Foutopvang
process.on('uncaughtException', (err) => console.error('❌ uncaughtException:', err.message));
process.on('unhandledRejection', (reason) => console.error('❌ unhandledRejection:', reason));

// Middleware & Volledige CORS
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// MongoDB Setup
let db = null;
if (process.env.MONGODB_URI) {
  try {
    const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10 });
    client.connect()
      .then(() => {
        db = client.db('subnova_cache');
        db.collection('translations').createIndex({ cacheKey: 1 }, { unique: true });
        console.log('✅ Verbonden met MongoDB Atlas Cache');
      })
      .catch(err => console.error('⚠️ MongoDB connectiefout:', err.message));
  } catch (err) {
    console.error('⚠️ Ongeldige MongoDB URL:', err.message);
  }
}

const osTokenCache = new Map();

function parseConfig(rawConfig) {
  if (!rawConfig) return {};
  try {
    let str = rawConfig.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return JSON.parse(Buffer.from(str, 'base64').toString('utf8'));
  } catch (e) {
    return {};
  }
}

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

function srtToVtt(srtText) {
  if (!srtText) return 'WEBVTT\n\n';
  if (srtText.trim().startsWith('WEBVTT')) return srtText;
  const clean = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return 'WEBVTT\n\n' + clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

async function translateFullSrtWithGemini(rawSrt, geminiKey, preferredModel) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Geen Gemini API Key beschikbaar');

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = preferredModel || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const model = genAI.getGenerativeModel({
    model: modelName,
    safetySettings,
    generationConfig: { maxOutputTokens: 65536, temperature: 0.1 }
  });

  const prompt = `Je bent een professionele filmvertaler. Vertaal de onderstaande Engelse SRT-ondertitels naar natuurlijk Nederlands.
STRIKTE REGELS:
1. Behoud exact alle originele nummers en timestamps.
2. Wijzig de tijdcodes nooit.
3. Vertaal uitsluitend de dialoogtekst.
4. Geen introductie of markdown (\`\`\` of \`\`\`srt).

SRT:
${rawSrt}`;

  const result = await model.generateContent(prompt);
  let translated = result.response.text();
  return translated.replace(/^```(?:srt)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

// ================= LIVE VALIDATIE ENDPOINTS ================= //

app.post('/api/validate/gemini', async (req, res) => {
  const { apiKey, model } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'Vul een API-sleutel in' });
  try {
    const genAI = new GoogleGenerativeAI(apiKey.trim());
    const m = genAI.getGenerativeModel({ model: model || 'gemini-3.5-flash-lite' });
    await m.countTokens('Test validatie');
    return res.json({ success: true, message: 'Google Gemini API is actief en geldig!' });
  } catch (err) {
    return res.json({ success: false, error: err.message?.includes('API_KEY_INVALID') ? 'Ongeldige sleutel' : 'Verbinding mislukt' });
  }
});

app.post('/api/validate/opensubtitles', async (req, res) => {
  const { apiKey, username, password } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'OpenSubtitles API Key ontbreekt' });
  try {
    if (username && password) {
      const loginRes = await axios.post('https://api.opensubtitles.com/api/v1/login', {
        username: username.trim(),
        password: password.trim()
      }, {
        headers: { 'Api-Key': apiKey.trim(), 'Content-Type': 'application/json', 'User-Agent': 'SubNova-v2.0' },
        timeout: 6000
      });
      if (loginRes.data?.token) {
        return res.json({ success: true, message: `Ingelogd als ${loginRes.data.user?.username || username}!` });
      }
    } else {
      await axios.get('https://api.opensubtitles.com/api/v1/infos/formats', {
        headers: { 'Api-Key': apiKey.trim(), 'User-Agent': 'SubNova-v2.0' }, timeout: 5000
      });
      return res.json({ success: true, message: 'API Key is geldig!' });
    }
  } catch (err) {
    return res.json({ success: false, error: 'Inloggen mislukt (controleer API Key of inloggegevens)' });
  }
});

app.post('/api/validate/subdl', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'SubDL API Key ontbreekt' });
  try {
    const checkRes = await axios.get('https://api.subdl.com/api/v1/subtitles', {
      params: { api_key: apiKey.trim(), imdb_id: 'tt0111161' }, timeout: 5000
    });
    if (checkRes.data?.status === true || checkRes.data?.subtitles) return res.json({ success: true, message: 'SubDL API is actief!' });
    return res.json({ success: false, error: 'Ongeldige SubDL sleutel' });
  } catch (err) { return res.json({ success: false, error: 'Verbinding mislukt' }); }
});

app.post('/api/validate/subsource', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'SubSource API Key ontbreekt' });
  const key = apiKey.trim();

  try {
    const response = await axios.get('https://api.subsource.net/api/v1/subtitles/recent', {
      headers: { 'X-API-Key': key, 'User-Agent': 'SubNova/2.0', 'Accept': 'application/json' },
      params: { api_key: key },
      timeout: 7000
    });
    if (response.status === 200) return res.json({ success: true, message: 'SubSource API is actief!' });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) return res.json({ success: false, error: 'Ongeldige SubSource sleutel (401/403)' });
    return res.json({ success: false, error: 'Verbinding mislukt (' + (status || 'timeout') + ')' });
  }
  return res.json({ success: false, error: 'SubSource gaf geen reactie' });
});

// ================= SUBTITLE BRONNEN ================= //

async function getOpenSubtitlesToken(apiKey, username, password) {
  if (!apiKey || !username || !password) return null;
  const cacheKey = `${apiKey.trim()}_${username.trim()}`;
  const cached = osTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  try {
    const res = await axios.post('https://api.opensubtitles.com/api/v1/login', {
      username: username.trim(),
      password: password.trim()
    }, {
      headers: { 'Api-Key': apiKey.trim(), 'Content-Type': 'application/json', 'User-Agent': 'SubNova-v2.0' },
      timeout: 6000
    });
    if (res.data?.token) {
      osTokenCache.set(cacheKey, { token: res.data.token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 });
      return res.data.token;
    }
  } catch (err) {
    console.error('[OpenSubtitles] Inlogfout:', err.message);
  }
  return null;
}

async function fetchOpenSubtitlesOfficial(imdbId, season, episode, osApiKey, osUsername, osPassword) {
  const apiKey = osApiKey || process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) return [];
  const cleanImdb = imdbId ? imdbId.replace(/^tt/, '') : null;
  if (!cleanImdb) return [];

  try {
    const token = await getOpenSubtitlesToken(apiKey, osUsername || process.env.OPENSUBTITLES_USERNAME, osPassword || process.env.OPENSUBTITLES_PASSWORD);
    const headers = { 'Api-Key': apiKey.trim(), 'User-Agent': 'SubNova-v2.0' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const params = { imdb_id: cleanImdb, languages: 'nl,en' };
    if (season && episode) {
      params.season_number = season;
      params.episode_number = episode;
      params.type = 'episode';
    } else {
      params.type = 'movie';
    }

    const res = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', { headers, params, timeout: 4500 });
    const list = res.data?.data || [];
    const results = [];

    for (const item of list) {
      const file = item.attributes?.files?.[0];
      if (!file?.file_id) continue;
      const lang = item.attributes?.language?.toLowerCase();
      results.push({
        source: 'OpenSubtitles VIP',
        id: `os_v1_${file.file_id}`,
        fileId: file.file_id,
        lang: (lang === 'nl' || lang === 'dut') ? 'nl' : 'en',
        release: item.attributes?.release || item.attributes?.feature_details?.movie_name || 'OpenSubtitles Match',
        osApiKey: apiKey.trim(),
        osToken: token
      });
    }
    return results;
  } catch (err) {
    return [];
  }
}

async function fetchOpenSubtitlesPublic(type, id, extra) {
  try {
    const url = extra 
      ? `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}/${extra}.json`
      : `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}.json`;
    const res = await axios.get(url, { timeout: 4000 });
    return (res.data?.subtitles || []).map(item => ({
      source: 'OpenSubtitles',
      id: item.id,
      lang: (item.lang === 'dut' || item.lang === 'nld') ? 'nl' : (item.lang === 'eng' ? 'en' : item.lang),
      release: item.id || 'Gesynchroniseerd',
      directUrl: item.url
    }));
  } catch (err) { return []; }
}

async function fetchSubDL(imdbId, season, episode, userKey) {
  const apiKey = userKey || process.env.SUBDL_API_KEY;
  if (!apiKey) return [];
  try {
    const params = { api_key: apiKey.trim(), imdb_id: imdbId, languages: 'nl,en', type: season ? 'tv' : 'movie' };
    if (season && episode) { params.season_number = season; params.episode_number = episode; }
    const res = await axios.get('https://api.subdl.com/api/v1/subtitles', { params, timeout: 4000 });
    return (res.data?.subtitles || []).map(item => ({
      source: 'SubDL',
      id: item.url,
      lang: item.lang?.toLowerCase().startsWith('dut') || item.lang?.toLowerCase().startsWith('nl') ? 'nl' : 'en',
      release: item.release_name || item.name || 'SubDL Match',
      directUrl: `https://dl.subdl.com${item.url}`
    }));
  } catch (err) { return []; }
}

async function fetchSubSource(imdbId, userKey) {
  const apiKey = userKey || process.env.SUBSOURCE_API_KEY;
  if (!apiKey) return [];
  const key = apiKey.trim();

  try {
    const searchRes = await axios.get('https://api.subsource.net/api/v1/movies/search', {
      params: { query: imdbId, api_key: key },
      headers: { 'X-API-Key': key, 'User-Agent': 'SubNova/2.0' },
      timeout: 4500
    });
    const movies = searchRes.data?.data || searchRes.data?.movies || (Array.isArray(searchRes.data) ? searchRes.data : []);
    const movie = movies[0];
    if (!movie || !movie.id) return [];

    const subRes = await axios.get('https://api.subsource.net/api/v1/subtitles', {
      params: { movieId: movie.id, lang: 'dutch,english', api_key: key },
      headers: { 'X-API-Key': key, 'User-Agent': 'SubNova/2.0' },
      timeout: 4500
    });
    const list = subRes.data?.data || subRes.data?.subtitles || (Array.isArray(subRes.data) ? subRes.data : []);
    return list.map(item => ({
      source: 'SubSource',
      id: item.id || item.subId,
      lang: item.lang?.toLowerCase().includes('dutch') || item.lang?.toLowerCase() === 'nl' ? 'nl' : 'en',
      release: item.release_name || item.name || 'SubSource Match',
      downloadUrl: `https://api.subsource.net/api/v1/subtitles/${item.id || item.subId}/download`,
      apiKey: key
    }));
  } catch (err) { return []; }
}

async function downloadSubtitleText(sub) {
  if (sub.fileId && sub.osApiKey) {
    const headers = { 'Api-Key': sub.osApiKey, 'User-Agent': 'SubNova-v2.0', 'Content-Type': 'application/json' };
    if (sub.osToken) headers['Authorization'] = `Bearer ${sub.osToken}`;

    const dlRes = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: sub.fileId }, { headers, timeout: 8000 });
    if (dlRes.data?.link) {
      const fileRes = await axios.get(dlRes.data.link, { responseType: 'arraybuffer', timeout: 8000 });
      const buffer = Buffer.from(fileRes.data);
      try {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntries().find(e => e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt'));
        return entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
      } catch (e) { return buffer.toString('utf8'); }
    }
  }

  if (sub.downloadUrl && sub.apiKey) {
    const fileRes = await axios.get(sub.downloadUrl, {
      headers: { 'X-API-Key': sub.apiKey },
      params: { api_key: sub.apiKey },
      responseType: 'arraybuffer',
      timeout: 8000
    });
    const buffer = Buffer.from(fileRes.data);
    try {
      const zip = new AdmZip(buffer);
      const entry = zip.getEntries().find(e => e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt'));
      return entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
    } catch (e) { return buffer.toString('utf8'); }
  }

  if (sub.directUrl) {
    const fileRes = await axios.get(sub.directUrl, { responseType: 'arraybuffer', timeout: 8000 });
    const buffer = Buffer.from(fileRes.data);
    try {
      const zip = new AdmZip(buffer);
      const entry = zip.getEntries().find(e => e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt'));
      return entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
    } catch (e) { return buffer.toString('utf8'); }
  }

  return '';
}

// ================= STREMIO ROUTE ================= //

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json(manifest);
});

app.get([
  '/subtitles/:type/:id.json',
  '/subtitles/:type/:id/:extra.json',
  '/:config/subtitles/:type/:id.json',
  '/:config/subtitles/:type/:id/:extra.json'
], async (req, res) => {
  const { type, id, extra, config: rawConfig } = req.params;
  const config = parseConfig(rawConfig);
  const host = `${req.protocol}://${req.get('host')}`;

  let imdbId = id;
  let season = null;
  let episode = null;

  if (id && id.includes(':')) {
    const parts = id.split(':');
    imdbId = parts[0];
    season = parts[1];
    episode = parts[2];
  }

  const [osOfficialResults, pubResults, dlResults, ssResults] = await Promise.allSettled([
    fetchOpenSubtitlesOfficial(imdbId, season, episode, config.osApiKey, config.osUsername, config.osPassword),
    fetchOpenSubtitlesPublic(type, id, extra),
    fetchSubDL(imdbId, season, episode, config.subdlKey),
    fetchSubSource(imdbId, config.subsourceKey)
  ]);

  const allSubs = [
    ...(osOfficialResults.status === 'fulfilled' ? osOfficialResults.value : []),
    ...(pubResults.status === 'fulfilled' ? pubResults.value : []),
    ...(dlResults.status === 'fulfilled' ? dlResults.value : []),
    ...(ssResults.status === 'fulfilled' ? ssResults.value : [])
  ];

  const nlSubs = allSubs.filter(s => s.lang === 'nl');
  const enSubs = allSubs.filter(s => s.lang === 'en');

  let subtitles = [];

  if (enSubs.length > 0) {
    const bestEn = enSubs[0];
    const payload = encodeURIComponent(JSON.stringify({
      ...bestEn,
      mediaId: id,
      geminiKey: config.geminiKey,
      geminiModel: config.geminiModel
    }));

    subtitles.push({
      id: `ai_nl_sync_top`,
      url: `${host}/sub/translate?data=${payload}`,
      lang: 'dut',
      label: `⭐ [AI NL • Gesynchroniseerd] Gemini 3.5 (${bestEn.release})`
    });
  }

  nlSubs.forEach((sub, idx) => {
    const payload = encodeURIComponent(JSON.stringify(sub));
    subtitles.push({
      id: `nl_${sub.source.replace(/\s+/g, '_')}_${idx}`,
      url: `${host}/sub/stream?data=${payload}`,
      lang: 'dut',
      label: `[${sub.source}] ${sub.release || 'Nederlands'}`
    });
  });

  res.setHeader('Cache-Control', 'max-age=3600, stale-while-revalidate=86400');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({ subtitles });
});

// ================= STREAM PROXY ================= //

app.get('/sub/stream', async (req, res) => {
  try {
    const sub = JSON.parse(decodeURIComponent(req.query.data));
    const rawText = await downloadSubtitleText(sub);
    const vtt = srtToVtt(rawText);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(vtt);
  } catch (err) {
    res.status(500).send('Fout bij streamen van ondertitel');
  }
});

// ================= TRANSLATE ================= //

app.get('/sub/translate', async (req, res) => {
  try {
    const data = JSON.parse(decodeURIComponent(req.query.data));
    const cacheKey = `ai_nl_synced_${data.mediaId}_${Buffer.from(data.directUrl || data.downloadUrl || data.id).toString('base64').substring(0, 24)}`;

    if (db) {
      try {
        const cached = await db.collection('translations').findOne({ cacheKey });
        if (cached && cached.vtt) {
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.send(cached.vtt);
        }
      } catch (e) {}
    }

    const rawSrt = await downloadSubtitleText(data);
    if (!rawSrt) throw new Error('Kon Engelse bronsubtitel niet downloaden');

    console.log(`[SubNova] Vertaalopdracht via Gemini voor ${cacheKey}...`);
    const translatedSrt = await translateFullSrtWithGemini(rawSrt, data.geminiKey, data.geminiModel);
    const vtt = srtToVtt(translatedSrt);

    if (db) {
      try {
        await db.collection('translations').updateOne(
          { cacheKey },
          { $set: { cacheKey, vtt, createdAt: new Date() } },
          { upsert: true }
        );
      } catch (e) {}
    }

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(vtt);
  } catch (err) {
    console.error('Vertaalfout:', err.message);
    res.status(500).send('Vertaling mislukt');
  }
});

// ================= CONFIGURATIE PAGINA ================= //

app.get(['/', '/configure', '/:config/configure'], (req, res) => {
  const cfg = parseConfig(req.params.config);

  res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SubNova AI - Configuratie</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card: rgba(18, 24, 38, 0.75);
      --border: rgba(255, 255, 255, 0.08);
      --primary: #38bdf8;
      --primary-glow: rgba(56, 189, 248, 0.25);
      --emerald: #10b981;
      --emerald-bg: rgba(16, 185, 129, 0.12);
      --rose: #f43f5e;
      --rose-bg: rgba(244, 63, 94, 0.12);
      --text: #f1f5f9;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body {
      background-color: var(--bg);
      background-image: radial-gradient(at 0% 0%, rgba(56, 189, 248, 0.12) 0px, transparent 50%),
                        radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.08) 0px, transparent 50%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }
    .wrapper {
      width: 100%;
      max-width: 680px;
      background: var(--card);
      backdrop-filter: blur(24px);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 36px 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
    }
    .header { text-align: center; margin-bottom: 28px; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px; background: rgba(56, 189, 248, 0.12);
      color: var(--primary); border: 1px solid rgba(56, 189, 248, 0.25); padding: 5px 14px;
      border-radius: 999px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.05em; margin-bottom: 12px;
    }
    .title { font-size: 2.1rem; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 6px; }
    .title span { background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: var(--muted); font-size: 0.95rem; }
    .section-title { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 24px 0 12px; }
    .field-group { margin-bottom: 18px; }
    .field-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .field-header label { font-size: 0.85rem; font-weight: 600; }
    .status-badge { font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 6px; display: none; align-items: center; gap: 4px; }
    .status-badge.valid { display: inline-flex; background: var(--emerald-bg); color: var(--emerald); border: 1px solid rgba(16, 185, 129, 0.25); }
    .status-badge.invalid { display: inline-flex; background: var(--rose-bg); color: var(--rose); border: 1px solid rgba(244, 63, 94, 0.25); }
    .status-badge.loading { display: inline-flex; background: rgba(255, 255, 255, 0.08); color: var(--muted); }
    .input-wrapper { position: relative; display: flex; align-items: center; }
    .input-wrapper input, select {
      width: 100%; background: rgba(10, 15, 26, 0.8); border: 1px solid var(--border);
      border-radius: 12px; padding: 12px 105px 12px 14px; color: var(--text); font-size: 0.95rem;
    }
    .input-wrapper input:focus, select:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-glow); }
    .input-actions { position: absolute; right: 8px; display: flex; align-items: center; gap: 6px; }
    .icon-btn { background: transparent; border: none; color: var(--muted); cursor: pointer; padding: 6px; border-radius: 8px; }
    .check-btn { background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.25); color: var(--primary); font-size: 0.75rem; font-weight: 700; padding: 5px 10px; border-radius: 8px; cursor: pointer; }
    .check-btn:hover { background: var(--primary); color: #04101e; }
    .hint { font-size: 0.75rem; color: var(--muted); margin-top: 4px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .actions { display: flex; flex-direction: column; gap: 12px; margin-top: 32px; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px 20px; border-radius: 14px; font-weight: 700; font-size: 0.95rem; cursor: pointer; text-decoration: none; border: none; }
    .btn-primary { background: linear-gradient(135deg, #38bdf8 0%, #3b82f6 100%); color: #04101e; box-shadow: 0 10px 25px -5px var(--primary-glow); }
    .btn-secondary { background: rgba(255, 255, 255, 0.05); color: var(--text); border: 1px solid var(--border); }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="badge">⭐ High-Speed Sync & Nuvio Support</div>
      <h1 class="title">SubNova <span>AI</span></h1>
      <p class="subtitle">Multi-source Nederlandse ondertitels met Gemini vertaling</p>
    </div>

    <!-- 1. Gemini AI -->
    <div class="section-title">1. AI Vertaalmotor (Google Gemini)</div>
    <div class="field-group">
      <div class="field-header">
        <label for="geminiKey">Gemini API Key</label>
        <span id="geminiBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="geminiKey" placeholder="AIzaSy..." value="${cfg.geminiKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('geminiKey')">👁</button>
          <button class="check-btn" onclick="checkGemini()">Controleer</button>
        </div>
      </div>
      <div class="hint">Gratis via <a href="https://aistudio.google.com" target="_blank" style="color:var(--primary);">aistudio.google.com</a>.</div>
    </div>

    <div class="field-group">
      <label style="font-size:0.85rem; font-weight:600; margin-bottom:6px; display:block;">Model</label>
      <select id="geminiModel">
        <option value="gemini-3.5-flash-lite" ${cfg.geminiModel === 'gemini-3.5-flash-lite' ? 'selected' : ''}>gemini-3.5-flash-lite (Snelste: 3s vertaaltijd)</option>
        <option value="gemini-2.5-flash" ${cfg.geminiModel === 'gemini-2.5-flash' ? 'selected' : ''}>gemini-2.5-flash</option>
      </select>
    </div>

    <!-- 2. OpenSubtitles -->
    <div class="section-title">2. OpenSubtitles.com (REST API v1)</div>
    <div class="field-group">
      <div class="field-header">
        <label for="osApiKey">OpenSubtitles API Key</label>
        <span id="osBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="osApiKey" placeholder="Jouw OpenSubtitles API Key" value="${cfg.osApiKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('osApiKey')">👁</button>
          <button class="check-btn" onclick="checkOpenSubtitles()">Controleer</button>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="field-group">
        <label style="font-size:0.85rem; font-weight:600; margin-bottom:6px; display:block;">Gebruikersnaam</label>
        <div class="input-wrapper">
          <input type="text" id="osUsername" style="padding-right: 14px;" placeholder="Username" value="${cfg.osUsername || ''}">
        </div>
      </div>
      <div class="field-group">
        <label style="font-size:0.85rem; font-weight:600; margin-bottom:6px; display:block;">Wachtwoord</label>
        <div class="input-wrapper">
          <input type="password" id="osPassword" placeholder="Password" value="${cfg.osPassword || ''}">
          <div class="input-actions">
            <button class="icon-btn" onclick="toggleVisibility('osPassword')">👁</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. SubSource & SubDL -->
    <div class="section-title">3. SubSource & SubDL (Optioneel)</div>
    <div class="field-group">
      <div class="field-header">
        <label for="subsourceKey">SubSource API Key</label>
        <span id="subsourceBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="subsourceKey" placeholder="SubSource API key" value="${cfg.subsourceKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('subsourceKey')">👁</button>
          <button class="check-btn" onclick="checkSubSource()">Controleer</button>
        </div>
      </div>
    </div>

    <div class="field-group">
      <div class="field-header">
        <label for="subdlKey">SubDL API Key</label>
        <span id="subdlBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="subdlKey" placeholder="SubDL API key" value="${cfg.subdlKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('subdlKey')">👁</button>
          <button class="check-btn" onclick="checkSubDL()">Controleer</button>
        </div>
      </div>
    </div>

    <!-- Acties -->
    <div class="actions">
      <button class="btn btn-primary" onclick="installAddon()">Installeer in Stremio / Nuvio</button>
      <button class="btn btn-secondary" onclick="copyManifestUrl()">Kopieer Add-on Manifest Link</button>
    </div>
  </div>

  <script>
    function toggleVisibility(id) {
      const el = document.getElementById(id);
      el.type = el.type === 'password' ? 'text' : 'password';
    }

    function setBadge(id, state, text) {
      const el = document.getElementById(id);
      el.className = 'status-badge ' + state;
      el.textContent = text;
    }

    async function checkGemini() {
      const apiKey = document.getElementById('geminiKey').value.trim();
      const model = document.getElementById('geminiModel').value;
      if (!apiKey) return alert('Vul eerst een Gemini API-sleutel in.');
      setBadge('geminiBadge', 'loading', '⏳ Verifiëren...');
      try {
        const res = await fetch('/api/validate/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, model })
        });
        const data = await res.json();
        setBadge('geminiBadge', data.success ? 'valid' : 'invalid', data.success ? '✓ Actief' : '✕ Ongeldig');
      } catch (e) { setBadge('geminiBadge', 'invalid', '✕ Fout'); }
    }

    async function checkOpenSubtitles() {
      const apiKey = document.getElementById('osApiKey').value.trim();
      const username = document.getElementById('osUsername').value.trim();
      const password = document.getElementById('osPassword').value.trim();
      if (!apiKey) return alert('Vul eerst een OpenSubtitles API Key in.');
      setBadge('osBadge', 'loading', '⏳ Verifiëren...');
      try {
        const res = await fetch('/api/validate/opensubtitles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, username, password })
        });
        const data = await res.json();
        setBadge('osBadge', data.success ? 'valid' : 'invalid', data.success ? ('✓ ' + data.message) : '✕ Mislukt');
      } catch (e) { setBadge('osBadge', 'invalid', '✕ Fout'); }
    }

    async function checkSubDL() {
      const apiKey = document.getElementById('subdlKey').value.trim();
      if (!apiKey) return alert('Vul een SubDL API-sleutel in.');
      setBadge('subdlBadge', 'loading', '⏳ Controleren...');
      try {
        const res = await fetch('/api/validate/subdl', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey })
        });
        const data = await res.json();
        setBadge('subdlBadge', data.success ? 'valid' : 'invalid', data.success ? '✓ Actief' : '✕ Ongeldig');
      } catch (e) { setBadge('subdlBadge', 'invalid', '✕ Fout'); }
    }

    async function checkSubSource() {
      const apiKey = document.getElementById('subsourceKey').value.trim();
      if (!apiKey) return alert('Vul een SubSource API-sleutel in.');
      setBadge('subsourceBadge', 'loading', '⏳ Controleren...');
      try {
        const res = await fetch('/api/validate/subsource', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey })
        });
        const data = await res.json();
        setBadge('subsourceBadge', data.success ? 'valid' : 'invalid', data.success ? '✓ Actief' : '✕ Ongeldig');
      } catch (e) { setBadge('subsourceBadge', 'invalid', '✕ Fout'); }
    }

    function generateManifestUrl() {
      const config = {
        enableAi: true,
        geminiKey: document.getElementById('geminiKey').value.trim(),
        geminiModel: document.getElementById('geminiModel').value,
        osApiKey: document.getElementById('osApiKey').value.trim(),
        osUsername: document.getElementById('osUsername').value.trim(),
        osPassword: document.getElementById('osPassword').value.trim(),
        subsourceKey: document.getElementById('subsourceKey').value.trim(),
        subdlKey: document.getElementById('subdlKey').value.trim(),
      };
      const encoded = btoa(JSON.stringify(config)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      return window.location.origin + '/' + encoded + '/manifest.json';
    }

    function installAddon() {
      const url = generateManifestUrl();
      window.location.href = url.replace(/^https?:\\/\\//, 'stremio://');
    }

    function copyManifestUrl() {
      navigator.clipboard.writeText(generateManifestUrl()).then(() => alert('Manifest link gekopieerd!'));
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SubNova AI met OpenSubtitles draait op poort ${PORT}`);
});

