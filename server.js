require('dotenv').config();
const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { MongoClient } = require('mongodb');
const { 
  GoogleGenerativeAI, 
  HarmCategory, 
  HarmBlockThreshold 
} = require('@google/generative-ai');
const manifest = require('./manifest');

const app = express();
const PORT = process.env.PORT || 7860;

process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});

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
    const client = new MongoClient(process.env.MONGODB_URI, { 
      maxPoolSize: 10 
    });
    client.connect()
      .then(() => {
        db = client.db('subnova_cache');
        db.collection('translations').createIndex(
          { cacheKey: 1 }, 
          { unique: true }
        );
        console.log('✅ Verbonden met MongoDB Cache');
      })
      .catch((err) => {
        console.error('⚠️ MongoDB fout:', err.message);
      });
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
  { 
    category: HarmCategory.HARM_CATEGORY_HARASSMENT, 
    threshold: HarmBlockThreshold.BLOCK_NONE 
  },
  { 
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, 
    threshold: HarmBlockThreshold.BLOCK_NONE 
  },
  { 
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, 
    threshold: HarmBlockThreshold.BLOCK_NONE 
  },
  { 
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, 
    threshold: HarmBlockThreshold.BLOCK_NONE 
  },
];

// ExoPlayer-proof WebVTT converter
function srtToVtt(srtText) {
  if (!srtText || typeof srtText !== 'string') {
    return 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n[Geen subs]\n\n';
  }
  let clean = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (clean.charCodeAt(0) === 0xFEFF) {
    clean = clean.substring(1);
  }
  if (clean.startsWith('WEBVTT')) return clean;
  const converted = clean.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})/g, 
    '$1.$2'
  );
  return `WEBVTT\n\n${converted}\n`;
}

// 1-Shot Gemini Vertaalmotor
async function translateFullSrtWithGemini(rawSrt, geminiKey, preferredModel) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Geen Gemini API Key beschikbaar');

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = preferredModel || 
    process.env.GEMINI_MODEL || 
    'gemini-3.5-flash-lite';

  const model = genAI.getGenerativeModel({
    model: modelName,
    safetySettings,
    generationConfig: { 
      maxOutputTokens: 65536, 
      temperature: 0.1 
    }
  });

  const prompt = `Je bent een filmvertaler. Vertaal deze Engelse SRT naar Nederlands.
REGELS:
1. Behoud exact alle nummers en timestamps.
2. Wijzig de tijdcodes nooit.
3. Vertaal uitsluitend dialoog.
4. Geen introductie of markdown (\`\`\` of \`\`\`srt).

SRT:
${rawSrt}`;

  const result = await model.generateContent(prompt);
  let translated = result.response.text();
  return translated
    .replace(/^```(?:srt)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

// ================= LIVE VALIDATIE ENDPOINTS ================= //

app.post('/api/validate/gemini', async (req, res) => {
  const { apiKey, model } = req.body;
  if (!apiKey) return res.json({ success: false, error: 'Vul een sleutel in' });
  try {
    const genAI = new GoogleGenerativeAI(apiKey.trim());
    const m = genAI.getGenerativeModel({ 
      model: model || 'gemini-3.5-flash-lite' 
    });
    await m.countTokens('Test');
    return res.json({ success: true, message: 'Gemini API is actief!' });
  } catch (err) {
    return res.json({ success: false, error: 'Ongeldige Gemini sleutel' });
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
    } else {
      await axios.get('https://api.opensubtitles.com/api/v1/infos/formats', {
        headers: { 
          'Api-Key': apiKey.trim(), 
          'User-Agent': 'SubNova-v2.0' 
        }, 
        timeout: 5000
      });
      return res.json({ success: true, message: 'API Key is geldig!' });
    }
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
    const r = await axios.get(
      'https://api.subsource.net/api/v1/subtitles/recent', 
      {
        headers: { 
          'X-API-Key': key, 
          'User-Agent': 'Mozilla/5.0', 
          'Accept': 'application/json' 
        },
        params: { api_key: key },
        timeout: 7000
      }
    );
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
        timeout: 6000
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

async function fetchOpenSubtitlesOfficial(
  imdbId, 
  season, 
  episode, 
  osApiKey, 
  osUsername, 
  osPassword
) {
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

    const params = { imdb_id: cleanImdb, languages: 'nl,en' };
    if (season && episode) {
      params.season_number = season;
      params.episode_number = episode;
      params.type = 'episode';
    } else {
      params.type = 'movie';
    }

    const res = await axios.get(
      'https://api.opensubtitles.com/api/v1/subtitles', 
      { headers, params, timeout: 4500 }
    );
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
        release: item.attributes?.release || 'OpenSubtitles Match',
        osApiKey: apiKey.trim()
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
    const res = await axios.get(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 4000 
    });
    return (res.data?.subtitles || []).map((item) => ({
      source: 'OpenSubtitles',
      id: item.id,
      lang: (item.lang === 'dut' || item.lang === 'nld') 
        ? 'nl' 
        : (item.lang === 'eng' ? 'en' : item.lang),
      release: item.id || 'Gesynchroniseerd',
      directUrl: item.url
    }));
  } catch (err) { 
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
      languages: 'nl,en', 
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
    return (res.data?.subtitles || []).map((item) => ({
      source: 'SubDL',
      id: item.url,
      lang: item.lang?.toLowerCase().startsWith('nl') || 
            item.lang?.toLowerCase().startsWith('dut') ? 'nl' : 'en',
      release: item.release_name || item.name || 'SubDL Match',
      directUrl: `https://dl.subdl.com${item.url}`
    }));
  } catch (err) { 
    return []; 
  }
}

async function fetchSubSource(imdbId, userKey) {
  const apiKey = userKey || process.env.SUBSOURCE_API_KEY;
  if (!apiKey) return [];
  const key = apiKey.trim();

  try {
    const sRes = await axios.get(
      'https://api.subsource.net/api/v1/movies/search', 
      {
        params: { query: imdbId, api_key: key },
        headers: { 'X-API-Key': key, 'User-Agent': 'Mozilla/5.0' },
        timeout: 4500
      }
    );
    const movies = sRes.data?.data || sRes.data?.movies || [];
    const movie = movies[0];
    if (!movie || !movie.id) return [];

    const subRes = await axios.get(
      'https://api.subsource.net/api/v1/subtitles', 
      {
        params: { movieId: movie.id, lang: 'dutch,english', api_key: key },
        headers: { 'X-API-Key': key, 'User-Agent': 'Mozilla/5.0' },
        timeout: 4500
      }
    );
    const list = subRes.data?.data || subRes.data?.subtitles || [];
    return list.map((item) => ({
      source: 'SubSource',
      id: item.id || item.subId,
      lang: item.lang?.toLowerCase().includes('dutch') || 
            item.lang?.toLowerCase() === 'nl' ? 'nl' : 'en',
      release: item.release_name || item.name || 'SubSource Match',
      downloadUrl: `https://api.subsource.net/api/v1/subtitles/${item.id || item.subId}/download`,
      apiKey: key
    }));
  } catch (err) { 
    return []; 
  }
}

// Download helper
async function downloadSubtitleText(sub) {
  const bHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': '*/*'
  };

  if (sub.fileId && sub.osApiKey) {
    const headers = { 
      'Api-Key': sub.osApiKey, 
      'User-Agent': 'SubNova-v2.0', 
      'Content-Type': 'application/json' 
    };
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
      const buffer = Buffer.from(fRes.data);
      try {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntries().find((e) => 
          e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt')
        );
        return entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
      } catch (e) { 
        return buffer.toString('utf8'); 
      }
    }
  }

  if (sub.downloadUrl && sub.apiKey) {
    const fRes = await axios.get(sub.downloadUrl, {
      headers: { ...bHeaders, 'X-API-Key': sub.apiKey },
      params: { api_key: sub.apiKey },
      responseType: 'arraybuffer',
      timeout: 8000
    });
    const buffer = Buffer.from(fRes.data);
    try {
      const zip = new AdmZip(buffer);
      const entry = zip.getEntries().find((e) => 
        e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt')
      );
      return entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
    } catch (e) { 
      return buffer.toString('utf8'); 
    }
  }

  if (sub.directUrl) {
    const fRes = await axios.get(sub.directUrl, { 
      headers: bHeaders, 
      responseType: 'arraybuffer', 
      timeout: 8000 
    });
    const buffer = Buffer.from(fRes.data);
    try {
      const zip = new AdmZip(buffer);
      const entry = zip.getEntries().find((e) => 
        e.entryName.endsWith('.srt') || e.entryName.endsWith('.vtt')
      );
      return entry ? entry.getData().toString('utf8') : buffer.toString('utf8');
    } catch (e) { 
      return buffer.toString('utf8'); 
    }
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

  const [osOfficial, pubSubs, dlSubs, ssSubs] = await Promise.allSettled([
    fetchOpenSubtitlesOfficial(
      imdbId, 
      season, 
      episode, 
      config.osApiKey, 
      config.osUsername, 
      config.osPassword
    ),
    fetchOpenSubtitlesPublic(type, id, extra),
    fetchSubDL(imdbId, season, episode, config.subdlKey),
    fetchSubSource(imdbId, config.subsourceKey)
  ]);

  const allSubs = [
    ...(osOfficial.status === 'fulfilled' ? osOfficial.value : []),
    ...(pubSubs.status === 'fulfilled' ? pubSubs.value : []),
    ...(dlSubs.status === 'fulfilled' ? dlSubs.value : []),
    ...(ssSubs.status === 'fulfilled' ? ssSubs.value : [])
  ];

  const nlSubs = allSubs.filter((s) => s.lang === 'nl');
  const enSubs = allSubs.filter((s) => s.lang === 'en');

  let subtitles = [];

  // 1. Gesynchroniseerde AI NL vertaling
  if (enSubs.length > 0) {
    const bestEn = enSubs[0];
    const mini = {
      fileId: bestEn.fileId,
      osApiKey: bestEn.osApiKey,
      downloadUrl: bestEn.downloadUrl,
      apiKey: bestEn.apiKey,
      directUrl: bestEn.directUrl,
      mediaId: id,
      geminiKey: config.geminiKey,
      geminiModel: config.geminiModel
    };
    const payload = Buffer.from(JSON.stringify(mini)).toString('base64url');
    const labelTitle = (bestEn.release || 'Sync').slice(0, 25);

    subtitles.push({
      id: `ai_nl_sync_top`,
      url: `${host}/sub/translate.vtt?d=${payload}`,
      lang: 'dut',
      label: `⭐ [AI NL • Gesynchroniseerd] (${labelTitle})`
    });
  }

  // 2. Bestaande Nederlandse subs
  nlSubs.forEach((sub, idx) => {
    if (sub.directUrl && 
       (sub.directUrl.endsWith('.vtt') || sub.directUrl.endsWith('.srt'))) {
      subtitles.push({
        id: `nl_${idx}`,
        url: sub.directUrl,
        lang: 'dut',
        label: `[${sub.source}] ${(sub.release || 'NL').slice(0, 30)}`
      });
    } else {
      const mini = {
        fileId: sub.fileId,
        osApiKey: sub.osApiKey,
        downloadUrl: sub.downloadUrl,
        apiKey: sub.apiKey,
        directUrl: sub.directUrl
      };
      const payload = Buffer.from(JSON.stringify(mini)).toString('base64url');
      const cleanSrc = sub.source.replace(/\s+/g, '_');
      subtitles.push({
        id: `nl_${cleanSrc}_${idx}`,
        url: `${host}/sub/stream.vtt?d=${payload}`,
        lang: 'dut',
        label: `[${sub.source}] ${(sub.release || 'NL').slice(0, 30)}`
      });
    }
  });

  res.setHeader('Cache-Control', 'max-age=3600, stale-while-revalidate=86400');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({ subtitles });
});

// ================= STREAM PROXY MET .VTT EXTENSIE ================= //

app.get(['/sub/stream', '/sub/stream.vtt'], async (req, res) => {
  try {
    const rawParam = req.query.d || req.query.data;
    if (!rawParam) return res.status(400).send('WEBVTT\n\n');

    let sub;
    try {
      sub = JSON.parse(Buffer.from(rawParam, 'base64url').toString('utf8'));
    } catch (e) {
      sub = JSON.parse(decodeURIComponent(rawParam));
    }

    const rawText = await downloadSubtitleText(sub);
    const vtt = srtToVtt(rawText);

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(vtt);
  } catch (err) {
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send('WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n[Fout bij laden]\n\n');
  }
});

// ================= TRANSLATE MET .VTT EXTENSIE ================= //

app.get(['/sub/translate', '/sub/translate.vtt'], async (req, res) => {
  try {
    const rawParam = req.query.d || req.query.data;
    if (!rawParam) return res.status(400).send('WEBVTT\n\n');

    let data;
    try {
      data = JSON.parse(Buffer.from(rawParam, 'base64url').toString('utf8'));
    } catch (e) {
      data = JSON.parse(decodeURIComponent(rawParam));
    }

    const rawSrc = data.directUrl || 
      data.downloadUrl || 
      String(data.fileId || '');
    const shortHash = Buffer.from(rawSrc).toString('hex').slice(0, 16);
    const mId = data.mediaId || 'video';
    const cacheKey = `ai_nl_${mId}_${shortHash}`;

    // 1. Check MongoDB cache
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

    // 2. Download bronsubtitel
    const rawSrt = await downloadSubtitleText(data);
    if (!rawSrt) throw new Error('Kon bronsubtitel niet ophalen');

    // 3. Vertaal via Gemini
    console.log(`[SubNova] Vertalen gestart voor ${cacheKey}...`);
    const translatedSrt = await translateFullSrtWithGemini(
      rawSrt, 
      data.geminiKey, 
      data.geminiModel
    );
    const vtt = srtToVtt(translatedSrt);

    // 4. Cache in MongoDB
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
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send('WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n[Vertaling mislukt]\n\n');
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
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card: rgba(18, 24, 38, 0.85);
      --border: rgba(255, 255, 255, 0.1);
      --primary: #38bdf8;
      --emerald: #10b981;
      --rose: #f43f5e;
      --text: #f1f5f9;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body {
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }
    .wrapper {
      width: 100%;
      max-width: 640px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 28px;
    }
    .header { text-align: center; margin-bottom: 24px; }
    .title { font-size: 1.8rem; font-weight: 800; margin-bottom: 4px; }
    .title span { color: var(--primary); }
    .subtitle { color: var(--muted); font-size: 0.9rem; }
    .section-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--muted); margin: 20px 0 10px; }
    .field-group { margin-bottom: 14px; }
    .field-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
    .field-header label { font-size: 0.85rem; font-weight: 600; }
    .status-badge { font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 6px; display: none; }
    .status-badge.valid { display: inline-flex; color: var(--emerald); }
    .status-badge.invalid { display: inline-flex; color: var(--rose); }
    .input-wrapper { position: relative; display: flex; align-items: center; }
    input, select {
      width: 100%;
      background: #0b1120;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 90px 10px 12px;
      color: var(--text);
      font-size: 0.9rem;
    }
    input:focus, select:focus { outline: none; border-color: var(--primary); }
    .input-actions { position: absolute; right: 6px; display: flex; gap: 4px; }
    .icon-btn, .check-btn {
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--primary);
      font-size: 0.75rem;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
    }
    .icon-btn { background: transparent; border: none; font-size: 1rem; padding: 2px 6px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 24px; }
    .btn { padding: 12px; border-radius: 12px; font-weight: 700; font-size: 0.95rem; cursor: pointer; border: none; }
    .btn-primary { background: var(--primary); color: #04101e; }
    .btn-secondary { background: rgba(255, 255, 255, 0.05); color: var(--text); border: 1px solid var(--border); }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1 class="title">SubNova <span>AI</span></h1>
      <p class="subtitle">Multi-source ondertitels met Gemini vertaling</p>
    </div>

    <div class="section-title">1. Google Gemini AI</div>
    <div class="field-group">
      <div class="field-header">
        <label for="geminiKey">Gemini API Key</label>
        <span id="geminiBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="geminiKey" placeholder="AIzaSy..." value="${cfg.geminiKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('geminiKey')">👁</button>
          <button class="check-btn" onclick="checkGemini()">Test</button>
        </div>
      </div>
    </div>

    <div class="field-group">
      <label style="font-size:0.85rem; font-weight:600; margin-bottom:5px; display:block;">Model</label>
      <select id="geminiModel">
        <option value="gemini-3.5-flash-lite" ${cfg.geminiModel === 'gemini-3.5-flash-lite' ? 'selected' : ''}>gemini-3.5-flash-lite (Aanbevolen)</option>
        <option value="gemini-2.5-flash" ${cfg.geminiModel === 'gemini-2.5-flash' ? 'selected' : ''}>gemini-2.5-flash</option>
      </select>
    </div>

    <div class="section-title">2. OpenSubtitles.com</div>
    <div class="field-group">
      <div class="field-header">
        <label for="osApiKey">API Key</label>
        <span id="osBadge" class="status-badge"></span>
      </div>
      <div class="input-wrapper">
        <input type="password" id="osApiKey" placeholder="OpenSubtitles API Key" value="${cfg.osApiKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('osApiKey')">👁</button>
          <button class="check-btn" onclick="checkOpenSubtitles()">Test</button>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="field-group">
        <label style="font-size:0.85rem; font-weight:600; margin-bottom:5px; display:block;">Gebruikersnaam</label>
        <input type="text" id="osUsername" style="padding-right:10px;" placeholder="Username" value="${cfg.osUsername || ''}">
      </div>
      <div class="field-group">
        <label style="font-size:0.85rem; font-weight:600; margin-bottom:5px; display:block;">Wachtwoord</label>
        <div class="input-wrapper">
          <input type="password" id="osPassword" placeholder="Password" value="${cfg.osPassword || ''}">
          <div class="input-actions">
            <button class="icon-btn" onclick="toggleVisibility('osPassword')">👁</button>
          </div>
        </div>
      </div>
    </div>

    <div class="section-title">3. SubSource & SubDL (Optioneel)</div>
    <div class="field-group">
      <div class="input-wrapper">
        <input type="password" id="subsourceKey" placeholder="SubSource API Key" value="${cfg.subsourceKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('subsourceKey')">👁</button>
        </div>
      </div>
    </div>

    <div class="field-group">
      <div class="input-wrapper">
        <input type="password" id="subdlKey" placeholder="SubDL API Key" value="${cfg.subdlKey || ''}">
        <div class="input-actions">
          <button class="icon-btn" onclick="toggleVisibility('subdlKey')">👁</button>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" onclick="installAddon()">Installeer in Stremio / Nuvio</button>
      <button class="btn btn-secondary" onclick="copyManifestUrl()">Kopieer Manifest URL</button>
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
      if (!apiKey) return alert('Vul eerst een Gemini sleutel in.');
      try {
        const res = await fetch('/api/validate/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, model })
        });
        const data = await res.json();
        setBadge('geminiBadge', data.success ? 'valid' : 'invalid', data.success ? '✓ Actief' : '✕ Fout');
      } catch (e) { 
        setBadge('geminiBadge', 'invalid', '✕ Fout'); 
      }
    }

    async function checkOpenSubtitles() {
      const apiKey = document.getElementById('osApiKey').value.trim();
      const username = document.getElementById('osUsername').value.trim();
      const password = document.getElementById('osPassword').value.trim();
      if (!apiKey) return alert('Vul eerst een OpenSubtitles API Key in.');
      try {
        const res = await fetch('/api/validate/opensubtitles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, username, password })
        });
        const data = await res.json();
        setBadge('osBadge', data.success ? 'valid' : 'invalid', data.success ? '✓ Actief' : '✕ Fout');
      } catch (e) { 
        setBadge('osBadge', 'invalid', '✕ Fout'); 
      }
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
      const encoded = btoa(JSON.stringify(config))
        .replace(/\\+/g, '-')
        .replace(/\\//g, '_')
        .replace(/=+$/, '');
      return window.location.origin + '/' + encoded + '/manifest.json';
    }

    function installAddon() {
      const url = generateManifestUrl();
      window.location.href = url.replace(/^https?:\\/\\//, 'stremio://');
    }

    function copyManifestUrl() {
      navigator.clipboard.writeText(generateManifestUrl())
        .then(() => alert('Manifest link gekopieerd!'));
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SubNova AI draait op poort ${PORT}`);
});
