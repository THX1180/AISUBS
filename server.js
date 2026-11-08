require('dotenv').config();
const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
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
  try {
    const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10 });
    client.connect()
      .then(() => {
        db = client.db('subnova_cache');
        db.collection('translations').createIndex({ cacheKey: 1 }, { unique: true });
        console.log('✅ Verbonden met MongoDB Atlas Cache');
      })
      .catch(err => console.error('⚠️ MongoDB fout (draait zonder cache):', err.message));
  } catch (err) {
    console.error('⚠️ Ongeldige MongoDB URL:', err.message);
  }
}

const osTokenCache = new Map();
const activeTranslationJobs = new Set();

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

// Veiligheidsfilters uitschakelen zodat films met actie/grof taalgebruik nooit blokkeren
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

function parseSrt(srtContent) {
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const blocks = normalized.split(/\n\s*\n/);
  const cues = [];
  
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeIdx = lines.findIndex(l => l.includes('-->'));
    if (timeIdx !== -1) {
      const [start, end] = lines[timeIdx].split('-->').map(s => s.trim());
      const text = lines.slice(timeIdx + 1).join('\n').trim();
      if (start && end && text) {
        cues.push({ id: cues.length + 1, start, end, text });
      }
    }
  }
  return cues;
}

function cuesToVtt(cues) {
  let vtt = 'WEBVTT\n\n';
  for (const c of cues) {
    const s = c.start.replace(',', '.');
    const e = c.end.replace(',', '.');
    vtt += `${c.id}\n${s} --> ${e}\n${c.text}\n\n`;
  }
  return vtt;
}

function formatVttTimestamp(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}.000`;
}

function generateWaitingVtt() {
  let vtt = 'WEBVTT\n\n';
  const totalSeconds = 4 * 3600;
  let idx = 1;
  for (let s = 0; s < totalSeconds; s += 20) {
    const t1 = formatVttTimestamp(s);
    const t2 = formatVttTimestamp(s + 10);
    const t3 = formatVttTimestamp(s + 19);
    vtt += `${idx++}\n${t1} --> ${t2}\n⏳ [SubNova AI] Bezig met synchroniseren en vertalen naar het Nederlands...\n\n`;
    vtt += `${idx++}\n${t2} --> ${t3}\n✨ Kies deze subs over enkele ogenblikken opnieuw in het menu!\n\n`;
  }
  return vtt;
}

// Gemini batch-vertaler met zero-drift
async function translateCuesWithGemini(cues, geminiKey, preferredModel) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Geen Gemini API Key beschikbaar');

  const genAI = new GoogleGenerativeAI(apiKey);
  const models = [preferredModel || 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
  
  let activeModel = null;
  for (const m of models) {
    try {
      activeModel = genAI.getGenerativeModel({ model: m, safetySettings });
      break;
    } catch (e) {}
  }
  if (!activeModel) activeModel = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite', safetySettings });

  const batchSize = 75;
  const batches = [];
  for (let i = 0; i < cues.length; i += batchSize) {
    batches.push(cues.slice(i, i + batchSize));
  }

  const translatedCues = [...cues];

  for (const batch of batches) {
    const promptLines = batch.map(c => `[${c.id}] ${c.text.replace(/\n/g, ' ')}`).join('\n');
    const prompt = `Je bent een meester filmvertaler. Vertaal de onderstaande regels naar vloeiend, natuurlijk Nederlands.
REGELS:
1. Behoud exact het ID-formaat [ID] Vertaalde tekst.
2. Wijzig nooit de nummers tussen de haken.
3. Vertaal alleen de dialoog na de haak. Geef geen toelichting of markdown codeblokken.

TEKST:
${promptLines}`;

    try {
      const res = await activeModel.generateContent(prompt);
      const text = res.response.text();
      const lines = text.split('\n');

      for (const line of lines) {
        const match = line.match(/^\[(\d+)\]\s*(.*)$/);
        if (match) {
          const id = parseInt(match[1]);
          const translatedText = match[2].trim();
          const targetCue = translatedCues.find(c => c.id === id);
          if (targetCue && translatedText) {
            targetCue.text = translatedText;
          }
        }
      }
    } catch (err) {
      console.error('Batch vertaalfout:', err.message);
    }
  }

  return translatedCues;
}

// OpenSubtitles Token Cache
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
  } catch (err) {}
  return null;
}

// ================= LIVE VALIDATIE ENDPOINTS ================= //

// 1. Gemini
app.post('/api/validate/gemini', async (req, res) => {
  const { apiKey, model } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'Vul een API-sleutel in' });
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const m = genAI.getGenerativeModel({ model: model || 'gemini-3.5-flash-lite' });
    await m.countTokens('Test');
    return res.json({ success: true, message: 'Google Gemini API is actief!' });
  } catch (err) {
    return res.json({ success: false, error: err.message?.includes('API_KEY_INVALID') ? 'Ongeldige sleutel' : 'Verbinding mislukt' });
  }
});

// 2. OpenSubtitles
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
        return res.json({ success: true, message: `Ingelogd als ${loginRes.data.user?.username || username}!` });
      }
    } else {
      await axios.get('https://api.opensubtitles.com/api/v1/infos/formats', {
        headers: { 'Api-Key': apiKey, 'User-Agent': 'SubNova-v1.0' }, timeout: 5000
      });
      return res.json({ success: true, message: 'API Key is geldig!' });
    }
  } catch (err) {
    return res.json({ success: false, error: 'Inloggen mislukt' });
  }
});

// 3. SubDL
app.post('/api/validate/subdl', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'SubDL API Key ontbreekt' });
  try {
    const checkRes = await axios.get('https://api.subdl.com/api/v1/subtitles', {
      params: { api_key: apiKey, imdb_id: 'tt0111161' }, timeout: 5000
    });
    if (checkRes.data?.status === true || checkRes.data?.subtitles) return res.json({ success: true, message: 'SubDL API is actief!' });
    return res.json({ success: false, error: 'Ongeldige SubDL sleutel' });
  } catch (err) { return res.json({ success: false, error: 'Verbinding mislukt' }); }
});

// 4. SubSource (Officiële v1 IMDb Zoekmethode)
app.post('/api/validate/subsource', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'SubSource API Key ontbreekt' });

  try {
    const response = await axios.get('https://api.subsource.net/api/v1/movies/search', {
      params: { searchType: 'imdb', q: 'tt0111161' },
      headers: {
        'X-API-Key': apiKey.trim(),
        'User-Agent': 'SubNova-v1.0',
        'Accept': 'application/json'
      },
      timeout: 6000
    });

    if (response.status === 200) {
      return res.json({ success: true, message: 'SubSource API is actief en geverifieerd!' });
    }
    return res.json({ success: false, error: 'SubSource gaf onverwacht antwoord' });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return res.json({ success: false, error: 'Ongeldige SubSource API-sleutel (401)' });
    }
    if (status === 429) {
      return res.json({ success: false, error: 'SubSource rate-limit bereikt (429)' });
    }
    return res.json({ success: false, error: err.response?.data?.message || 'Verbinding mislukt' });
  }
});

// ================= SUBTITLE BRONNEN ================= //

// 1. OpenSubtitles v3 (met exacte videoHash)
async function fetchOpenSubtitlesPublic(type, id, extra) {
  try {
    const url = extra 
      ? `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}/${extra}.json`
      : `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}.json`;
    const res = await axios.get(url, { timeout: 4500 });
    return (res.data?.subtitles || []).map(item => ({
      source: 'OpenSubtitles',
      id: item.id,
      lang: (item.lang === 'dut' || item.lang === 'nld') ? 'nl' : (item.lang === 'eng' ? 'en' : item.lang),
      release: item.id || 'Gesynchroniseerd',
      directUrl: item.url
    }));
  } catch (err) { return []; }
}

// 2. OpenSubtitles VIP / Account
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

// 3. SubDL
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

// 4. SubSource (2-staps IMDb naar Subtitles)
async function fetchSubSource(imdbId, season, episode, userKey) {
  const apiKey = userKey || process.env.SUBSOURCE_API_KEY;
  if (!apiKey) return [];
  try {
    const searchRes = await axios.get('https://api.subsource.net/api/v1/movies/search', {
      params: { searchType: 'imdb', q: imdbId },
      headers: { 'X-API-Key': apiKey.trim(), 'User-Agent': 'SubNova-v1.0' },
      timeout: 4500
    });

    const movies = searchRes.data?.data || searchRes.data?.movies || (Array.isArray(searchRes.data) ? searchRes.data : []);
    const movie = movies[0];
    if (!movie || !movie.id) return [];

    const subRes = await axios.get('https://api.subsource.net/api/v1/subtitles', {
      params: { movieId: movie.id, lang: 'dutch,english' },
      headers: { 'X-API-Key': apiKey.trim(), 'User-Agent': 'SubNova-v1.0' },
      timeout: 4500
    });

    const list = subRes.data?.data || subRes.data?.subtitles || (Array.isArray(subRes.data) ? subRes.data : []);
    return list.map(item => ({
      source: 'SubSource',
      id: item.id || item.subId,
      lang: item.lang?.toLowerCase().includes('dutch') || item.lang?.toLowerCase() === 'nl' ? 'nl' : 'en',
      release: item.release_name || item.name || 'SubSource Match',
      downloadUrl: `https://api.subsource.net/api/v1/subtitles/${item.id || item.subId}/download`,
      apiKey: apiKey.trim()
    }));
  } catch (err) { return []; }
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
  const numericImdb = imdbId ? imdbId.replace('tt', '') : '';

  // Parallel ophalen uit alle 4 de bronnen
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

  // 1. ALTIJD bovenaan: Gesynchroniseerde AI Vertaling (Zero-Drift)
  if (enSubs.length > 0) {
    const bestEn = enSubs[0]; // Nummer 1 heeft de beste hash/release-match
    const translationPayload = encodeURIComponent(JSON.stringify({
      ...bestEn,
      mediaId: id,
      geminiKey: config.geminiKey,
      geminiModel: config.geminiModel
    }));

    subtitles.push({
      id: `ai_nl_sync_top`,
      url: `${host}/sub/translate?data=${translationPayload}`,
      lang: 'dut',
      label: `⭐ [AI NL • Gesynchroniseerd] Vertaald via Gemini (${bestEn.release})`
    });
  }

  // 2. Bestaande Nederlandse subs toevoegen
  if (nlSubs.length > 0) {
    nlSubs.forEach((sub, idx) => {
      subtitles.push({
        id: `nl_${sub.source}_${idx}`,
        url: sub.directUrl || `${host}/sub/stream?data=${encodeURIComponent(JSON.stringify(sub))}`,
        lang: 'dut',
        label: `[${sub.source}] ${sub.release || 'Nederlands'}`
      });
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

    if (sub.downloadUrl && sub.apiKey) {
      // SubSource ZIP download & extract
      const fileRes = await axios.get(sub.downloadUrl, {
        headers: { 'X-API-Key': sub.apiKey },
        responseType: 'arraybuffer',
        timeout: 8000
      });
      const buffer = Buffer.from(fileRes.data);
      try {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntries().find(e => e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt'));
        srtText = entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
      } catch (e) { srtText = buffer.toString('utf8'); }
    } else if (sub.fileId && sub.apiKey) {
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

    const vttContent = srtText.includes('WEBVTT') ? srtText : `WEBVTT\n\n${srtText.replace(/\r\n/g, '\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vttContent);
  } catch (err) {
    res.status(500).send('Fout bij streamen van ondertitel');
  }
});

// ================= ASYNCHRONE VERTALING ================= //

app.get('/sub/translate', async (req, res) => {
  try {
    const data = JSON.parse(decodeURIComponent(req.query.data));
    const cacheKey = `ai_nl_synced_${data.mediaId}_${Buffer.from(data.directUrl || data.downloadUrl || data.id).toString('base64').substring(0, 24)}`;

    // 1. Check MongoDB Cache
    if (db) {
      try {
        const cached = await db.collection('translations').findOne({ cacheKey });
        if (cached && cached.vtt) {
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          return res.send(cached.vtt);
        }
      } catch (e) {}
    }

    // 2. Start achtergrondvertaling
    if (!activeTranslationJobs.has(cacheKey)) {
      activeTranslationJobs.add(cacheKey);

      (async () => {
        try {
          console.log(`[SubNova] Achtergrondvertaling gestart voor ${cacheKey}`);
          let rawSrt = '';

          if (data.downloadUrl && data.apiKey) {
            const fileRes = await axios.get(data.downloadUrl, {
              headers: { 'X-API-Key': data.apiKey }, responseType: 'arraybuffer', timeout: 8000
            });
            const buffer = Buffer.from(fileRes.data);
            try {
              const zip = new AdmZip(buffer);
              const entry = zip.getEntries().find(
