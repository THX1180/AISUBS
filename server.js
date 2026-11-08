require('dotenv').config();
const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold
} = require('@google/generative-ai');
const manifest = require('./manifest');

const app = express();
const PORT = process.env.PORT || 7860;

// FIX 1: Render terminates TLS at a proxy. Without this, req.protocol is "http"
app.set('trust proxy', true);

// Log every request so problems are visible in Render logs
app.use((req, res, next) => {
  if (!req.path.startsWith('/health')) {
    console.log(`➡️ ${req.method} ${req.path.slice(0, 80)}`);
  }
  next();
});

process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Always hand out https URLs for subtitle files
function getHost(req) {
  const fixed = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (fixed) return fixed.replace(/\/+$/, '');
  return `https://${req.get('host')}`;
}

// ---------- MongoDB ----------
let db = null;
if (process.env.MONGODB_URI) {
  try {
    const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10 });
    client.connect()
      .then(async () => {
        db = client.db('subnova_cache');
        await db.collection('translations')
          .createIndex({ cacheKey: 1 }, { unique: true });
        console.log('✅ Verbonden met MongoDB Cache');
      })
      .catch((err) => console.error('⚠️ MongoDB fout:', err.message));
  } catch (err) {
    console.error('⚠️ Ongeldige MongoDB URL:', err.message);
  }
}

const osTokenCache = new Map();
const memCache = new Map();      // fallback when Mongo is unavailable
const inflight = new Map();      // running translation jobs
const failed = new Map();        // cacheKey -> expiry timestamp

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

// ---------- Payload encryption (keeps API keys out of readable URLs) ----------
const SECRET = crypto
  .createHash('sha256')
  .update(process.env.PAYLOAD_SECRET || 'subnova-default-secret-change-me')
  .digest();

function encryptPayload(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(obj), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decryptPayload(str) {
  const buf = Buffer.from(str, 'base64url');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

const withTimeout = (promise, ms = 7000) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve([]), ms))]);

const safetySettings = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));

// ---------- SRT -> WebVTT ----------
function srtToVtt(srtText) {
  if (!srtText || typeof srtText !== 'string') {
    return 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n[Geen subs]\n\n';
  }
  let clean = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (clean.charCodeAt(0) === 0xFEFF) clean = clean.substring(1);
  if (clean.startsWith('WEBVTT')) return clean + '\n';
  const converted = clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${converted}\n`;
}

// Decode as UTF-8, fall back to latin1 (covers most windows-1252 Dutch SRTs)
function decodeText(buffer) {
  const utf8 = buffer.toString('utf8');
  return utf8.includes('\uFFFD') ? buffer.toString('latin1') : utf8;
}

// ---------- Gemini (chunked + parallel, so it finishes in ~30-60s) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function splitSrt(raw, size = 100) {
  const blocks = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n{2,}/);
  const chunks = [];
  for (let i = 0; i < blocks.length; i += size) {
    chunks.push(blocks.slice(i, i + size).join('\n\n'));
  }
  return chunks;
}

const countCues = (t) => (t.match(/-->/g) || []).length;

async function translateChunk(genAI, modelNames, chunk, idx) {
  const prompt = `Je bent een filmvertaler. Vertaal deze Engelse SRT-fragmenten naar natuurlijk Nederlands.
REGELS:
1. Behoud exact alle nummers en timestamps.
2. Wijzig de tijdcodes nooit en laat geen blok weg.
3. Vertaal uitsluitend dialoog.
4. Geef alleen de SRT terug, geen introductie of markdown.

SRT:
${chunk}`;

  const expected = countCues(chunk);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const modelName of modelNames) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          safetySettings,
          generationConfig: { maxOutputTokens: 16384, temperature: 0.1 }
        });
        const result = await model.generateContent(prompt);
        const text = result.response.text()
          .replace(/^```(?:srt)?\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();
        if (countCues(text) >= Math.floor(expected * 0.9)) return text;
        throw new Error(`blok ${idx}: ${countCues(text)}/${expected} cues terug`);
      } catch (err) {
        console.error(`[Gemini] ${modelName} chunk ${idx} faalde:`, err.message);
        lastErr = err;
      }
    }
    await sleep(1500);
  }
  console.error(`[Gemini] chunk ${idx} blijft Engels:`, lastErr && lastErr.message);
  return chunk; // fall back to English for this chunk instead of failing entirely
}

async function translateFullSrtWithGemini(rawSrt, geminiKey, preferredModel) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Geen Gemini API Key beschikbaar');

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelNames = [...new Set([
    preferredModel,
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
  ].filter(Boolean))];

  const chunks = splitSrt(rawSrt, 100);
  console.log(`[Gemini] ${chunks.length} delen vertalen (${modelNames.join(', ')})`);

  const results = new Array(chunks.length);
  let next = 0;
  const CONCURRENCY = 4;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
      while (next < chunks.length) {
        const idx = next++;
        results[idx] = await translateChunk(genAI, modelNames, chunks[idx], idx);
      }
    })
  );
  return results.join('\n\n');
}

// ================= VALIDATIE ENDPOINTS ================= //

app.post('/api/validate/gemini', async (req, res) => {
  const { apiKey, model } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'Vul een sleutel in' });
  try {
    const genAI = new GoogleGenerativeAI(apiKey.trim());
    const m = genAI.getGenerativeModel({ model: model || 'gemini-2.5-flash' });
    await m.countTokens('Test');
    return res.json({ success: true, message: 'Gemini API is actief!' });
  } catch (err) {
    console.error('[Gemini validate]', err.message);
    return res.json({ success: false, error: 'Ongeldige Gemini sleutel of model' });
  }
});

app.post('/api/validate/opensubtitles', async (req, res) => {
  const { apiKey, username, password } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'API Key ontbreekt' });
  try {
    if (username && password) {
      const loginRes = await axios.post(
        'https://api.opensubtitles.com/api/v1/login',
        { username: username.trim(), password: password.trim() },
        {
          headers: {
            'Api-Key': apiKey.trim(),
            'Content-Type': 'application/json',
            'User-Agent': 'SubNova-v2.0'
          },
          timeout: 6000
        }
      );
      if (loginRes.data?.token) {
        const u = loginRes.data.user?.username || username;
        return res.json({ success: true, message: `Ingelogd als ${u}!` });
      }
      return res.json({ success: false, error: 'Inloggen mislukt' });
    }
    await axios.get('https://api.opensubtitles.com/api/v1/infos/formats', {
      headers: { 'Api-Key': apiKey.trim(), 'User-Agent': 'SubNova-v2.0' },
      timeout: 5000
    });
    return res.json({ success: true, message: 'API Key is geldig!' });
  } catch (err) {
    return res.json({ success: false, error: 'Inloggen mislukt' });
  }
});

app.post('/api/validate/subdl', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'Key ontbreekt' });
  try {
    const r = await axios.get('https://api.subdl.com/api/v1/subtitles', {
      params: { api_key: apiKey.trim(), imdb_id: 'tt0111161' },
      timeout: 5000
    });
    if (r.data?.status === true || r.data?.subtitles) {
      return res.json({ success: true, message: 'SubDL API is actief!' });
    }
    return res.json({ success: false, error: 'Ongeldige SubDL sleutel' });
  } catch (err) {
    return res.json({ success: false, error: 'Verbinding mislukt' });
  }
});

app.post('/api/validate/subsource', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'Key ontbreekt' });
  const key = apiKey.trim();
  try {
    const r = await axios.get('https://api.subsource.net/api/v1/subtitles/recent', {
      headers: { 'X-API-Key': key, 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      params: { api_key: key },
      timeout: 7000
    });
    if (r.status === 200) {
      return res.json({ success: true, message: 'SubSource is actief!' });
    }
  } catch (err) {
    return res.json({ success: false, error: 'SubSource mislukt' });
  }
  return res.json({ success: false, error: 'Geen reactie' });
});

// ================= SUBTITLE BRONNEN ================= //

async function getOpenSubtitlesToken(apiKey, username, password) {
  if (!apiKey || !username || !password) return null;
  const cacheKey = `${apiKey.trim()}_${username.trim()}`;
  const cached = osTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  try {
    const res = await axios.post(
      'https://api.opensubtitles.com/api/v1/login',
      { username: username.trim(), password: password.trim() },
      {
        headers: {
          'Api-Key': apiKey.trim(),
          'Content-Type': 'application/json',
          'User-Agent': 'SubNova-v2.0'
        },
        timeout: 5000
      }
    );
    if (res.data?.token) {
      osTokenCache.set(cacheKey, {
        token: res.data.token,
        expiresAt: Date.now() + 23 * 3600 * 1000
      });
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
    const token = await getOpenSubtitlesToken(
      apiKey,
      osUsername || process.env.OPENSUBTITLES_USERNAME,
      osPassword || process.env.OPENSUBTITLES_PASSWORD
    );
    const headers = { 'Api-Key': apiKey.trim(), 'User-Agent': 'SubNova-v2.0' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const params = { imdb_id: cleanImdb, languages: 'nl,en' };
    if (season && episode) {
      params.season_number = season;
      params.episode_number = episode;
      params.type = 'episode';
    } else {
      params.type = 'movie';
    }

    const res = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
      headers,
      params,
      timeout: 4500
    });
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
        lang: lang === 'nl' || lang === 'dut' ? 'nl' : 'en',
        release: item.attributes?.release || 'OpenSubtitles Match',
        osApiKey: apiKey.trim()
      });
    }
    return results;
  } catch (err) {
    console.error('[OpenSubtitles official]', err.message);
    return [];
  }
}

async function fetchOpenSubtitlesPublic(type, id, extra) {
  try {
    const safeId = encodeURIComponent(id).replace(/%3A/gi, ':');
    const url = extra
      ? `https://opensubtitles-v3.strem.io/subtitles/${type}/${safeId}/${encodeURIComponent(extra)}.json`
      : `https://opensubtitles-v3.strem.io/subtitles/${type}/${safeId}.json`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 4000
    });
    return (res.data?.subtitles || []).map((item) => ({
      source: 'OpenSubtitles',
      id: item.id,
      lang:
        item.lang === 'dut' || item.lang === 'nld' || item.lang === 'nl'
          ? 'nl'
          : item.lang === 'eng' || item.lang === 'en'
            ? 'en'
            : item.lang,
      release: String(item.id || 'Gesynchroniseerd'),
      directUrl: item.url
    }));
  } catch (err) {
    console.error('[OpenSubtitles public]', err.message);
    return [];
  }
}

async function fetchSubDL(imdbId, season, episode, userKey) {
  const apiKey = userKey || process.env.SUBDL_API_KEY;
  if (!apiKey) return [];
  try {
    const params = {
      api_key: apiKey.trim(),
      imdb_id: imdbId,
      languages: 'NL,EN',
      type: season ? 'tv' : 'movie'
    };
    if (season && episode) {
      params.season_number = season;
      params.episode_number = episode;
    }
    const res = await axios.get('https://api.subdl.com/api/v1/subtitles', {
      params,
      timeout: 4000
    });
    return (res.data?.subtitles || []).map((item) => {
      const l = (item.lang || item.language || '').toLowerCase();
      return {
        source: 'SubDL',
        id: item.url,
        lang: l.startsWith('nl') || l.startsWith('dut') ? 'nl' : 'en',
        release: item.release_name || item.name || 'SubDL Match',
        directUrl: `https://dl.subdl.com${item.url}`
      };
    });
  } catch (err) {
    console.error('[SubDL]', err.message);
    return [];
  }
}

async function fetchSubSource(imdbId, userKey) {
  const apiKey = userKey || process.env.SUBSOURCE_API_KEY;
  if (!apiKey) return [];
  const key = apiKey.trim();
  try {
    const sRes = await axios.get('https://api.subsource.net/api/v1/movies/search', {
      params: { query: imdbId, api_key: key },
      headers: { 'X-API-Key': key, 'User-Agent': 'Mozilla/5.0' },
      timeout: 4500
    });
    const movies = sRes.data?.data || sRes.data?.movies || [];
    const movie = movies[0];
    if (!movie || !movie.id) return [];

    const subRes = await axios.get('https://api.subsource.net/api/v1/subtitles', {
      params: { movieId: movie.id, lang: 'dutch,english', api_key: key },
      headers: { 'X-API-Key': key, 'User-Agent': 'Mozilla/5.0' },
      timeout: 4500
    });
    const list = subRes.data?.data || subRes.data?.subtitles || [];
    return list.map((item) => {
      const l = (item.lang || '').toLowerCase();
      return {
        source: 'SubSource',
        id: item.id || item.subId,
        lang: l.includes('dutch') || l === 'nl' ? 'nl' : 'en',
        release: item.release_name || item.name || 'SubSource Match',
        downloadUrl: `https://api.subsource.net/api/v1/subtitles/${item.id || item.subId}/download`,
        apiKey: key
      };
    });
  } catch (err) {
    console.error('[SubSource]', err.message);
    return [];
  }
}

// ---------- Download helper ----------
function extractSubtitle(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntries().find((e) => /\.(srt|vtt)$/i.test(e.entryName));
    if (entry) return decodeText(entry.getData());
  } catch (e) { /* not a zip */ }
  return decodeText(buffer);
}

async function downloadSubtitleText(sub) {
  const bHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Accept: '*/*'
  };

  if (sub.fileId && sub.osApiKey) {
    const headers = {
      'Api-Key': sub.osApiKey,
      'User-Agent': 'SubNova-v2.0',
      'Content-Type': 'application/json'
    };
    const token = await getOpenSubtitlesToken(
      sub.osApiKey,
      sub.osUsername || process.env.OPENSUBTITLES_USERNAME,
      sub.osPassword || process.env.OPENSUBTITLES_PASSWORD
    );
    if (token) headers.Authorization = `Bearer ${token}`;
    const dlRes = await axios.post(
      'https://api.opensubtitles.com/api/v1/download',
      { file_id: sub.fileId },
      { headers, timeout: 8000 }
    );
    if (dlRes.data?.link) {
      const fRes = await axios.get(dlRes.data.link, {
        headers: bHeaders,
        responseType: 'arraybuffer',
        timeout: 8000
      });
      return extractSubtitle(Buffer.from(fRes.data));
    }
  }

  if (sub.downloadUrl && sub.apiKey) {
    const fRes = await axios.get(sub.downloadUrl, {
      headers: { ...bHeaders, 'X-API-Key': sub.apiKey },
      params: { api_key: sub.apiKey },
      responseType: 'arraybuffer',
      timeout: 8000
    });
    return extractSubtitle(Buffer.from(fRes.data));
  }

  if (sub.directUrl) {
    const fRes = await axios.get(sub.directUrl, {
      headers: bHeaders,
      responseType: 'arraybuffer',
      timeout: 8000
    });
    return extractSubtitle(Buffer.from(fRes.data));
  }

  return '';
}

function readPayload(req) {
  let raw = req.query.d || req.query.data;
  if (Array.isArray(raw)) raw = raw[0];
  if (!raw) {
    console.error('[payload] geen d-parameter');
    return null;
  }
  raw = String(raw).trim().replace(/ /g, '+');
  try {
    return decryptPayload(raw);
  } catch (e) {
    console.error('[payload] ontsleutelen mislukt:', e.message, '| lengte:', raw.length);
    return null;
  }
}

function sendVtt(res, body, cache) {
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.send(body);
}

const message = (text) =>
  `WEBVTT\n\n00:00:01.000 --> 00:00:10.000\n${text}\n\n`;

// ---------- Configuration page ----------
const path = require('path');
app.get(['/', '/configure', '/:config/configure'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ================= STREMIO ROUTES ================= //

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  // Make sure the fields Stremio/Nuvio require are always present
  const out = {
    catalogs: [],
    ...manifest,
    resources: manifest.resources || ['subtitles'],
    types: manifest.types || ['movie', 'series'],
    idPrefixes: manifest.idPrefixes || ['tt']
  };
  if (!Array.isArray(out.catalogs)) out.catalogs = [];
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
});

app.get([
  '/subtitles/:type/:id.json',
  '/subtitles/:type/:id/:extra.json',
  '/:config/subtitles/:type/:id.json',
  '/:config/subtitles/:type/:id/:extra.json'
], async (req, res) => {
  const { type, extra, config: rawConfig } = req.params;
  const id = decodeURIComponent(req.params.id || '');
  const config = parseConfig(rawConfig);
  const host = getHost(req);

  let imdbId = id;
  let season = null;
  let episode = null;
  if (id.includes(':')) {
    const parts = id.split(':');
    imdbId = parts[0];
    season = parts[1];
    episode = parts[2];
  }

  const [osOfficial, pubSubs, dlSubs, ssSubs] = await Promise.allSettled([
    withTimeout(fetchOpenSubtitlesOfficial(
      imdbId, season, episode, config.osApiKey, config.osUsername, config.osPassword
    )),
    withTimeout(fetchOpenSubtitlesPublic(type, id, extra)),
    withTimeout(fetchSubDL(imdbId, season, episode, config.subdlKey)),
    withTimeout(fetchSubSource(imdbId, config.subsourceKey))
  ]);

  const val = (r) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []);
  const allSubs = [...val(osOfficial), ...val(pubSubs), ...val(dlSubs), ...val(ssSubs)];

  const nlSubs = allSubs.filter((s) => s.lang === 'nl');
  const enSubs = allSubs.filter((s) => s.lang === 'en');

  const subtitles = [];

  // 1. AI NL translation of the best English sub
  if (enSubs.length > 0) {
    const bestEn = enSubs[0];
    const payload = encryptPayload({
      fileId: bestEn.fileId,
      osApiKey: bestEn.osApiKey,
      osUsername: config.osUsername,
      osPassword: config.osPassword,
      downloadUrl: bestEn.downloadUrl,
      apiKey: bestEn.apiKey,
      directUrl: bestEn.directUrl,
      mediaId: id,
      geminiKey: config.geminiKey,
      geminiModel: config.geminiModel
    });
    const labelTitle = (bestEn.release || 'Sync').slice(0, 25);
    // Pre-warm: start translating now, so it is (nearly) ready when the user picks it
    if (config.geminiKey || process.env.GEMINI_API_KEY) {
      startTranslation({
        fileId: bestEn.fileId,
        osApiKey: bestEn.osApiKey,
        osUsername: config.osUsername,
        osPassword: config.osPassword,
        downloadUrl: bestEn.downloadUrl,
        apiKey: bestEn.apiKey,
        directUrl: bestEn.directUrl,
        mediaId: id,
        geminiKey: config.geminiKey,
        geminiModel: config.geminiModel
      });
    } else {
      console.warn('[config] Geen Gemini key: AI vertaling uitgeschakeld');
    }
    subtitles.push({
      id: 'ai_nl_sync_top',
      url: `${host}/sub/translate.vtt?d=${payload}`,
      lang: 'dut',
      label: `⭐ [AI NL • Gesynchroniseerd] (${labelTitle})`
    });
  }

  // 2. Existing Dutch subs, always proxied so they are valid https WebVTT
  nlSubs.forEach((sub, idx) => {
    const payload = encryptPayload({
      fileId: sub.fileId,
      osApiKey: sub.osApiKey,
      osUsername: config.osUsername,
      osPassword: config.osPassword,
      downloadUrl: sub.downloadUrl,
      apiKey: sub.apiKey,
      directUrl: sub.directUrl
    });
    const cleanSrc = sub.source.replace(/\s+/g, '_');
    subtitles.push({
      id: `nl_${cleanSrc}_${idx}`,
      url: `${host}/sub/stream.vtt?d=${payload}`,
      lang: 'dut',
      label: `[${sub.source}] ${(sub.release || 'NL').slice(0, 30)}`
    });
  });

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Never let clients cache an empty result (cold start / timeout)
  res.setHeader(
    'Cache-Control',
    subtitles.length ? 'max-age=1800, stale-while-revalidate=86400' : 'no-store'
  );
  res.json({ subtitles });
});

// ================= STREAM PROXY ================= //

app.get(['/sub/stream', '/sub/stream.vtt'], async (req, res) => {
  try {
    const sub = readPayload(req);
    if (!sub) return sendVtt(res.status(400), message('Ongeldige link'));
    const rawText = await downloadSubtitleText(sub);
    sendVtt(res, srtToVtt(rawText), 'public, max-age=86400');
  } catch (err) {
    console.error('[stream]', err.message);
    sendVtt(res, message('Fout bij laden'));
  }
});

// ================= TRANSLATE ================= //

async function getCached(cacheKey) {
  if (db) {
    try {
      const doc = await db.collection('translations').findOne({ cacheKey });
      if (doc?.vtt) return doc.vtt;
    } catch (e) {
      console.error('[Mongo read]', e.message);
    }
  }
  return memCache.get(cacheKey) || null;
}

async function saveCached(cacheKey, vtt) {
  memCache.set(cacheKey, vtt);
  if (memCache.size > 50) memCache.delete(memCache.keys().next().value);
  if (db) {
    try {
      await db.collection('translations').updateOne(
        { cacheKey },
        { $set: { cacheKey, vtt, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.error('[Mongo write]', e.message);
    }
  }
}

function cacheKeyFor(data) {
  const rawSrc = data.directUrl || data.downloadUrl || String(data.fileId || '');
  const shortHash = crypto.createHash('sha1').update(rawSrc).digest('hex').slice(0, 16);
  return `ai_nl_${data.mediaId || 'video'}_${shortHash}`;
}

async function runTranslation(cacheKey, data) {
  console.log(`[translate] start ${cacheKey}`);
  const rawSrt = await downloadSubtitleText(data);
  if (!rawSrt || !rawSrt.includes('-->')) throw new Error('Bron-ondertitel is leeg of niet gedownload');
  const translated = await translateFullSrtWithGemini(rawSrt, data.geminiKey, data.geminiModel);
  await saveCached(cacheKey, srtToVtt(translated));
  console.log(`✅ Vertaling klaar: ${cacheKey}`);
}

// Starts a job once; returns the running promise
function startTranslation(data) {
  const cacheKey = cacheKeyFor(data);
  const failUntil = failed.get(cacheKey);
  if (failUntil && Date.now() < failUntil) return { cacheKey, job: null };
  if (!inflight.has(cacheKey)) {
    const job = (async () => {
      if (await getCached(cacheKey)) return;
      await runTranslation(cacheKey, data);
    })()
      .catch((err) => {
        console.error('[translate job] mislukt:', err.message);
        failed.set(cacheKey, Date.now() + 5 * 60 * 1000);
      })
      .finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, job);
  }
  return { cacheKey, job: inflight.get(cacheKey) };
}

app.get(['/sub/translate', '/sub/translate.vtt'], async (req, res) => {
  try {
    const data = readPayload(req);
    if (!data) return sendVtt(res.status(400), message('Ongeldige link'));

    const cacheKey = cacheKeyFor(data);
    let cached = await getCached(cacheKey);
    if (cached) return sendVtt(res, cached, 'public, max-age=86400');

    const failUntil = failed.get(cacheKey);
    if (failUntil && Date.now() < failUntil) {
      return sendVtt(res, message('AI vertaling mislukt. Controleer je Gemini key en probeer later opnieuw'));
    }

    // Start (or join) the job and wait up to 25s, so most requests get the real file
    const { job } = startTranslation(data);
    if (job) await Promise.race([job, sleep(25000)]);

    cached = await getCached(cacheKey);
    if (cached) return sendVtt(res, cached, 'public, max-age=86400');

    if (failed.get(cacheKey) > Date.now()) {
      return sendVtt(res, message('AI vertaling mislukt. Controleer je Gemini key en probeer later opnieuw'));
    }
    return sendVtt(res, message('AI vertaling bezig... Selecteer deze ondertitel over 1 minuut opnieuw'));
  } catch (err) {
    console.error('[translate]', err.message);
    sendVtt(res, message('Fout bij vertalen'));
  }
});

// Health check (also useful for a keep-alive ping on Render)
app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SubNova draait op poort ${PORT} | Gemini env: ${!!process.env.GEMINI_API_KEY} | Mongo: ${!!process.env.MONGODB_URI} | PUBLIC_URL: ${process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'n/a'}`);
});
