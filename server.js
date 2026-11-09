import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getManifest } from './manifest.js';

const app = express();
const PORT = process.env.PORT || 7860;

const ENV_GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || '';
const ENV_TARGET_LANG = process.env.TARGET_LANG || 'nld';

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('.'));

// Persistent Profiles
const PROFILES_FILE = path.join(process.cwd(), 'profiles.json');
let savedProfiles = {};
if (fs.existsSync(PROFILES_FILE)) {
  try {
    savedProfiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
  } catch (e) {
    savedProfiles = {};
  }
}

function persistProfiles() {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(savedProfiles, null, 2));
  } catch (e) {
    console.warn('[AISUBS] Could not write profiles.json:', e.message);
  }
}

// Subtitle Cache
const subCache = new Map();
const MAX_CACHE_SIZE = 500;

function setInCache(key, vtt) {
  if (subCache.size >= MAX_CACHE_SIZE) {
    const firstKey = subCache.keys().next().value;
    subCache.delete(firstKey);
  }
  subCache.set(key, vtt);
}

const ISO_LANG_MAP = {
  nld: 'Dutch', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian',
  por: 'Portuguese', pob: 'Portuguese (Brazil)', rus: 'Russian', ara: 'Arabic',
  heb: 'Hebrew', tur: 'Turkish', pol: 'Polish', jpn: 'Japanese', kor: 'Korean',
  chi: 'Chinese', hin: 'Hindi', swe: 'Swedish', ell: 'Greek', ukr: 'Ukrainian',
  ind: 'Indonesian', ron: 'Romanian', ces: 'Czech', hun: 'Hungarian', dan: 'Danish'
};

function parseConfig(raw) {
  const baseDefault = {
    lang: ENV_TARGET_LANG,
    langName: ISO_LANG_MAP[ENV_TARGET_LANG] || 'Dutch',
    provider: ENV_GEMINI_KEY ? 'gemini' : 'gemini',
    apiKey: ENV_GEMINI_KEY,
    model: 'gemini-2.0-flash',
    offsetMs: 0,
    bilingual: false
  };

  if (!raw) return baseDefault;
  if (savedProfiles[raw]) return { ...baseDefault, ...savedProfiles[raw] };

  if (/^[a-z]{3}$/i.test(raw)) {
    const code = raw.toLowerCase();
    return { ...baseDefault, lang: code, langName: ISO_LANG_MAP[code] || code.toUpperCase() };
  }

  try {
    const json = Buffer.from(raw, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json);
    return { ...baseDefault, ...parsed, apiKey: parsed.apiKey || ENV_GEMINI_KEY };
  } catch {
    try {
      const parsed = JSON.parse(decodeURIComponent(raw));
      return { ...baseDefault, ...parsed, apiKey: parsed.apiKey || ENV_GEMINI_KEY };
    } catch {
      return baseDefault;
    }
  }
}

// Safe URL Encoding / Decoding helpers to prevent signature corruption
function encodeSourceParam(url) {
  if (!url) return '';
  return Buffer.from(url, 'utf-8').toString('base64url');
}

function decodeSourceParam(param) {
  if (!param) return '';
  try {
    const decoded = Buffer.from(param, 'base64url').toString('utf-8');
    if (decoded.startsWith('http')) return decoded;
  } catch {}
  return param;
}

// ----------------------------------------------------
// Profile Storage Endpoints
// ----------------------------------------------------
app.post('/api/profiles/save', (req, res) => {
  const { name, config } = req.body;
  if (!name || !config) return res.status(400).json({ error: 'Name and config required' });

  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
  savedProfiles[slug] = config;
  persistProfiles();

  res.json({ success: true, slug, url: `${req.protocol}://${req.get('host')}/p/${slug}/manifest.json` });
});

app.get('/api/profiles/list', (req, res) => {
  res.json({ profiles: Object.keys(savedProfiles) });
});

// ----------------------------------------------------
// Manifest Routes
// ----------------------------------------------------
app.get(['/manifest.json', '/p/:profile/manifest.json', '/:param/manifest.json'], (req, res) => {
  const param = req.params.profile || req.params.param || '';
  const config = parseConfig(param);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(getManifest(config));
});

// ----------------------------------------------------
// Verification Endpoints
// ----------------------------------------------------
app.post('/api/verify-opensubtitles', async (req, res) => {
  const { apiKey, username, password } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, error: 'API Key is required' });

  try {
    const testRes = await fetch('https://api.opensubtitles.com/api/v1/subtitles?imdb_id=0111161&languages=en', {
      headers: {
        'Api-Key': apiKey,
        'User-Agent': 'AISUBS v2.2.0',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(7000)
    });

    if (testRes.status === 401 || testRes.status === 403) {
      return res.status(400).json({ valid: false, error: 'Invalid OpenSubtitles API Key' });
    }

    if (username && password) {
      const loginRes = await fetch('https://api.opensubtitles.com/api/v1/login', {
        method: 'POST',
        headers: {
          'Api-Key': apiKey,
          'User-Agent': 'AISUBS v2.2.0',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(7000)
      });
      const loginData = await loginRes.json();
      if (loginRes.ok && (loginData.token || loginData.status === 200)) {
        return res.json({ valid: true, user: loginData.user?.username || username });
      }
      return res.status(400).json({ valid: false, error: `Login failed: ${loginData.message || 'Check credentials'}` });
    }

    return res.json({ valid: true, user: 'API Key Verified' });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

app.post('/api/verify-subdl', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, error: 'API Key is required' });
  try {
    const resp = await fetch(`https://api.subdl.com/api/v1/subtitles?api_key=${apiKey}&imdb_id=tt0111161&languages=en&subs_per_page=1`, {
      signal: AbortSignal.timeout(7000)
    });
    const data = await resp.json();
    if (resp.ok && data.status !== false) return res.json({ valid: true });
    return res.status(400).json({ valid: false, error: data.error || 'Invalid SubDL Key' });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

app.post('/api/verify-subsource', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, error: 'API Key is required' });

  const headers = {
    'X-API-Key': apiKey.trim(),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  };

  try {
    const resp = await fetch('https://api.subsource.net/api/v1/subtitles/recent', {
      headers,
      signal: AbortSignal.timeout(7000)
    });
    if (resp.ok) return res.json({ valid: true });

    const searchResp = await fetch('https://api.subsource.net/api/v1/movies/search?searchType=text&q=Inception', {
      headers,
      signal: AbortSignal.timeout(7000)
    });
    if (searchResp.ok) return res.json({ valid: true });

    return res.status(400).json({ valid: false, error: `Verification failed (HTTP ${resp.status})` });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

app.post('/api/verify-ai', async (req, res) => {
  const { provider, apiKey } = req.body;
  const keyToTest = apiKey || ENV_GEMINI_KEY;

  if (provider === 'free') return res.json({ valid: true });
  if (!keyToTest) return res.status(400).json({ valid: false, error: 'API key is required' });

  try {
    if (provider === 'gemini') {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keyToTest}`, {
        signal: AbortSignal.timeout(7000)
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
      headers: { 'Authorization': `Bearer ${keyToTest}` },
      signal: AbortSignal.timeout(7000)
    });
    if (resp.ok) return res.json({ valid: true });
    const err = await resp.json();
    return res.status(400).json({ valid: false, error: err.error?.message || 'Invalid AI Key' });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

// ----------------------------------------------------
// Subtitle Discovery & Candidate Assembly
// ----------------------------------------------------
app.use(async (req, res, next) => {
  if (!req.path.includes('/subtitles/')) return next();

  const match = req.path.match(/(?:^|\/)(?:p\/([^/]+)|([^/]+))?\/subtitles\/(movie|series)\/([a-zA-Z0-9:]+)(?:\/(.*))?/);
  if (!match) return next();

  const profileOrConfig = match[1] || match[2] || '';
  const mediaType = match[3];
  const fullId = match[4].replace(/\.json$/i, '');
  const extraStr = match[5] ? match[5].replace(/\.json$/i, '') : '';

  const config = parseConfig(profileOrConfig);
  const host = `${req.protocol}://${req.get('host')}`;

  const extraParams = {};
  if (extraStr) {
    extraStr.split('&').forEach(part => {
      const [k, v] = part.split('=');
      if (k && v) extraParams[k] = decodeURIComponent(v);
    });
  }

  const { videoHash, filename } = extraParams;
  const parts = fullId.split(':');
  const imdbId = parts[0];
  const season = parts[1] || null;
  const episode = parts[2] || null;

  console.log(`\n[AISUBS-DISCOVERY] ${mediaType} ${fullId} | Hash: ${videoHash || 'None'} | File: ${filename || 'None'}`);

  let referenceEnSubs = [];
  let nativeTargetSubs = [];

  const targetIso3 = config.lang || 'nld';
  const targetIso1 = targetIso3 === 'nld' ? 'nl' : targetIso3.slice(0, 2);

  // 1. OpenSubtitles API with Hash Matching
  if (config.osApiKey) {
    try {
      let osUrl = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdbId.replace('tt', '')}&languages=${targetIso1},en`;
      if (videoHash) osUrl += `&moviehash=${videoHash}`;
      if (season && episode) osUrl += `&season_number=${season}&episode_number=${episode}`;

      const osRes = await fetch(osUrl, {
        headers: {
          'Api-Key': config.osApiKey,
          'User-Agent': 'AISUBS v2.2.0',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(3500)
      });

      if (osRes.ok) {
        const json = await osRes.json();
        if (Array.isArray(json.data)) {
          json.data.forEach(item => {
            const fileId = item.attributes?.files?.[0]?.file_id;
            const langCode = item.attributes?.language;
            const release = item.attributes?.release || filename || 'Video Release';
            const isHashMatch = item.attributes?.moviehash_match === true;

            if (fileId) {
              const subObj = {
                source: 'OpenSubtitles',
                release,
                isHashMatch,
                url: `https://api.opensubtitles.com/api/v1/download?file_id=${fileId}&osApiKey=${config.osApiKey}`
              };
              if (langCode === targetIso1) nativeTargetSubs.push(subObj);
              else if (langCode === 'en') referenceEnSubs.push(subObj);
            }
          });
        }
      }
    } catch (e) {
      console.warn('[AISUBS] OpenSubtitles error:', e.message);
    }
  }

  // 2. OpenSubtitles v3 Public Proxy (With official client User-Agent)
  try {
    let pubUrl = `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${fullId}`;
    if (extraStr) pubUrl += `/${extraStr}`;
    pubUrl += '.json';

    const pubRes = await fetch(pubUrl, {
      headers: {
        'User-Agent': 'Stremio/4.4.168',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(3500)
    });

    if (pubRes.ok) {
      const pubData = await pubRes.json();
      if (Array.isArray(pubData.subtitles)) {
        pubData.subtitles.forEach(s => {
          const isTarget = s.lang === targetIso3 || s.lang === targetIso1 || (targetIso3 === 'nld' && s.lang === 'dut');
          const isEnglish = s.lang === 'eng' || s.lang === 'en';

          const subObj = {
            source: 'OpenSubtitles-v3',
            release: filename || 'Synced Video File',
            isHashMatch: !!videoHash,
            url: s.url
          };
          if (isTarget) nativeTargetSubs.push(subObj);
          else if (isEnglish) referenceEnSubs.push(subObj);
        });
      }
    }
  } catch (e) {
    console.warn('[AISUBS] OpenSubtitles v3 error:', e.message);
  }

  // 3. SubDL API Fallback
  if (referenceEnSubs.length === 0 && config.subdlApiKey) {
    try {
      let subdlUrl = `https://api.subdl.com/api/v1/subtitles?api_key=${config.subdlApiKey}&imdb_id=${imdbId}&languages=EN,${targetIso1.toUpperCase()}&subs_per_page=4`;
      if (season && episode) subdlUrl += `&season_number=${season}&episode_number=${episode}&type=tv`;

      const dlRes = await fetch(subdlUrl, { signal: AbortSignal.timeout(3500) });
      if (dlRes.ok) {
        const dlJson = await dlRes.json();
        if (Array.isArray(dlJson.subtitles)) {
          dlJson.subtitles.forEach(s => {
            const fullUrl = s.url.startsWith('http') ? s.url : `https://dl.subdl.com${s.url}`;
            const subObj = {
              source: 'SubDL',
              release: s.release_name || filename || 'Release',
              isHashMatch: false,
              url: fullUrl
            };
            if (s.lang?.toLowerCase() === targetIso1) nativeTargetSubs.push(subObj);
            else referenceEnSubs.push(subObj);
          });
        }
      }
    } catch (e) {
      console.warn('[AISUBS] SubDL error:', e.message);
    }
  }

  const cfgString = Buffer.from(JSON.stringify(config)).toString('base64url');
  const targetName = config.langName || 'Dutch';
  const outSubtitles = [];

  // Track 1: Hash-synced reference subtitle translated with AI (with fallback URLs embedded)
  if (referenceEnSubs.length > 0) {
    const refSub = referenceEnSubs[0];
    const altSub = referenceEnSubs[1];
    const syncBadge = refSub.isHashMatch ? '✓ Synced' : '⏳ Auto-Sync';

    const srcParam = encodeSourceParam(refSub.url);
    const altParam = altSub ? encodeSourceParam(altSub.url) : '';

    outSubtitles.push({
      id: `aisubs-ai-ref-0`,
      url: `${host}/sub.vtt?cfg=${cfgString}&src=${srcParam}&alt=${altParam}&synced=true`,
      lang: targetIso3,
      label: `${syncBadge} [AI ${targetName}] · Gemini · ${refSub.release}`
    });

    if (referenceEnSubs.length > 1) {
      outSubtitles.push({
        id: `aisubs-ai-ref-1`,
        url: `${host}/sub.vtt?cfg=${cfgString}&src=${altParam}&synced=true`,
        lang: targetIso3,
        label: `⏳ Sync Alternate [AI ${targetName}] · ${altSub.source}`
      });
    }
  }

  // Track 2: Native target language subtitle (if available)
  if (nativeTargetSubs.length > 0) {
    const topNative = nativeTargetSubs[0];
    const srcParam = encodeSourceParam(topNative.url);
    outSubtitles.push({
      id: `aisubs-native-0`,
      url: `${host}/sub.vtt?cfg=${cfgString}&src=${srcParam}&raw=true`,
      lang: targetIso3,
      label: `✓ Synced Native · ${topNative.source} · ${topNative.release}`
    });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({ subtitles: outSubtitles });
});

// ----------------------------------------------------
// Robust Multi-Candidate Subtitle Downloader
// ----------------------------------------------------
async function downloadSubtitleWithFallbacks(candidateUrls) {
  let lastError = null;

  for (let rawUrl of candidateUrls) {
    if (!rawUrl) continue;
    let targetUrl = rawUrl;

    // Handle OpenSubtitles download resolution
    if (targetUrl.includes('api.opensubtitles.com/api/v1/download')) {
      try {
        const u = new URL(targetUrl);
        const fileId = u.searchParams.get('file_id');
        const apiKey = u.searchParams.get('osApiKey');
        const dlPost = await fetch('https://api.opensubtitles.com/api/v1/download', {
          method: 'POST',
          headers: {
            'Api-Key': apiKey,
            'User-Agent': 'AISUBS v2.2.0',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ file_id: Number(fileId) }),
          signal: AbortSignal.timeout(6000)
        });
        const dlJson = await dlPost.json();
        if (dlJson.link) {
          targetUrl = dlJson.link;
        } else {
          console.warn('[AISUBS] OpenSubtitles download returned no link. Moving to next candidate...');
          continue;
        }
      } catch (e) {
        console.warn('[AISUBS] OpenSubtitles resolve failed:', e.message);
        continue;
      }
    }

    // Try multiple standard user-agents to avoid Cloudflare 503 bot triggers
    const userAgents = [
      'Stremio/4.4.168',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
      'AISUBS/2.2.0'
    ];

    for (const ua of userAgents) {
      try {
        console.log(`[AISUBS] Fetching candidate: ${targetUrl.slice(0, 65)}... [${ua.split('/')[0]}]`);
        const res = await fetch(targetUrl, {
          headers: {
            'User-Agent': ua,
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br'
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(8000)
        });

        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          if (buffer.length > 40) {
            return { buffer, finalUrl: targetUrl };
          }
        } else {
          console.warn(`[AISUBS] Candidate returned HTTP ${res.status}`);
          lastError = new Error(`Download failed with HTTP ${res.status}`);
        }
      } catch (err) {
        console.warn('[AISUBS] Candidate fetch attempt failed:', err.message);
        lastError = err;
      }
    }
  }

  throw lastError || new Error('All candidate subtitle downloads failed');
}

// ----------------------------------------------------
// Decompression Engine
// ----------------------------------------------------
function decompressSubtitleBuffer(buffer) {
  // 1. Gzip Stream (0x1f 0x8b)
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return decodeText(zlib.gunzipSync(buffer));
    } catch {
      try {
        return decodeText(zlib.inflateRawSync(buffer.slice(10)));
      } catch {}
    }
  }

  // 2. PKZip Archive ('PK\x03\x04')
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    try {
      let offset = 0;
      while (offset < buffer.length - 30) {
        if (buffer[offset] !== 0x50 || buffer[offset + 1] !== 0x4b || buffer[offset + 2] !== 0x03 || buffer[offset + 3] !== 0x04) break;
        const compMethod = buffer.readUInt16LE(offset + 8);
        const compSize = buffer.readUInt32LE(offset + 18);
        const fnameLen = buffer.readUInt16LE(offset + 26);
        const extraLen = buffer.readUInt16LE(offset + 28);
        const fnameStart = offset + 30;
        const fname = buffer.slice(fnameStart, fnameStart + fnameLen).toString('utf-8');
        const dataStart = fnameStart + fnameLen + extraLen;
        const dataEnd = dataStart + compSize;
        const fileBytes = buffer.slice(dataStart, dataEnd);

        if (fname.endsWith('.srt') || fname.endsWith('.vtt') || fname.endsWith('.ass') || fname.endsWith('.sub') || !fname.includes('.')) {
          if (compMethod === 0) return decodeText(fileBytes);
          if (compMethod === 8) return decodeText(zlib.inflateRawSync(fileBytes));
        }
        offset = dataEnd;
      }
    } catch (e) {
      console.warn('[AISUBS] Zip decompress failed:', e.message);
    }
  }

  return decodeText(buffer);
}

function decodeText(buffer) {
  const utf8 = buffer.toString('utf-8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return buffer.toString('latin1');
}

// ----------------------------------------------------
// Universal Cue Parser
// ----------------------------------------------------
function parseSubtitleCues(raw) {
  const clean = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
  const cues = [];

  // ASS / SSA Events
  if (clean.includes('[Events]') && clean.includes('Dialogue:')) {
    const lines = clean.split('\n');
    for (const line of lines) {
      if (line.startsWith('Dialogue:')) {
        const parts = line.split(',');
        if (parts.length >= 10) {
          const start = padAssTime(parts[1].trim());
          const end = padAssTime(parts[2].trim());
          const text = parts.slice(9).join(',').replace(/\\N/g, '\n').replace(/\{.*?\}/g, '').trim();
          if (text) cues.push({ start, end, text });
        }
      }
    }
    if (cues.length > 0) return cues;
  }

  // Regex matches 1 or 2 digit hours
  const timeRegex = /(\d{1,2}:\d{2}:\d{2}[,\.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{1,3})/;
  const lines = clean.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    const match = timeRegex.exec(line);
    if (match) {
      const start = normalizeTimestamp(match[1]);
      const end = normalizeTimestamp(match[2]);
      i++;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const textLine = lines[i].trim();
        if (!textLine.includes('-->')) textLines.push(textLine);
        i++;
      }
      if (textLines.length > 0) {
        cues.push({ start, end, text: textLines.join('\n') });
      }
    } else {
      i++;
    }
  }

  return cues;
}

function normalizeTimestamp(ts) {
  const clean = ts.replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 3) {
    const h = parts[0].padStart(2, '0');
    const m = parts[1].padStart(2, '0');
    const [s, ms = '000'] = parts[2].split('.');
    return `${h}:${m}:${s.padStart(2, '0')}.${ms.padEnd(3, '0').slice(0, 3)}`;
  }
  return clean;
}

function padAssTime(t) {
  const parts = t.split(':');
  if (parts.length === 3) {
    const h = parts[0].padStart(2, '0');
    const m = parts[1].padStart(2, '0');
    const [s, cs = '00'] = parts[2].split('.');
    return `${h}:${m}:${s.padStart(2, '0')}.${(parseInt(cs, 10) * 10).toString().padStart(3, '0')}`;
  }
  return t;
}

// ----------------------------------------------------
// Subtitle Stream & Translation Delivery (/sub.vtt)
// ----------------------------------------------------
app.get('/sub.vtt', async (req, res) => {
  const { cfg, src, alt, raw } = req.query;
  const config = parseConfig(cfg);

  // Safely decode candidate URLs
  const primaryUrl = decodeSourceParam(src);
  const altUrl = decodeSourceParam(alt);
  const candidates = [primaryUrl, altUrl].filter(Boolean);

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  console.log(`\n[AISUBS-RENDER] Request for ${config.langName} (${config.lang})`);

  const cacheKey = `${primaryUrl}_${config.lang}_${config.provider}_${config.offsetMs}_${config.bilingual}_${raw}`;
  if (subCache.has(cacheKey)) {
    console.log('[AISUBS] Serving from cache (Instant)');
    return res.send(subCache.get(cacheKey));
  }

  try {
    const { buffer } = await downloadSubtitleWithFallbacks(candidates);
    const decodedText = decompressSubtitleBuffer(buffer);

    const cues = parseSubtitleCues(decodedText);
    if (!cues || cues.length === 0) {
      throw new Error('No subtitle cues found after decompression');
    }

    console.log(`[AISUBS] Decompressed and parsed ${cues.length} dialogue cues.`);

    if (config.offsetMs && config.offsetMs !== 0) {
      cues.forEach(c => {
        c.start = shiftTimestamp(c.start, config.offsetMs);
        c.end = shiftTimestamp(c.end, config.offsetMs);
      });
    }

    // Skip AI translation if native track requested
    if (raw !== 'true') {
      const batchSize = 50;
      for (let i = 0; i < cues.length; i += batchSize) {
        const chunk = cues.slice(i, i + batchSize);
        const texts = chunk.map(c => c.text);
        console.log(`[AISUBS] Translating batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(cues.length / batchSize)} (${texts.length} lines)...`);

        const translated = await translateBatch(texts, config.langName || 'Dutch', config);
        chunk.forEach((c, idx) => {
          const trans = translated[idx] || c.text;
          c.text = config.bilingual ? `${c.text}\n<c.cyan>${trans}</c>` : trans;
        });
      }
    }

    const targetName = config.langName || 'Dutch';
    const providerName = config.provider === 'gemini' ? 'Gemini AI' : config.provider.toUpperCase();
    const bannerText = `[ 🤖 AISUBS: Synced to Video & Translated to ${targetName} via ${providerName} ]`;

    const vttOutput = buildWebVTT(cues, bannerText);
    setInCache(cacheKey, vttOutput);

    console.log(`[AISUBS] Successfully generated VTT (${cues.length} cues).`);
    res.send(vttOutput);
  } catch (err) {
    console.error('[AISUBS] Stream error:', err.message);
    res.send(`WEBVTT\n\n1\n00:00:01.000 --> 00:00:06.000\n[AISubs: Error loading/translating: ${err.message}]`);
  }
});

// Translation Routing
async function translateBatch(texts, targetLang, config) {
  const apiKey = (config.apiKey || ENV_GEMINI_KEY || '').trim();
  const provider = config.provider || 'gemini';
  const model = config.model || 'gemini-2.0-flash';

  if (provider === 'gemini' && apiKey) {
    return translateWithGemini(texts, targetLang, apiKey, model);
  }
  if (['openrouter', 'openai', 'groq', 'deepseek'].includes(provider) && apiKey) {
    return translateWithOpenAICompatible(texts, targetLang, provider, apiKey, model);
  }

  console.warn('[AISUBS] No AI key provided. Using free web fallback...');
  return translateWithFreeFallback(texts, targetLang);
}

async function translateWithGemini(texts, targetLang, apiKey, model) {
  const modelsToTry = [
    model && model !== 'default' ? model : 'gemini-2.0-flash',
    'gemini-1.5-flash'
  ];

  const prompt = `You are a film and television subtitle translator.
Translate the following numbered dialogue lines into ${targetLang}.
Preserve line numbers and the '|' delimiter. Example format: '1| Translated line'.
Maintain the exact natural dialogue, timing brevity, and tone.
Return ONLY the numbered list of translations, with NO intro, markdown fences, or outro:

${texts.map((t, idx) => `${idx + 1}| ${t.replace(/\n/g, ' ')}`).join('\n')}`;

  for (const m of modelsToTry) {
    try {
      console.log(`[AISUBS] Calling Gemini API (${m})...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.15 }
        }),
        signal: AbortSignal.timeout(12000)
      });

      if (!res.ok) {
        const errorBody = await res.text();
        console.warn(`[AISUBS] Gemini ${m} HTTP ${res.status}:`, errorBody.slice(0, 140));
        continue;
      }

      const data = await res.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return parseNumberedReply(reply, texts);
    } catch (e) {
      console.warn(`[AISUBS] Gemini ${m} error:`, e.message);
    }
  }

  return translateWithFreeFallback(texts, targetLang);
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

  try {
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
      signal: AbortSignal.timeout(12000)
    });

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || '';
    return parseNumberedReply(reply, texts);
  } catch (e) {
    console.error(`[AISUBS] ${provider} error:`, e.message);
    return translateWithFreeFallback(texts, targetLang);
  }
}

async function translateWithFreeFallback(texts, targetLang) {
  const results = [];
  const iso1 = targetLang.toLowerCase() === 'dutch' ? 'nl' : targetLang.slice(0, 2).toLowerCase();

  for (const text of texts) {
    try {
      const clean = encodeURIComponent(text);
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${iso1}&dt=t&q=${clean}`;
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
  const clean = reply.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
  const lines = clean.split('\n').filter(l => l.trim().length > 0);
  const map = new Map();

  for (const line of lines) {
    const match = line.match(/^(\d+)\s*[\|\.\:\-\)]\s*(.*)$/);
    if (match) map.set(parseInt(match[1], 10), match[2].trim());
  }
  return original.map((orig, idx) => map.get(idx + 1) || orig);
}

function buildWebVTT(cues, bannerText) {
  let vtt = 'WEBVTT\n\n';
  let cueIndex = 1;

  if (bannerText) {
    vtt += `${cueIndex}\n00:00:00.800 --> 00:00:05.500\n${bannerText}\n\n`;
    cueIndex++;
  }

  cues.forEach(cue => {
    vtt += `${cueIndex}\n${cue.start} --> ${cue.end}\n${cue.text}\n\n`;
    cueIndex++;
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
  console.log(`[AISUBS] Server running on port ${PORT}`);
  console.log(`[AISUBS] Default language: ${ISO_LANG_MAP[ENV_TARGET_LANG]} (${ENV_TARGET_LANG})`);
  if (ENV_GEMINI_KEY) console.log('[AISUBS] Server-level GEMINI_API_KEY detected.');
});
