import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { getManifest } from './manifest.js';

const app = express();
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Behind Hugging Face / Render / nginx etc. req.protocol is "http" unless proxies are trusted.
// Without this, every subtitle URL we hand to Stremio/Nuvio is http:// and gets blocked.
app.set('trust proxy', true);

// Public base URL used inside subtitle URLs. Set PUBLIC_URL=https://your-host to pin it.
function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const host = req.get('host');
  const isLocal = /^(localhost|127\.|192\.168\.|10\.)/.test(host);
  const proto = isLocal ? req.protocol : 'https';
  return `${proto}://${host}`;
}
const PORT = process.env.PORT || 7860;

const ENV_GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || '';
const ENV_TARGET_LANG = process.env.TARGET_LANG || 'nld';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
// Serve ONLY the UI files. express.static('.') used to expose profiles.json (API keys) and server.js.
app.get(['/', '/index.html', '/configure', '/:config/configure', '/p/:profile/configure'],
  (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(ROOT, 'style.css')));

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
const inflight = new Map();   // cacheKey -> Promise<string>; stops duplicate translations when the player re-requests
const TRANSLATE_CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY) || 4;

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}
const MAX_CACHE_SIZE = 500;

function setInCache(key, vtt) {
  if (subCache.size >= MAX_CACHE_SIZE) {
    const firstKey = subCache.keys().next().value;
    subCache.delete(firstKey);
  }
  subCache.set(key, vtt);
}

const ISO_LANG_MAP = {
  nld: 'Dutch', dut: 'Dutch', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian',
  por: 'Portuguese', pob: 'Portuguese (Brazil)', rus: 'Russian', ara: 'Arabic',
  heb: 'Hebrew', tur: 'Turkish', pol: 'Polish', jpn: 'Japanese', kor: 'Korean',
  chi: 'Chinese', hin: 'Hindi', swe: 'Swedish', ell: 'Greek', ukr: 'Ukrainian',
  ind: 'Indonesian', ron: 'Romanian', ces: 'Czech', hun: 'Hungarian', dan: 'Danish'
};

function parseConfig(raw) {
  const baseDefault = {
    lang: 'nld',
    langName: 'Dutch',
    provider: ENV_GEMINI_KEY ? 'gemini' : 'gemini',
    apiKey: ENV_GEMINI_KEY,
    model: 'gemini-2.0-flash',
    offsetMs: 0,
    bilingual: false,
    torboxApiKey: '',
    osApiKey: '',
    osUsername: '',
    osPassword: '',
    subdlApiKey: '',
    subsourceApiKey: ''
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

function encodeSourceParam(url) {
  if (!url) return '';
  return Buffer.from(url, 'utf-8').toString('base64url');
}

function decodeSourceParam(param) {
  if (!param) return '';
  try {
    const decoded = Buffer.from(param, 'base64url').toString('utf-8');
    if (decoded.startsWith('http') || decoded.startsWith('os://')) return decoded;
  } catch {}
  return param;
}

// ----------------------------------------------------
// Scene Release Matching & Scoring Algorithm
// ----------------------------------------------------
function scoreSubtitleMatch(subReleaseName, videoFilename, isHashMatch = false) {
  if (isHashMatch) return 1000;

  let score = 0;
  const subClean = (subReleaseName || '').toLowerCase().replace(/[\.\-\_]/g, ' ');
  const vidClean = (videoFilename || '').toLowerCase().replace(/[\.\-\_]/g, ' ');

  const groups = ['flux', 'ntb', 'yify', 'yts', 'rarbg', 'psa', 'ion10', 'galaxyrg', 'cmrg', 'sparks', 'geckos', 'glhf', 'deflate', 'amzn', 'nf', 'atvp', 'dnp', 'qxr', 'swag'];
  for (const g of groups) {
    if (vidClean.includes(g) && subClean.includes(g)) score += 200;
  }

  const sources = ['web-dl', 'webdl', 'webrip', 'web', 'bluray', 'bdrip', 'brrip', 'hdtv', 'dvdrip', 'remux'];
  for (const s of sources) {
    if (vidClean.includes(s) && subClean.includes(s)) score += 120;
  }

  const res = ['2160p', '4k', '1080p', '720p', '480p'];
  for (const r of res) {
    if (vidClean.includes(r) && subClean.includes(r)) score += 60;
  }

  const codecs = ['x264', 'h264', 'x265', 'h265', 'hevc', 'av1', '10bit'];
  for (const c of codecs) {
    if (vidClean.includes(c) && subClean.includes(c)) score += 40;
  }

  const vidTokens = new Set(vidClean.split(/\s+/).filter(w => w.length > 2));
  const subTokens = new Set(subClean.split(/\s+/).filter(w => w.length > 2));
  let overlap = 0;
  for (const t of vidTokens) {
    if (subTokens.has(t)) overlap++;
  }
  score += overlap * 10;

  return score;
}

// ----------------------------------------------------
// Verification Endpoints
// ----------------------------------------------------
app.post('/api/verify-torbox', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, error: 'TorBox API key required' });

  try {
    const resp = await fetch('https://api.torbox.app/v1/api/user/me', {
      headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(6000)
    });
    const data = await resp.json();
    if (resp.ok && data.success) {
      return res.json({ valid: true, user: data.data?.email || 'TorBox Pro' });
    }
    return res.status(400).json({ valid: false, error: data.detail || 'Invalid TorBox Key' });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

app.post('/api/verify-opensubtitles', async (req, res) => {
  const { apiKey, username, password } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, error: 'API Key is required' });

  try {
    const testRes = await fetch('https://api.opensubtitles.com/api/v1/subtitles?imdb_id=0111161&languages=en', {
      headers: {
        'Api-Key': apiKey,
        'User-Agent': 'AISUBS v2.5.0',
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
          'User-Agent': 'AISUBS v2.5.0',
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

app.post('/api/profiles/save', (req, res) => {
  const { name, config } = req.body;
  if (!name || !config) return res.status(400).json({ error: 'Name and config required' });

  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
  savedProfiles[slug] = config;
  persistProfiles();

  res.json({ success: true, slug, url: `${req.protocol}://${req.get('host')}/p/${slug}/manifest.json` });
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
// Subtitle Discovery: Release-Scoring & Embedded Sync
// ----------------------------------------------------
// Stremio subtitle request shapes (config/profile prefix is optional):
//   /subtitles/movie/tt0111161.json
//   /subtitles/series/tt0944947:1:2/filename=...&videoHash=...&videoSize=....json
//   /<config>/subtitles/...   and   /p/<profile>/subtitles/...
const SUB_PATH_RE = /^(?:\/p\/([^/]+)|\/([^/]+))?\/subtitles\/(movie|series)\/([^/]+?)(?:\.json)?(?:\/(.+?))?(?:\.json)?$/;

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function langHelpers(config) {
  const iso3 = (config.lang || 'nld').toLowerCase();
  const iso1 = (iso3 === 'nld' || iso3 === 'dut') ? 'nl' : iso3.slice(0, 2);
  const isTarget = (c) => {
    c = (c || '').toLowerCase();
    return c === iso3 || c === iso1 || (iso1 === 'nl' && (c === 'nld' || c === 'dut'));
  };
  const isEnglish = (c) => ['eng', 'en'].includes((c || '').toLowerCase());
  return { iso3, iso1, isTarget, isEnglish };
}

async function fromStremioOpenSubs(mediaType, fullId, extraStr, filename, videoHash, L) {
  let url = `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${fullId}`;
  if (extraStr) url += `/${extraStr}`;
  url += '.json';
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Stremio/4.4.168', Accept: 'application/json' },
    signal: AbortSignal.timeout(4000)
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.subtitles || [])
    .filter(s => s.url && (L.isTarget(s.lang) || L.isEnglish(s.lang)))
    .map(s => {
      const release = filename || s.id || 'Video';
      return {
        source: 'OpenSubtitles-v3', release, isHashMatch: false, isEmbedded: false,
        // The v3 proxy already ranks by hash/size when videoHash is sent, so its order is meaningful.
        score: scoreSubtitleMatch(release, filename || '', false),
        lang: s.lang, url: s.url
      };
    });
}

async function fromOpenSubsApi(config, imdbId, season, episode, videoHash, filename, L) {
  const params = new URLSearchParams({ languages: `${L.iso1},en` });
  if (season && episode) {
    params.set('parent_imdb_id', imdbId.replace(/^tt/, ''));
    params.set('season_number', season);
    params.set('episode_number', episode);
  } else {
    params.set('imdb_id', imdbId.replace(/^tt/, ''));
  }
  if (videoHash) params.set('moviehash', videoHash);

  const r = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?${params}`, {
    headers: { 'Api-Key': config.osApiKey, 'User-Agent': 'AISUBS v2.5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(4000)
  });
  if (!r.ok) return [];
  const json = await r.json();
  return (json.data || []).flatMap(item => {
    const fileId = item.attributes?.files?.[0]?.file_id;
    if (!fileId) return [];
    const release = item.attributes?.release || filename || 'Release';
    const isHashMatch = item.attributes?.moviehash_match === true;
    return [{
      source: 'OpenSubtitles', release, isHashMatch, isEmbedded: false,
      score: scoreSubtitleMatch(release, filename || '', isHashMatch),
      lang: item.attributes?.language,
      // Opaque reference: the API key is resolved server-side, never put in a URL the client can see.
      url: `os://${fileId}`
    }];
  });
}

async function fromSubDL(config, imdbId, season, episode, filename, L) {
  let url = `https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(config.subdlApiKey)}` +
            `&imdb_id=${imdbId}&languages=EN,${L.iso1.toUpperCase()}&subs_per_page=5`;
  if (season && episode) url += `&season_number=${season}&episode_number=${episode}&type=tv`;
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) return [];
  const json = await r.json();
  return (json.subtitles || []).filter(s => s.url).map(s => {
    const release = s.release_name || filename || 'Release';
    const code = (s.language || s.lang || '').toLowerCase();
    return {
      source: 'SubDL', release, isHashMatch: false, isEmbedded: false,
      score: scoreSubtitleMatch(release, filename || '', false),
      lang: L.isTarget(code) ? L.iso1 : 'en',
      url: s.url.startsWith('http') ? s.url : `https://dl.subdl.com${s.url}`
    };
  });
}

app.get(/\/subtitles\//, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const m = SUB_PATH_RE.exec(req.path);
  if (!m) return res.json({ subtitles: [] });

  const profileOrConfig = m[1] || m[2] || '';
  const mediaType = m[3];
  const fullId = safeDecode(m[4]);            // handles tt123%3A1%3A2 as sent by some clients
  const extraStr = m[5] || '';

  const extraParams = {};
  extraStr.split('&').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) extraParams[part.slice(0, i)] = safeDecode(part.slice(i + 1));
  });
  const { videoHash, filename } = extraParams;

  const [imdbId, season = null, episode = null] = fullId.split(':');
  console.log(`\n[AISUBS-DISCOVERY] ${mediaType} ${fullId} | Hash: ${videoHash || 'None'} | File: ${filename || 'None'}`);

  // Our providers are IMDb-based; anything else gets a valid, empty answer instead of garbage lookups.
  if (!/^tt\d+$/.test(imdbId)) return res.json({ subtitles: [] });

  const config = parseConfig(profileOrConfig);
  const L = langHelpers(config);

  // All providers in parallel: worst case ~4s total instead of 4 x 3.5s in series.
  const jobs = [fromStremioOpenSubs(mediaType, fullId, extraStr, filename, videoHash, L)];
  if (config.osApiKey)    jobs.push(fromOpenSubsApi(config, imdbId, season, episode, videoHash, filename, L));
  if (config.subdlApiKey) jobs.push(fromSubDL(config, imdbId, season, episode, filename, L));

  const settled = await Promise.allSettled(jobs);
  settled.forEach(s => s.status === 'rejected' && console.warn('[AISUBS] provider error:', s.reason?.message));
  const candidateSubs = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));

  const rankedEn = candidateSubs.filter(s => L.isEnglish(s.lang)).sort((a, b) => b.score - a.score);
  const rankedTarget = candidateSubs.filter(s => L.isTarget(s.lang)).sort((a, b) => b.score - a.score);

  const base = publicBase(req);
  const cfg = encodeURIComponent(profileOrConfig);   // pass through what the user installed; no re-encoding of secrets
  const targetName = config.langName || 'Dutch';
  const out = [];

  if (rankedEn.length > 0) {
    const best = rankedEn[0];
    const alt = rankedEn[1] || null;
    const tag = (best.score >= 200 || best.isHashMatch)
      ? `✓ Synced [Release Match → ${targetName}]`
      : `⏳ Auto-Sync [AI ${targetName}]`;

    out.push({
      id: 'aisubs-ai-top',
      url: `${base}/sub.vtt?cfg=${cfg}&type=${mediaType}&id=${encodeURIComponent(fullId)}` +
           `&src=${encodeSourceParam(best.url)}${alt ? `&alt=${encodeSourceParam(alt.url)}` : ''}`,
      lang: L.iso3,
      label: `${tag} · ${best.release}`
    });
    if (alt) {
      out.push({
        id: 'aisubs-ai-alt',
        url: `${base}/sub.vtt?cfg=${cfg}&type=${mediaType}&id=${encodeURIComponent(fullId)}&src=${encodeSourceParam(alt.url)}`,
        lang: L.iso3,
        label: `⏳ Alternate [AI ${targetName}] · ${alt.source}`
      });
    }
  }

  if (rankedTarget.length > 0) {
    const top = rankedTarget[0];
    out.push({
      id: 'aisubs-native-0',
      url: `${base}/sub.vtt?cfg=${cfg}&type=${mediaType}&id=${encodeURIComponent(fullId)}&src=${encodeSourceParam(top.url)}&raw=true`,
      lang: L.iso3,
      label: `✓ Native · ${top.source} · ${top.release}`
    });
  }

  return res.json({ subtitles: out });
});

// ----------------------------------------------------
// Resilient Multi-Candidate Subtitle Downloader & Live Rescue
// ----------------------------------------------------
async function downloadSubtitleWithFallbacks(candidateUrls, mediaType, fullId, config = {}) {
  let lastError = null;

  for (let rawUrl of candidateUrls) {
    if (!rawUrl) continue;
    let targetUrl = rawUrl;

    if (targetUrl.startsWith('os://')) {
      try {
        const fileId = targetUrl.slice(5);
        const dlPost = await fetch('https://api.opensubtitles.com/api/v1/download', {
          method: 'POST',
          headers: {
            'Api-Key': config.osApiKey,
            'User-Agent': 'AISUBS v2.5.0',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ file_id: Number(fileId) }),
          signal: AbortSignal.timeout(5000)
        });
        const dlJson = await dlPost.json();
        if (!dlJson.link) {
          console.warn('[AISUBS] OpenSubtitles download returned no link:', dlJson.message || '');
          continue;
        }
        targetUrl = dlJson.link;
      } catch (e) {
        console.warn('[AISUBS] OpenSubtitles resolve warning:', e.message);
        continue;
      }
    }

    try {
      console.log(`[AISUBS] Downloading candidate: ${targetUrl.slice(0, 70)}...`);
      const res = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Stremio/4.4.168', 'Accept': '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000)
      });

      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        if (buffer.length > 40) return { buffer, finalUrl: targetUrl };
      } else {
        console.warn(`[AISUBS] Candidate returned HTTP ${res.status}`);
        lastError = new Error(`Download failed with HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('[AISUBS] Candidate download failed:', err.message);
      lastError = err;
    }
  }

  // Live Rescue Fallback via Stremio CDN
  if (mediaType && fullId) {
    console.log(`[AISUBS] Initiating Live Rescue for ${mediaType} ${fullId}...`);
    try {
      const rescueUrl = `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${fullId}.json`;
      const rescueRes = await fetch(rescueUrl, {
        headers: { 'User-Agent': 'Stremio/4.4.168', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });

      if (rescueRes.ok) {
        const rescueData = await rescueRes.json();
        if (Array.isArray(rescueData.subtitles)) {
          const enList = rescueData.subtitles.filter(s => s.lang === 'eng' || s.lang === 'en');
          const pool = enList.length > 0 ? enList : rescueData.subtitles;

          for (const s of pool.slice(0, 3)) {
            try {
              console.log(`[AISUBS] Attempting rescue candidate: ${s.url.slice(0, 70)}...`);
              const fileRes = await fetch(s.url, {
                headers: { 'User-Agent': 'Stremio/4.4.168', 'Accept': '*/*' },
                redirect: 'follow',
                signal: AbortSignal.timeout(8000)
              });
              if (fileRes.ok) {
                const arrayBuf = await fileRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuf);
                if (buffer.length > 40) return { buffer, finalUrl: s.url };
              }
            } catch (err) {
              console.warn('[AISUBS] Rescue candidate failed:', err.message);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[AISUBS] Rescue query failed:', err.message);
    }
  }

  throw lastError || new Error('All candidate subtitle downloads failed');
}

// ----------------------------------------------------
// Decompression Engine
// ----------------------------------------------------
function decompressSubtitleBuffer(buffer) {
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return decodeText(zlib.gunzipSync(buffer));
    } catch {
      try {
        return decodeText(zlib.inflateRawSync(buffer.slice(10)));
      } catch {}
    }
  }

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
      if (textLines.length > 0) cues.push({ start, end, text: textLines.join('\n') });
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
async function generateVtt({ config, candidates, type, id, raw }) {
  const { buffer } = await downloadSubtitleWithFallbacks(candidates, type, id, config);
  const cues = parseSubtitleCues(decompressSubtitleBuffer(buffer));
  if (!cues || cues.length === 0) throw new Error('No subtitle cues found after decompression');
  console.log(`[AISUBS] Parsed ${cues.length} cues.`);

  if (config.offsetMs) {
    cues.forEach(c => {
      c.start = shiftTimestamp(c.start, config.offsetMs);
      c.end = shiftTimestamp(c.end, config.offsetMs);
    });
  }

  if (raw !== 'true') {
    const batchSize = 50;
    const batches = [];
    for (let i = 0; i < cues.length; i += batchSize) batches.push(cues.slice(i, i + batchSize));

    await mapPool(batches, TRANSLATE_CONCURRENCY, async (chunk, bi) => {
      console.log(`[AISUBS] Translating batch ${bi + 1}/${batches.length} (${chunk.length} lines)...`);
      const translated = await translateBatch(chunk.map(c => c.text), config.langName || 'Dutch', config);
      chunk.forEach((c, idx) => {
        const trans = translated[idx] || c.text;
        c.text = config.bilingual ? `${c.text}\n<c.cyan>${trans}</c>` : trans;
      });
    });
  }

  const providerName = config.provider === 'gemini' ? 'Gemini AI' : String(config.provider).toUpperCase();
  const banner = raw === 'true' ? '' : `[ 🤖 AISUBS: Translated to ${config.langName || 'Dutch'} via ${providerName} ]`;
  return buildWebVTT(cues, banner);
}

app.get('/sub.vtt', async (req, res) => {
  const { cfg, src, alt, type, id, raw } = req.query;
  const config = parseConfig(cfg);
  const primaryUrl = decodeSourceParam(src);
  const candidates = [primaryUrl, decodeSourceParam(alt)].filter(Boolean);

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const cacheKey = `${primaryUrl || id}_${config.lang}_${config.provider}_${config.offsetMs}_${config.bilingual}_${raw}`;
  if (subCache.has(cacheKey)) return res.send(subCache.get(cacheKey));

  try {
    let job = inflight.get(cacheKey);
    if (!job) {
      job = generateVtt({ config, candidates, type, id, raw });
      inflight.set(cacheKey, job);
      job.finally(() => inflight.delete(cacheKey)).catch(() => {});
    }
    const vtt = await job;
    setInCache(cacheKey, vtt);
    res.send(vtt);
  } catch (err) {
    console.error('[AISUBS] Stream error:', err.message);
    res.send(`WEBVTT\n\n1\n00:00:01.000 --> 00:00:06.000\n[AISubs: Error loading/translating: ${err.message}]\n`);
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
  const iso1 = targetLang.toLowerCase() === 'dutch' ? 'nl' : targetLang.slice(0, 2).toLowerCase();
  return mapPool(texts, 8, async (text) => {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${iso1}&dt=t&q=${encodeURIComponent(text)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const json = await r.json();
      return json[0]?.map(p => p[0]).join('') || text;
    } catch {
      return text;
    }
  });
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
  console.log(`[AISUBS] Target language default: ${ISO_LANG_MAP[ENV_TARGET_LANG]} (${ENV_TARGET_LANG})`);
  if (ENV_GEMINI_KEY) console.log('[AISUBS] Server-level GEMINI_API_KEY detected.');
});
