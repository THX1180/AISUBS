import express from 'express';
import cors from 'cors';
import { getManifest } from './manifest.js';

const app = express();
const PORT = process.env.PORT || 7860;

// Middleware
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

// Config parser
function parseConfig(rawConfig) {
  if (!rawConfig) {
    return {
      lang: 'spa',
      langName: 'Spanish',
      provider: 'free',
      apiKey: '',
      model: 'default',
      offsetMs: 0,
      bilingual: false
    };
  }
  try {
    const json = Buffer.from(rawConfig, 'base64url').toString('utf-8');
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(decodeURIComponent(rawConfig));
    } catch {
      return { lang: 'spa', langName: 'Spanish', provider: 'free', offsetMs: 0 };
    }
  }
}

// ----------------------------------------------------
// Manifest Endpoints
// ----------------------------------------------------
app.get('/manifest.json', (req, res) => {
  res.json(getManifest());
});

app.get('/:config/manifest.json', (req, res) => {
  const config = parseConfig(req.params.config);
  res.json(getManifest(config));
});

// ----------------------------------------------------
// Subtitles Metadata Handler (< 200ms)
// ----------------------------------------------------
async function handleSubtitles(req, res, config) {
  const { type, id } = req.params;
  const cleanId = id.replace('.json', '');
  const host = `${req.protocol}://${req.get('host')}`;

  try {
    // Fetch source subtitles from Stremio's free OpenSubtitles v3 proxy
    const osUrl = `https://opensubtitles-v3.strem.io/subtitles/${type}/${cleanId}.json`;
    const resp = await fetch(osUrl, {
      headers: { 'User-Agent': 'AISubs/1.2.0' },
      signal: AbortSignal.timeout(4000)
    });

    let candidates = [];
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data.subtitles)) {
        // Prioritize English or original source subtitles
        candidates = data.subtitles.filter(s => s.lang === 'eng' || s.lang === 'en');
        if (candidates.length === 0) candidates = data.subtitles.slice(0, 3);
      }
    }

    if (candidates.length === 0) {
      return res.json({ subtitles: [] });
    }

    const cfgString = Buffer.from(JSON.stringify(config)).toString('base64url');
    const targetIso3 = config.lang || 'spa';
    const targetName = config.langName || targetIso3.toUpperCase();

    // Return instant subtitle descriptors pointing to /sub.vtt
    const subtitles = candidates.slice(0, 2).map((sub, idx) => ({
      id: `aisubs-${cleanId}-${idx}`,
      url: `${host}/sub.vtt?cfg=${cfgString}&src=${encodeURIComponent(sub.url)}`,
      lang: targetIso3,
      extra: {
        label: `🤖 AI Subs - ${targetName}${idx > 0 ? ` (#${idx + 1})` : ''}`
      }
    }));

    res.json({ subtitles });
  } catch (err) {
    console.error('Error finding source subs:', err.message);
    res.json({ subtitles: [] });
  }
}

app.get('/subtitles/:type/:id', (req, res) => handleSubtitles(req, res, parseConfig('')));
app.get('/:config/subtitles/:type/:id', (req, res) => handleSubtitles(req, res, parseConfig(req.params.config)));

// ----------------------------------------------------
// Subtitle Stream & Translation Endpoint (/sub.vtt)
// ----------------------------------------------------
app.get('/sub.vtt', async (req, res) => {
  const { cfg, src } = req.query;
  const config = parseConfig(cfg);
  const sourceUrl = decodeURIComponent(src);

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const cacheKey = `${sourceUrl}_${config.lang}_${config.provider}_${config.offsetMs}_${config.bilingual}`;
  if (subCache.has(cacheKey)) {
    return res.send(subCache.get(cacheKey));
  }

  try {
    const subRes = await fetch(sourceUrl, { signal: AbortSignal.timeout(6000) });
    if (!subRes.ok) throw new Error(`Failed to download raw subtitle: ${subRes.status}`);
    const rawText = await subRes.text();

    const cues = parseSubtitleCues(rawText);
    if (!cues || cues.length === 0) {
      throw new Error('Unable to parse subtitle cues');
    }

    // Apply timing offset if requested
    if (config.offsetMs && config.offsetMs !== 0) {
      cues.forEach(c => {
        c.start = shiftTimestamp(c.start, config.offsetMs);
        c.end = shiftTimestamp(c.end, config.offsetMs);
      });
    }

    // Translate cues in batches of 40 lines
    const batchSize = 40;
    for (let i = 0; i < cues.length; i += batchSize) {
      const chunk = cues.slice(i, i + batchSize);
      const textsToTranslate = chunk.map(c => c.text);
      const translated = await translateBatch(textsToTranslate, config.langName || 'Spanish', config);

      chunk.forEach((c, idx) => {
        const trans = translated[idx] || c.text;
        c.text = config.bilingual ? `${c.text}\n<c.cyan>${trans}</c>` : trans;
      });
    }

    const vttOutput = buildWebVTT(cues);
    setInCache(cacheKey, vttOutput);
    res.send(vttOutput);
  } catch (err) {
    console.error('Translation error:', err.message);
    res.send('WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\n[AISubs: Translation unavailable or timed out]');
  }
});

// ----------------------------------------------------
// Translation Routing
// ----------------------------------------------------
async function translateBatch(texts, targetLang, config) {
  const { provider, apiKey, model } = config;

  if (provider === 'gemini' && apiKey) {
    return translateWithGemini(texts, targetLang, apiKey, model);
  }
  if ((provider === 'openrouter' || provider === 'openai' || provider === 'groq' || provider === 'deepseek') && apiKey) {
    return translateWithOpenAICompatible(texts, targetLang, provider, apiKey, model);
  }
  return translateWithFreeFallback(texts, targetLang);
}

// 1. Google Gemini
async function translateWithGemini(texts, targetLang, apiKey, model) {
  const chosenModel = model && model !== 'default' ? model : 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${chosenModel}:generateContent?key=${apiKey}`;

  const prompt = `Translate each line of the following numbered list to ${targetLang}. Preserve line numbers strictly. Return ONLY the translated numbered list, with no intro, markdown formatting, or outro:\n\n${texts.map((t, idx) => `${idx + 1}. ${t.replace(/\n/g, ' ')}`).join('\n')}`;

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

// 2. OpenAI / OpenRouter / Groq / DeepSeek
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

  const prompt = `Translate each line to ${targetLang}. Return ONLY the numbered lines with no quotes, notes, or code blocks:\n\n${texts.map((t, idx) => `${idx + 1}. ${t.replace(/\n/g, ' ')}`).join('\n')}`;

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

// 3. Free Web Fallback (Zero Setup / Keyless)
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

// Parse AI numbered lines
function parseNumberedReply(reply, original) {
  const lines = reply.split('\n').filter(l => l.trim().length > 0);
  const map = new Map();
  for (const line of lines) {
    const match = line.match(/^(\d+)[\.\:\)]\s*(.*)$/);
    if (match) {
      map.set(parseInt(match[1], 10), match[2].trim());
    }
  }
  return original.map((orig, idx) => map.get(idx + 1) || orig);
}

// Subtitle Parsers & Builders
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

// Health check endpoint
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.2.0' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AISUBS server running on port ${PORT}`);
});
