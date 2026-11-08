require('dotenv').config();
const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const manifest = require('./manifest');

const app = express();
const PORT = process.env.PORT || 7860;

// Crash preventie en error logging
process.on('uncaughtException', (err) => {
  console.error('❌ Onverwachte fout (uncaughtException):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Onbehandelde promise (unhandledRejection):', reason);
});

// Middleware & Volledige CORS (Cruciaal voor Nuvio Mobile & Stremio)
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
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

// OpenSubtitles login token cache in-memory
const osTokenCache = new Map();

// Helper: URL-Safe Base64 configuratie parser
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

// Veiligheidsinstellingen voor dialogen
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Helper: Converteer willekeurige SRT tekst naar schone WebVTT
function srtToVtt(srtText) {
  if (!srtText) return 'WEBVTT\n\n';
  if (srtText.trim().startsWith('WEBVTT')) return srtText;
  const clean = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return 'WEBVTT\n\n' + clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// 1-Shot Gemini Vertaalmotor
async function translateFullSrtWithGemini(rawSrt, geminiKey, preferredModel) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Geen Gemini API Key beschikbaar');

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = preferredModel || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const model = genAI.getGenerativeModel({
    model: modelName,
    safetySettings,
    generationConfig: {
      maxOutputTokens: 65536,
      temperature: 0.1
    }
  });

  const prompt = `Je bent een professionele filmvertaler. Vertaal de onderstaande Engelse SRT-ondertitels naar natuurlijk, eigentijds Nederlands.
STRIKTE REGELS:
1. Behoud exact alle originele nummers en timestamps (bijv. 00:01:20,000 --> 00:01:23,000).
2. Wijzig de tijdcodes nooit.
3. Vertaal uitsluitend de gesproken tekst.
4. Geef direct de geldige SRT output terug zonder introductie, uitleg of markdown codeblokken (\`\`\` of \`\`\`srt).

SRT:
${rawSrt}`;

  const result = await model.generateContent(prompt);
  let translated = result.response.text();
  return translated.replace(/^```(?:srt)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

// ================= LIVE VALIDATIE ENDPOINTS ================= //

// 1. Gemini Verificatie
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

// 2. OpenSubtitles Verificatie
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
    return res.json({ success: false, error: 'Inloggen mislukt (controleer API Key en inloggegevens)' });
  }
});

// 3. SubDL Verificatie
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

// 4. SubSource Verificatie
app.post('/api/validate/subsource', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'SubSource API Key ontbreekt' });
  const key = apiKey.trim();

  try {
    const response = await axios.get('https://api.subsource.net/api/v1/subtitles/recent', {
      headers: {
        'X-API-Key': key,
        'User-Agent': 'SubNova/2.0',
        'Accept': 'application/json'
      },
      params: { api_key: key },
      timeout: 7000
    });

    if (response.status === 200) {
      return res.json({ success: true, message: 'SubSource API is actief en geverifieerd!' });
    }
  } catch (err) {
    try {
      const fb = await axios.get('https://api.subsource.net/api/v1/movies/search', {
        headers: { 'X-API-Key': key, 'User-Agent': 'SubNova/2.0' },
        params: { query: 'Inception', api_key: key },
        timeout: 7000
      });
      if (fb.status === 200) {
        return res.json({ success: true, message: 'SubSource API is actief en geverifieerd!' });
      }
    } catch (fbErr) {
      const status = fbErr.response?.status || err.response?.status;
      if (status === 401 || status === 403) return res.json({ success: false, error: 'Ongeldige SubSource API-sleutel (401/403)' });
      if (status === 429) return res.json({ success: false, error: 'SubSource rate limit bereikt (429)' });
      return res.json({ success: false, error: 'Verbinding mislukt (' + (status || 'timeout') + ')' });
    }
  }
  return res.json({ success: false, error: 'SubSource gaf geen reactie' });
});

// ================= SUBTITLE BRONNEN ================= //

// Token helper voor OpenSubtitles met 23 uur caching
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
      headers: {
        'Api-Key': apiKey.trim(),
        'Content-Type': 'application/json',
        'User-Agent': 'SubNova-v2.0'
      },
      timeout: 6000
    });

    if (res.data?.token) {
      osTokenCache.set(cacheKey, {
        token: res.data.token,
        expiresAt: Date.now() + 23 * 60 * 60 * 1000
      });
      return res.data.token;
    }
  } catch (err) {
    console.error('[OpenSubtitles] Inloggen mislukt:', err.message);
  }
  return null;
}

// 1. Officiële OpenSubtitles REST API (v1) met API Key & Account
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

    const headers = {
      'Api-Key': apiKey.trim(),
      'User-Agent': 'SubNova-v2.0'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const params = {
      imdb_id: cleanImdb,
      languages: 'nl,en'
    };

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

// 2. OpenSubtitles v3 (Publieke Stremio mirror fallback)
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

// 3. SubDL
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

// 4. SubSource
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

// Universele ondertitel download-functie voor alle bronnen
async function downloadSubtitleText(sub) {
  // 1. OpenSubtitles Officiële v1 Download API
  if (sub.fileId && sub.osApiKey) {
    const headers = {
      'Api-Key': sub.osApiKey,
      'User-Agent': 'SubNova-v2.0',
      'Content-Type': 'application/json'
    };
    if (sub.osToken) headers['Authorization'] = `Bearer ${sub.osToken}`;

    const dlRes = await axios.post('https://api.opensubtitles.com/api/v1/download', {
      file_id: sub.fileId
    }, { headers, timeout: 8000 });

    if (dlRes.data?.link) {
      const fileRes = await axios.get(dlRes.data.link, { responseType: 'arraybuffer', timeout: 8000 });
      const buffer = Buffer.from(fileRes.data);
      try {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntries().find(e => e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt'));
        return entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
      } catch (e) {
        return buffer.toString('utf8');
      }
    }
  }

  // 2. SubSource Download
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

  // 3. Directe URL (SubDL / OpenSubtitles Public)
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

// ================= STREMIO ONDERTITELS ROUTE ================= //

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

  // Parallelle zoekopdracht over alle bronnen
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

  // 1. Gesynchroniseerde AI Vertaling via Gemini
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

  // 2. Bestaande Nederlandse subs via proxy
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

// ================= UNIVERSELE PROXY VOOR NATIVE SUBS ================= //

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

// ================= SNELLE SYNCHRONE AI VERTALING MET MONGODB ================= //

app.get('/sub/translate', async (req, res) => {
  try {
    const data = JSON.parse(decodeURIComponent(req.query.data));
    const cacheKey = `ai_nl_synced_${data.mediaId}_${Buffer.from(data.directUrl || data.downloadUrl || data.id).toString('base64').substring(0, 24)}`;

    // 1. Is het al vertaald in MongoDB?
    if (db) {
      try {
        const cached = await db.collection('translations').findOne({ cacheKey });
        if (cached && cached.vtt) {
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.send(cache
