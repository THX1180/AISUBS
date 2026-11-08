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

// MongoDB Setup met fail-safe
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
      .catch(err => console.error('⚠️ MongoDB connectiefout (draait zonder cache):', err.message));
  } catch (err) {
    console.error('⚠️ Ongeldige MongoDB URL:', err.message);
  }
}

// Caches & Actieve Jobs
const osTokenCache = new Map();
const activeTranslationJobs = new Set();

// Helper: URL-Safe Base64 configuratie parser
function parseConfig(rawConfig) {
  if (!rawConfig) return {};
  try {
    let str = rawConfig.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const decoded = Buffer.from(str, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    return {};
  }
}

// Helper: Timestamp formattering voor WebVTT (hh:mm:ss.000)
function formatVttTimestamp(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}.000`;
}

// Genereert een WebVTT bericht dat gedurende de hele film (4 uur) zichtbaar is
function generateWaitingVtt() {
  let vtt = 'WEBVTT\n\n';
  const totalSeconds = 4 * 3600; // 4 uur dekkend voor elke film of serie
  let idx = 1;
  for (let s = 0; s < totalSeconds; s += 20) {
    const t1 = formatVttTimestamp(s);
    const t2 = formatVttTimestamp(s + 10);
    const t3 = formatVttTimestamp(s + 19);
    vtt += `${idx++}\n${t1} --> ${t2}\n⏳ [SubNova AI] Uw subs worden nu vertaald door Gemini AI...\n\n`;
    vtt += `${idx++}\n${t2} --> ${t3}\n✨ Kies deze subs over enkele ogenblikken opnieuw in het menu!\n\n`;
  }
  return vtt;
}

// OpenSubtitles login token cache
async function getOpenSubtitlesToken(apiKey, username, password) {
  if (!apiKey || !username || !password) return null;
  const cacheKey = `${apiKey}_${username}`;
  const cached = osTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  try {
    const res = await axios.post('https://api.opensubtitles.com/api/v1/login', { username, password }, {
      headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'SubNova-v1.0' },
      timeout: 5000
    });
    if (res.data?.token) {
      osTokenCache.set(cacheKey, { token: res.data.token, expiresAt: Date.now() + 20 * 60 * 60 * 1000 });
      return res.data.token;
    }
  } catch (err) {
    console.error('OpenSubtitles Login Fout:', err.message);
  }
  return null;
}

// ================= LIVE VALIDATIE ENDPOINTS ================= //

app.post('/api/validate/gemini', async (req, res) => {
  const { apiKey, model } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'Vul een API-sleutel in' });
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const m = genAI.getGenerativeModel({ model: model || 'gemini-3.5-flash-lite' });
    await m.countTokens('Test validatie');
    return res.json({ success: true, message: 'Google Gemini API is actief en geldig!' });
  } catch (err) {
    return res.json({ success: false, error: err.message?.includes('API_KEY_INVALID') ? 'Ongeldige API-sleutel' : (err.message || 'Verbinding mislukt') });
  }
});

app.post('/api/validate/opensubtitles', async (req, res) => {
  const { apiKey, username, password } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'OpenSubtitles API Key ontbreekt' });
  try {
    if (username && password) {
      const loginRes = await axios.post('https://api.opensubtitles.com/api/v1/login', { username, password }, {
        headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'SubNova-v1.0' },
        timeout: 6000
      });
      if (loginRes.data?.token) {
        const user = loginRes.data.user || {};
        const vip = user.vip ? ' (VIP)' : ' (Standaard)';
        return res.json({ success: true, message: `Ingelogd als ${user.username || username}${vip}!` });
      }
    } else {
      await axios.get('https://api.opensubtitles.com/api/v1/infos/formats', {
        headers: { 'Api-Key': apiKey, 'User-Agent': 'SubNova-v1.0' }, timeout: 5000
      });
      return res.json({ success: true, message: 'API Key is geldig!' });
    }
  } catch (err) {
    return res.json({ success: false, error: err.response?.data?.message || 'Controle mislukt' });
  }
});

app.post('/api/validate/subdl', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'SubDL API Key ontbreekt' });
  try {
    const checkRes = await axios.get('https://api.subdl.com/api/v1/subtitles', {
      params: { api_key: apiKey, imdb_id: 'tt0111161' }, timeout: 5000
    });
    if (checkRes.data?.status === true || checkRes.data?.subtitles) {
      return res.json({ success: true, message: 'SubDL API is actief!' });
    }
    return res.json({ success: false, error: 'Ongeldige SubDL sleutel' });
  } catch (err) {
    return res.json({ success: false, error: 'Verbinding mislukt' });
  }
});

app.post('/api/validate/subsource', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'SubSource API Key ontbreekt' });
  try {
    await axios.get('https://api.subsource.net/api/v1/subtitles', {
      params: { imdb_id: 'tt0111161', lang: 'english' },
      headers: { 'X-API-Key': apiKey }, timeout: 5000
    });
    return res.json({ success: true, message: 'SubSource API is actief!' });
  } catch (err) {
    return res.json({ success: false, error: 'Verbinding mislukt' });
  }
});

// ================= ZOEK & VERTAAL LOGICA ================= //

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
      release: item.id || 'Standaard Match',
      directUrl: item.url
    }));
  } catch (err) { return []; }
}

async function fetchOpenSubtitlesApi(numericImdb, season, episode, config) {
  const apiKey = config.openSubtitlesKey || process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) return [];
  try {
    const params = { imdb_id: numericImdb, languages: 'nl,en' };
    if (season && episode) { params.season_number = season; params.episode_number = episode; }
    const res = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      params, headers: { 'Api-Key': apiKey, 'User-Agent': 'SubNova-v1.0' }, timeout: 4000
    });
    return (res.data?.data || []).map(item => ({
      source: 'OpenSubtitles VIP',
      id: item.attributes.files?.[0]?.file_id,
      lang: item.attributes.language,
      release: item.attributes.release || item.attributes.movie_name,
      fileId: item.attributes.files?.[0]?.file_id,
      apiKey: apiKey,
      osUser: config.openSubtitlesUser,
      osPass: config.openSubtitlesPass
    })).filter(s => s.fileId);
  } catch (err) { return []; }
}

async function fetchSubDL(imdbId, season, episode, userKey) {
  const apiKey = userKey || process.env.SUBDL_API_KEY;
  if (!apiKey) return [];
  try {
    const params = { api_key: apiKey, imdb_id: imdbId, languages: 'nl,en', type: season ? 'tv' : 'movie' };
    if (season && episode) { params.season_number = season; params.episode_number = episode; }
    const res = await axios.get('https://api.subdl.com/api/v1/subtitles', { params, timeout: 4000 });
    return (res.data?.subtitles || []).map(item => ({
      source: 'SubDL',
      id: item.url,
      lang: item.lang?.toLowerCase().startsWith('dut') || item.lang?.toLowerCase().startsWith('nl') ? 'nl' : 'en',
      release: item.release_name || item.name,
      directUrl: `https://dl.subdl.com${item.url}`
    }));
  } catch (err) { return []; }
}

async function fetchSubSource(imdbId, season, episode, userKey) {
  const apiKey = userKey || process.env.SUBSOURCE_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await axios.get('https://api.subsource.net/api/v1/subtitles', {
      params: { imdb_id: imdbId, lang: 'dutch,english' },
      headers: { 'X-API-Key': apiKey }, timeout: 4000
    });
    return (res.data?.subtitles || []).map(item => ({
      source: 'SubSource',
      id: item.id,
      lang: item.lang?.toLowerCase().includes('dutch') ? 'nl' : 'en',
      release: item.release_name || item.movie_name,
      downloadUrl: `https://api.subsource.net/api/v1/subtitles/${item.id}/download`,
      apiKey
    }));
  } catch (err) { return []; }
}

async function translateSrtWithGemini(srtContent, geminiKey, customModel) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Geen Gemini API Key beschikbaar');

  const modelName = customModel || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  const prompt = `Je bent een meester filmvertaler. Vertaal de onderstaande Engelse SRT ondertiteling naar natuurlijk, hedendaags Nederlands.
Regels:
1. Behoud exact de originele nummers en timestamps (bijv. 00:01:20,000 --> 00:01:23,000).
2. Vertaal alleen de gesproken dialogen.
3. Geef direct en UITSLUITEND de geldige SRT output terug, zonder inleiding, uitleg of markdown blocks (\`\`\` of \`\`\`srt).

SRT Inhoud:
${srtContent}`;

  const result = await model.generateContent(prompt);
  let translatedText = result.response.text();
  return translatedText.replace(/^```(?:srt)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function srtToVtt(srtText) {
  return 'WEBVTT\n\n' + srtText
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// ================= STREMIO ROUTES ================= //

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
  const numericImdb = imdbId ? imdbId.replace('tt', '') : '';

  const [pubResults, osResults, dlResults, ssResults] = await Promise.allSettled([
    fetchOpenSubtitlesPublic(type, id, extra),
    fetchOpenSubtitlesApi(numericImdb, season, episode, config),
    fetchSubDL(imdbId, season, episode, config.subdlKey),
    fetchSubSource(imdbId, season, episode, config.subsourceKey)
  ]);

  const allSubs = [
    ...(pubResults.status === 'fulfilled' ? pubResults.value : []),
    ...(osResults.status === 'fulfilled' ? osResults.value : []),
    ...(dlResults.status === 'fulfilled' ? dlResults.value : []),
    ...(ssResults.status === 'fulfilled' ? ssResults.value : [])
  ];

  const nlSubs = allSubs.filter(s => s.lang === 'nl');
  const enSubs = allSubs.filter(s => s.lang === 'en');

  let subtitles = [];

  if (nlSubs.length > 0) {
    subtitles = nlSubs.map((sub, idx) => ({
      id: `nl_${sub.source}_${idx}`,
      url: sub.directUrl || `${host}/sub/stream?data=${encodeURIComponent(JSON.stringify(sub))}`,
      lang: 'dut',
      label: `[${sub.source}] ${sub.release || 'Nederlands'}`
    }));
  } else if (enSubs.length > 0 && config.enableAi !== false) {
    subtitles = enSubs.slice(0, 3).map((sub, idx) => {
      const translationPayload = encodeURIComponent(JSON.stringify({
        ...sub,
        mediaId: id,
        geminiKey: config.geminiKey,
        geminiModel: config.geminiModel
      }));

      return {
        id: `ai_nl_${idx}`,
        url: `${host}/sub/translate?data=${translationPayload}`,
        lang: 'dut',
        label: `[AI NL • Gemini] ${sub.release || 'Vertaald uit Engels'}`
      };
    });
  }

  res.setHeader('Cache-Control', 'max-age=3600, stale-while-revalidate=86400');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({ subtitles });
});

// Stream endpoint voor directe Nederlandse subs
app.get('/sub/stream', async (req, res) => {
  try {
    const sub = JSON.parse(decodeURIComponent(req.query.data));
    let srtText = '';

    if (sub.fileId && sub.apiKey) {
      const headers = { 'Api-Key': sub.apiKey, 'User-Agent': 'SubNova-v1.0' };
      if (sub.osUser && sub.osPass) {
        const token = await getOpenSubtitlesToken(sub.apiKey, sub.osUser, sub.osPass);
        if (token) headers['Authorization'] = `Bearer ${token}`;
      }
      const dl = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: sub.fileId }, { headers });
      const fileRes = await axios.get(dl.data.link, { responseType: 'text' });
      srtText = fileRes.data;
    } else if (sub.directUrl) {
      const fileRes = await axios.get(sub.directUrl, { responseType: 'text' });
      srtText = fileRes.data;
    }

    const vttContent = srtText.includes('WEBVTT') ? srtText : srtToVtt(srtText);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vttContent);
  } catch (err) {
    res.status(500).send('Fout bij streamen van ondertitel');
  }
});

// ================= ASYNCHRONE AI VERTALING MET LIVE STATUS IN BEELD ================= //

app.get('/sub/translate', async (req, res) => {
  try {
    const data = JSON.parse(decodeURIComponent(req.query.data));
    const cacheKey = `ai_nl_${data.mediaId}_${data.id || data.fileId || 'default'}`;

    // 1. Is de vertaling al gereed in MongoDB? Serveer direct de echte ondertitels!
    if (db) {
      try {
        const cached = await db.collection('translations').findOne({ cacheKey });
        if (cached && cached.vtt) {
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          return res.send(cached.vtt);
        }
      } catch (e) {}
    }

    // 2. Is de vertaling nog bezig of moet hij gestart worden?
    if (!activeTranslationJobs.has(cacheKey)) {
      activeTranslationJobs.add(cacheKey);

      // Start vertaling op de achtergrond
      (async () => {
        try {
          console.log(`[SubNova] Achtergrondvertaling gestart voor ${cacheKey}`);
          let rawSrt = '';

          if (data.directUrl) {
            const fileRes = await axios.get(data.directUrl, { responseType: 'text', timeout: 8000 });
            rawSrt = fileRes.data;
          } else if (data.fileId && data.apiKey) {
            const headers = { 'Api-Key': data.apiKey, 'User-Agent': 'SubNova-v1.0' };
            if (data.osUser && data.osPass) {
              const token = await getOpenSubtitlesToken(data.apiKey, data.osUser, data.osPass);
              if (token) headers['Authorization'] = `Bearer ${token}`;
            }
            const dl = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: data.fileId }, { headers });
            const fileRes = await axios.get(dl.data.link, { responseType: 'text' });
            rawSrt = fileRes.data;
          }

          if (rawSrt) {
            const translatedSrt = await translateSrtWithGemini(rawSrt, data.geminiKey, data.geminiModel);
            const vttContent = srtToVtt(translatedSrt);

            if (db) {
              await db.collection('translations').updateOne(
                { cacheKey },
                { $set: { cacheKey, vtt: vttContent, createdAt: new Date() } },
                { upsert: true }
              );
              console.log(`[SubNova] Vertaling voltooid en opgeslagen in MongoDB voor ${cacheKey}`);
            }
          }
        } catch (err) {
          console.error('[SubNova] Achtergrondvertaalfout:', err.message);
        } finally {
          activeTranslationJobs.delete(cacheKey);
        }
      })();
    }

    // 3. Toon direct het live melding-bericht in beeld tijdens het afspelen!
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(generateWaitingVtt());
  } catch (err) {
    console.error('Vertaalfout:', err.message);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(generateWaitingVtt());
  }
});

// ================= MODERNE CONFIGURATIE INTERFACE ================= //

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
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(56, 189, 248, 0.12);
      color: var(--primary);
      border: 1px solid rgba(56, 189, 248, 0.25);
      padding: 5px 14px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
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
      width: 100%;
      background: rgba(10, 15, 26, 0.8);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 105px 12px 14px;
      color: var(--text);
      font-size: 0.95rem;
      transition: all 0.2s;
    }
    .input-wrapper input:focus, select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }
    .input-actions { position: absolute; right: 8px; display: flex; align-items: center; gap: 6px; }
    .icon-btn { background: transparent; border: none; color: var(--muted); cursor: pointer; padding: 6px; border-radius: 8px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
    .icon-btn:hover { color: var(--text); background: rgba(255, 255, 255, 0.08); }
    .check-btn { background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.25); color: var(--primary); font-size: 0.75rem; font-weight: 700; padding: 5px 10px; border-radius: 8px; cursor: pointer; transition: all 0.15s; }
    .check-btn:hover { background: var(--primary); color: #04101e; }
    .hint { font-size: 0.75rem; color: var(--muted); margin-top: 4px; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .actions { display: flex; flex-direction: column; gap: 12px; margin-top: 32px; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px 20px; border-radius: 14px; font-weight: 700; font-size: 0.95rem; cursor: pointer; text-decoration: none; border: none; transition: all 0.2s; }
    .btn-primary { background: linear-gradient(135deg, #38bdf8 0%, #3b82f6 100%); color: #04101e; box-shadow: 0 10px 25px -5px var(--primary-glow); }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 15px 30px -5px var(--primary-glow); }
    .btn-secondary { background: rgba(255, 255, 255, 0.05); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.1); }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="badge">✨ Live API Verificatie Actief</div>
      <h1 class="title">SubNova <span>AI</span></h1>
      <p class="subtitle">Multi-source Nederlandse ondertitels met automatische Gemini AI fallback</p>
    </div>

    <!-- Gemini AI -->
    <div class="section-title">1. AI Vertaalmotor (Google Gemini)</div>
    <div class="field-group">
      <div class="field-header">
        <label for="geminiKey">Gemini API Key</label>
        <span id="geminiBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="geminiKey" placeholder="AIzaSy..." value="${cfg.geminiKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('geminiKey')" title="Toon/Verberg">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="check-btn" onclick="checkGemini()">Controleer</button>
        </div>
      </div>
      <div class="hint">Gratis te verkrijgen via <a href="https://aistudio.google.com" target="_blank" style="color:var(--primary);">aistudio.google.com</a>.</div>
    </div>

    <div class="field-group">
      <label style="font-size:0.85rem; font-weight:600; margin-bottom:6px; display:block;">Model</label>
      <select id="geminiModel">
        <option value="gemini-3.5-flash-lite" ${cfg.geminiModel === 'gemini-3.5-flash-lite' ? 'selected' : ''}>gemini-3.5-flash-lite (Aanbevolen: snelst & laagste latency)</option>
        <option value="gemini-2.5-flash" ${cfg.geminiModel === 'gemini-2.5-flash' ? 'selected' : ''}>gemini-2.5-flash</option>
      </select>
    </div>

    <!-- OpenSubtitles -->
    <div class="section-title">2. OpenSubtitles.com (Optioneel – Public v3 is standaard actief)</div>
    <div class="field-group">
      <div class="field-header">
        <label for="osApiKey">API Key</label>
        <span id="osBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="osApiKey" placeholder="Jouw OpenSubtitles API Key" value="${cfg.openSubtitlesKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('osApiKey')" title="Toon/Verberg">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="check-btn" onclick="checkOpenSubtitles()">Controleer</button>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="field-group">
        <div class="field-header"><label for="osUser">Gebruikersnaam</label></div>
        <div class="input-wrapper">
          <input type="text" id="osUser" placeholder="Gebruikersnaam" value="${cfg.openSubtitlesUser || ''}" style="padding-right: 14px;">
        </div>
      </div>
      <div class="field-group">
        <div class="field-header"><label for="osPass">Wachtwoord</label></div>
        <div class="input-wrapper">
          <input type="password" id="osPass" placeholder="Wachtwoord" value="${cfg.openSubtitlesPass || ''}">
          <div class="input-actions">
            <button class="icon-btn" onclick="toggleVisibility('osPass')" title="Toon/Verberg">
              <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="hint" style="margin-top:-8px; margin-bottom:16px;">Met je login ontvang je jouw eigen downloadlimiet (20/dag of onbeperkt voor VIP).</div>

    <!-- SubDL & SubSource -->
    <div class="section-title">3. Overige Bronnen (Optioneel)</div>
    <div class="field-group">
      <div class="field-header">
        <label for="subdlKey">SubDL API Key</label>
        <span id="subdlBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="subdlKey" placeholder="SubDL API key" value="${cfg.subdlKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('subdlKey')">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="check-btn" onclick="checkSubDL()">Controleer</button>
        </div>
      </div>
    </div>

    <div class="field-group">
      <div class="field-header">
        <label for="subsourceKey">SubSource API Key</label>
        <span id="subsourceBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="subsourceKey" placeholder="SubSource API key" value="${cfg.subsourceKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('subsourceKey')">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="check-btn" onclick="checkSubSource()">Controleer</button>
        </div>
      </div>
    </div>

    <!-- Acties -->
    <div class="actions">
      <button class="btn btn-primary" onclick="installAddon()">Installeer in Stremio</button>
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
        if (data.success) {
          setBadge('geminiBadge', 'valid', '✓ Geldig & Actief');
        } else {
          setBadge('geminiBadge', 'invalid', '✕ ' + (data.error || 'Ongeldig'));
        }
      } catch (e) {
        setBadge('geminiBadge', 'invalid', '✕ Serverfout');
      }
    }

    async function checkOpenSubtitles() {
      const apiKey = document.getElementById('osApiKey').value.trim();
      const username = document.getElementById('osUser').value.trim();
      const password = document.getElementById('osPass').value.trim();
      if (!apiKey) return alert('Vul eerst een OpenSubtitles API-sleutel in.');
      setBadge('osBadge', 'loading', '⏳ Inloggen...');
      try {
        const res = await fetch('/api/validate/opensubtitles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, username, password })
        });
        const data = await res.json();
        if (data.success) {
          setBadge('osBadge', 'valid', '✓ ' + data.message);
        } else {
          setBadge('osBadge', 'invalid', '✕ ' + (data.error || 'Inloggen mislukt'));
        }
      } catch (e) {
        setBadge('osBadge', 'invalid', '✕ Verbinding mislukt');
      }
    }

    async function checkSubDL() {
      const apiKey = document.getElementById('subdlKey').value.trim();
      if (!apiKey) return alert('Vul eerst een SubDL API-sleutel in.');
      setBadge('subdlBadge', 'loading', '⏳ Controleren...');
      try {
        const res = await fetch('/api/validate/subdl', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey })
        });
        const data = await res.json();
        if (data.success) {
          setBadge('subdlBadge', 'valid', '✓ Actief');
        } else {
          setBadge('subdlBadge', 'invalid', '✕ ' + (data.error || 'Ongeldig'));
        }
      } catch (e) {
        setBadge('subdlBadge', 'invalid', '✕ Fout');
      }
    }

    async function checkSubSource() {
      const apiKey = document.getElementById('subsourceKey').value.trim();
      if (!apiKey) return alert('Vul eerst een SubSource API-sleutel in.');
      setBadge('subsourceBadge', 'loading', '⏳ Controleren...');
      try {
        const res = await fetch('/api/validate/subsource', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey })
        });
        const data = await res.json();
        if (data.success) {
          setBadge('subsourceBadge', 'valid', '✓ Actief');
        } else {
          setBadge('subsourceBadge', 'invalid', '✕ ' + (data.error || 'Ongeldig'));
        }
      } catch (e) {
        setBadge('subsourceBadge', 'invalid', '✕ Fout');
      }
    }

    function generateManifestUrl() {
      const config = {
        enableAi: true,
        geminiKey: document.getElementById('geminiKey').value.trim(),
        geminiModel: document.getElementById('geminiModel').value,
        openSubtitlesKey: document.getElementById('osApiKey').value.trim(),
        openSubtitlesUser: document.getElementById('osUser').value.trim(),
        openSubtitlesPass: document.getElementById('osPass').value.trim(),
        subdlKey: document.getElementById('subdlKey').value.trim(),
        subsourceKey: document.getElementById('subsourceKey').value.trim(),
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
  console.log(`🚀 SubNova AI met live vertaal-status draait op poort ${PORT}`);
});
