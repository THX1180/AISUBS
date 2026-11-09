import express from 'express';
import cors from 'cors';
import { getManifest } from './manifest.js';

const app = express();
const PORT = process.env.PORT || 7860;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('.'));

// Cache: key -> WebVTT string
const subCache = new Map();
const MAX_CACHE_SIZE = 500;

function setInCache(key, vtt) {
  if (subCache.size >= MAX_CACHE_SIZE) {
    const firstKey = subCache.keys().next().value;
    subCache.delete(firstKey);
  }
  subCache.set(key, vtt);
}

// ----------------------------------------------------
// Language & Config Parsing (Supports Guy-Builds style /:lang and /:config)
// ----------------------------------------------------
const ISO_LANG_MAP = {
  spa: 'Spanish', nld: 'Dutch', fre: 'French', ger: 'German', ita: 'Italian',
  por: 'Portuguese', pob: 'Portuguese (Brazil)', rus: 'Russian', ara: 'Arabic',
  heb: 'Hebrew', tur: 'Turkish', pol: 'Polish', jpn: 'Japanese', kor: 'Korean',
  chi: 'Chinese', hin: 'Hindi', swe: 'Swedish', ell: 'Greek', ukr: 'Ukrainian',
  ind: 'Indonesian', ron: 'Romanian', ces: 'Czech', hun: 'Hungarian', dan: 'Danish'
};

function parseConfig(raw) {
  if (!raw) {
    return { lang: 'spa', langName: 'Spanish', provider: 'free', offsetMs: 0 };
  }
  // If it's a short 3-letter code (Guy-Builds style: /spa/manifest.json)
  if (/^[a-z]{3}$/i.test(raw)) {
    const code = raw.toLowerCase();
    return {
      lang: code,
      langName: ISO_LANG_MAP[code] || code.toUpperCase(),
      provider: 'free',
      offsetMs: 0
    };
  }
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf-8');
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch {
      return { lang: 'spa', langName: 'Spanish', provider: 'free', offsetMs: 0 };
    }
  }
}

// ----------------------------------------------------
// Manifest Routes
// ----------------------------------------------------
app.get('/manifest.json', (req, res) => res.json(getManifest()));

app.get('/:param/manifest.json', (req, res) => {
  const config = parseConfig(req.params.param);
  res.json(getManifest(config));
});

// ----------------------------------------------------
// Credential Verification Endpoints
// ----------------------------------------------------

// 1. OpenSubtitles (Validates Key, and tests login if user/pass provided)
app.post('/api/verify-opensubtitles', async (req, res) => {
  const { apiKey, username, password } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, error: 'API Key is required' });

  try {
    // Check API Key first
    const testRes = await fetch('https://api.opensubtitles.com/api/v1/subtitles?imdb_id=0111161&languages=en', {
      headers: {
        'Api-Key': apiKey,
        'User-Agent': 'AISUBS v1.4.0',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(6000)
    });

    if (testRes.status === 401 || testRes.status === 403) {
      return res.status(400).json({ valid: false, error: 'Invalid OpenSubtitles API Key' });
    }

    // If username and password provided, verify user account / VIP
    if (username && password) {
      const loginRes = await fetch('https://api.opensubtitles.com/api/v1/login', {
        method: 'POST',
        headers: {
          'Api-Key': apiKey,
          'User-Agent': 'AISUBS v1.4.0',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(6000)
      });
      const loginData = await loginRes.json();
      if (loginRes.ok && (loginData.token || loginData.status === 200)) {
        return res.json({ valid: true, user: loginData.user?.username || username });
      }
      return res.status(400).json({ valid: false, error: `Login failed: ${loginData.message || 'Check username/password'}` });
    }

    return res.json({ valid: true, user: 'API Key Verified' });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

// 2. SubDL
app.post('/api/verify-subdl', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, error: 'API Key is required' });
  try {
    const resp = await fetch(`https://api.subdl.com/api/v1/subtitles?api_key=${apiKey}&imdb_id=tt0111161&languages=en&subs_per_page=1`, {
      signal: AbortSignal.timeout(6000)
    });
    const data = await resp.json();
    if (resp.ok && data.status !== false) {
      return res.json({ valid: true });
    }
    return res.status(400).json({ valid: false, error: data.error || 'Invalid SubDL Key' });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

// 3. SubSource
app.post('/api/verify-subsource', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, error: 'API Key is required' });
  try {
    const resp = await fetch('https://api.subsource.net/api/v1/movies/search?query=Inception', {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(6000)
    });
    if (resp.ok) return res.json({ valid: true });
    return res.status(400).json({ valid: false, error: `Invalid Key (HTTP ${resp.status})` });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

// 4. AI Provider
app.post('/api/verify-ai', async (req, res) => {
  const { provider, apiKey, model } = req.body;
  if (provider === 'free') return res.json({ valid: true });
  if (!apiKey) return res.status(400).json({ valid: false, error: 'API key is required' });

  try {
    if (provider === 'gemini') {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
        signal: AbortSignal.timeout(6000)
      });
      if (resp.ok) return res.json({ valid: true });
      const err = await resp.json();
      return res.status(400).json({ valid: false, error: err.error?.message || 'Invalid Gemini key' });
    }

    let endpoint = 'https://api.openai.com/v1/models';
    if (provider === 'openrouter') endpoint = 'https://openrouter.ai/api/v1/models';
    if (provider === 'groq') endpoint = 'https://api.groq.com/openai/v1/models';
    if (provider === 'deepseek') endpoint = 'https://api.deepseek.com/models';

    const resp = await fetch(endpoint, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000)
    });
    if (resp.ok) return res.json({ valid: true });
    const err = await resp.json();
    return res.status(400).json({ valid: false, error: err.error?.message || 'Invalid AI Key' });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

// ----------------------------------------------------
// Universal Subtitle Discovery (Handles all Stremio & Nuvio URL variations)
// ----------------------------------------------------
app.use(async (req, res, next) => {
  if (!req.path.includes('/subtitles/')) {
    return next();
  }

  // Regex extracts: /[:config]/subtitles/:type/:id (and strips any trailing .json or extra query args)
  const match = req.path.match(/(?:^|\/)([^/]+)?\/subtitles\/(movie|series)\/([a-zA-Z0-9:]+)/);
  if (!match) {
    return next();
  }

  const rawConfig = match[1] && match[1] !== 'subtitles' ? match[1] : '';
  const mediaType = match[2];
  const fullId = match[3].replace(/\.json$/i, '');

  const config = parseConfig(rawConfig);
  const host = `${req.protocol}://${req.get('host')}`;

  const parts = fullId.split(':');
  const imdbId = parts[0];
  const season = parts[1] || null;
  const episode = parts[2] || null;

  let candidates = [];

  // 1. Check OpenSubtitles if API key configured
  if (config.osApiKey) {
    try {
      const cleanImdb = imdbId.replace('tt', '');
      let osUrl = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${cleanImdb}&languages=en`;
      if (season && episode) osUrl += `&season_number=${season}&episode_number=${episode}`;

      const osRes = await fetch(osUrl, {
        headers: {
          'Api-Key': config.osApiKey,
          'User-Agent': 'AISUBS v1.4.0',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(3500)
      });

      if (osRes.ok) {
        const json = await osRes.json();
        if (json.data && json.data.length > 0) {
          json.data.slice(0, 2).forEach(item => {
            const fileId = item.attributes?.files?.[0]?.file_id;
            if (fileId) {
              candidates.push({
                source: 'OpenSubtitles',
                url: `https://api.opensubtitles.com/api/v1/download?file_id=${fileId}&osApiKey=${config.osApiKey}`
              });
            }
          });
        }
      }
    } catch (e) {
      console.warn('OpenSubtitles fetch warning:', e.message);
    }
  }

  // 2. Check SubDL if configured
  if (candidates.length === 0 && config.subdlApiKey) {
    try {
      let subdlUrl = `https://api.subdl.com/api/v1/subtitles?api_key=${config.subdlApiKey}&imdb_id=${imdbId}&languages=EN&subs_per_page=3`;
      if (season && episode) subdlUrl += `&season_number=${season}&episode_number=${episode}&type=tv`;

      const dlRes = await fetch(subdlUrl, { signal: AbortSignal.timeout(3500) });
      if (dlRes.ok) {
        const dlJson = await dlRes.json();
        if (dlJson.subtitles && dlJson.subtitles.length > 0) {
          dlJson.subtitles.slice(0, 2).forEach(s => {
            const fullUrl = s.url.startsWith('http') ? s.url : `https://dl.subdl.com${s.url}`;
            candidates.push({ source: 'SubDL', url: fullUrl });
          });
        }
      }
    } catch (e) {
      console.warn('SubDL fetch warning:', e.message);
    }
  }

  // 3. Fallback to OpenSubtitles v3 public proxy (Universal Fallback)
  if (candidates.length === 0) {
    try {
      const pubUrl = `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${fullId}.json`;
      const pubRes = await fetch(pubUrl, {
        headers: { 'User-Agent': 'AISubs/1.4.0' },
        signal: AbortSignal.timeout(3500)
      });
      if (pubRes.ok) {
        const pubData = await pubRes.json();
        if (Array.isArray(pubData.subtitles)) {
          const en = pubData.subtitles.filter(s => s.lang === 'eng' || s.lang === 'en');
          const list = en.length > 0 ? en : pubData.subtitles;
          list.slice(0, 3).forEach(s => {
            candidates.push({ source: 'OpenSubtitles-v3', url: s.url });
          });
        }
      }
    } catch (e) {
      console.warn('OpenSubtitles v3 proxy warning:', e.message);
    }
  }

  if (candidates.length === 0) {
    return res.json({ subtitles: [] });
  }

  const cfgString = Buffer.from(JSON.stringify(config)).toString('base64url');
  const targetIso3 = config.lang || 'spa';
  const targetName = config.langName || targetIso3.toUpperCase();

  // Return the subtitle track with both 'lang' and 'label'
  const subtitles = candidates.map((sub, idx) => ({
    id: `aisubs-${imdbId}-${idx}`,
    url: `${host}/sub.vtt?cfg=${cfgString}&src=${encodeURIComponent(sub.url)}`,
    lang: targetIso3,
    label: `🤖 AISUBS - ${targetName} [${sub.source}]`
  }));

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({ subtitles });
});

// ----------------------------------------------------
// Subtitle Stream & Translation Endpoint (/sub.vtt)
// ----------------------------------------------------
app.get('/sub.vtt', async (req, res) => {
  const { cfg, src } = req.query;
  const config = parseConfig(cfg);
  let sourceUrl = decodeURIComponent(src);

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Handle OpenSubtitles download resolution if required
  if (sourceUrl.includes('api.opensubtitles.com/api/v1/download')) {
    try {
      const u = new URL(sourceUrl);
      const fileId = u.searchParams.get('file_id');
      const apiKey = u.searchParams.get('osApiKey');
      const dlPost = await fetch('https://api.opensubtitles.com/api/v1/download', {
        method: 'POST',
        headers: {
          'Api-Key': apiKey,
          'User-Agent': 'AISUBS v1.4.0',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ file_id: Number(fileId) })
      });
      const dlJson = await dlPost.json();
      if (dlJson.link) sourceUrl = dlJson.link;
    } catch (e) {
      console.warn('OpenSubtitles link download resolution error:', e.message);
    }
  }

  const cacheKey = `${sourceUrl}_${config.lang}_${config.provider}_${config.offsetMs}_${config.bilingual}`;
  if (subCache.has(cacheKey)) {
    return res.send(subCache.get(cacheKey));
  }

  try {
    const subRes = await fetch(sourceUrl, { signal: AbortSignal.timeout(8000) });
    if (!subRes.ok) throw new Error(`Source subtitle download failed: ${subRes.status}`);
    const rawText = await subRes.text();

    const cues = parseSubtitleCues(rawText);
    if (!cues || cues.length === 0) {
      throw new Error('No subtitle cues found');
    }

    if (config.offsetMs && config.offsetMs !== 0) {
      cues.forEach(c => {
        c.start = shiftTimestamp(c.start, config.offsetMs);
        c.end = shiftTimestamp(c.end, config.offsetMs);
      });
    }

    // Translate in context chunks of 45 dialogue lines
    const batchSize = 45;
    for (let i = 0; i < cues.length; i += batchSize) {
      const chunk = cues.slice(i, i + batchSize);
      const texts = chunk.map(c => c.text);
      const translated = await translateBatch(texts, config.langName || 'Spanish', config);

      chunk.forEach((c, idx) => {
        const trans = translated[idx] || c.text;
        c.text = config.bilingual ? `${c.text}\n<c.cyan>${trans}</c>` : trans;
      });
    }

    const vttOutput = buildWebVTT(cues);
    setInCache(cacheKey, vttOutput);
    res.send(vttOutput);
  } catch (err) {
    console.error('Subtitle rendering error:', err.message);
    res.send('WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\n[AISubs: Translation timed out or source unavailable]');
  }
});

// Translation Providers
async function translateBatch(texts, targetLang, config) {
  const { provider, apiKey, model } = config;

  if (provider === 'gemini' && apiKey) {
    return translateWithGemini(texts, targetLang, apiKey, model);
  }
  if (['openrouter', 'openai', 'groq', 'deepseek'].includes(provider) && apiKey) {
    return translateWithOpenAICompatible(texts, targetLang, provider, apiKey, model);
  }
  return translateWithFreeFallback(texts, targetLang);
}

async function translateWithGemini(texts, targetLang, apiKey, model) {
  const chosenModel = model && model !== 'default' ? model : 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${chosenModel}:generateContent?key=${apiKey}`;

  // Context-aware instruction preserving cues
  const prompt = `You are a film subtitle translator. Translate the following numbered dialogue into ${targetLang}. Preserve line numbering and tone. Return ONLY numbered lines with no comments or markdown code blocks:\n\n${texts.map((t, idx) => `${idx + 1}| ${t.replace(/\n/g, ' ')}`).join('\n')}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 }
    }),
    signal: AbortSignal.timeout(10000)
  });

  const data = await res.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseNumberedReply(reply, texts);
}

async function translateWithOpenAICompatible(texts, targetLang, provider, apiKey, model) {
  let endpoint = 'https://api.openai.com/v1/chat/completions';
  let defaultModel = 'gpt-4o-mini';

  if (provider === 'openrouter') {
    endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    defaultModel = 'google/gemini-2.0-flash-001';
  } else if (provider === 'groq') {
    endpoint = 'https://api.groq.com/openai/v1/chat/completions';
    defaultModel = 'llama-3.3-70b-versatile';
  } else if (provider === 'deepseek') {
    endpoint = 'https://api.deepseek.com/chat/completions';
    defaultModel = 'deepseek-chat';
  }

  const chosenModel = model && model !== 'default' ? model : defaultModel;
  const prompt = `Translate dialogue cues into ${targetLang}. Return ONLY lines formatted as [index]| [translated line]:\n\n${texts.map((t, idx) => `${idx + 1}| ${t.replace(/\n/g, ' ')}`).join('\n')}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: chosenModel,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(10000)
  });

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content || '';
  return parseNumberedReply(reply, texts);
}

async function translateWithFreeFallback(texts, targetLang) {
  const results = [];
  for (const text of texts) {
    try {
      const clean = encodeURIComponent(text);
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang.slice(0, 2).toLowerCase()}&dt=t&q=${clean}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const json = await res.json();
      const translated = json[0]?.map(p => p[0]).join('') || text;
      results.push(translated);
    } catch {
      results.push(text);
    }
  }
  return results;
}

function parseNumberedReply(reply, original) {
  const lines = reply.split('\n').filter(l => l.trim().length > 0);
  const map = new Map();
  for (const line of lines) {
    const match = line.match(/^(\d+)[\|\.\:\)]\s*(.*)$/);
    if (match) map.set(parseInt(match[1], 10), match[2].trim());
  }
  return original.map((orig, idx) => map.get(idx + 1) || orig);
}

function parseSubtitleCues(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const cues = [];
  let i = 0;
  const timeRegex = /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/;

  while (i < lines.length) {
    const line = lines[i].trim();
    const match = timeRegex.exec(line);
    if (match) {
      const start = match[1].replace(',', '.');
      const end = match[2].replace(',', '.');
      i++;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }
      cues.push({ start, end, text: textLines.join('\n') });
    } else {
      i++;
    }
  }
  return cues;
}

function buildWebVTT(cues) {
  let vtt = 'WEBVTT\n\n';
  cues.forEach((cue, idx) => {
    vtt += `${idx + 1}\n${cue.start} --> ${cue.end}\n${cue.text}\n\n`;
  });
  return vtt;
}

function shiftTimestamp(ts, offsetMs) {
  const parts = ts.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const [sStr, msStr] = parts[2].split('.');
  const s = parseInt(sStr, 10);
  const ms = parseInt(msStr, 10);

  let totalMs = ((h * 3600 + m * 60 + s) * 1000) + ms + offsetMs;
  if (totalMs < 0) totalMs = 0;

  const newH = Math.floor(totalMs / 3600000);
  totalMs %= 3600000;
  const newM = Math.floor(totalMs / 60000);
  totalMs %= 60000;
  const newS = Math.floor(totalMs / 1000);
  const newMs = totalMs % 1000;

  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:${String(newS).padStart(2, '0')}.${String(newMs).padStart(3, '0')}`;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AISUBS server running on port ${PORT}`);
});
