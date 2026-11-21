import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getManifest } from './manifest.js';

const app = express();
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Behind Hugging Face / Render / nginx etc. req.protocol is "http" unless proxies are trusted.
// Without this, every subtitle URL we hand to Stremio/Nuvio is http:// and gets blocked.
app.set('trust proxy', true);

// ---- Access control -------------------------------------------------------------------------------
// Set ACCESS_TOKEN (letters+digits, 12+ chars) in Render. Every URL that can spend your AI quota must then be
// prefixed with /k-<token>/ . The page, logo and the bare /manifest.json (used by your pinger) stay public: no secrets.
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || '').trim();
if (ACCESS_TOKEN && !/^[A-Za-z0-9]{12,}$/.test(ACCESS_TOKEN)) {
  console.error('[AISUBS] ACCESS_TOKEN must be 12+ characters, letters and numbers only. Fix it in Render > Environment.');
  process.exit(1);
}
const TOKEN_RE = /^\/k-([A-Za-z0-9]+)(?=\/|\?|$)/;
const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const hits = new Map();   // "ip:authed" -> { n, reset }
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, 60000).unref();
function overLimit(key, max) {
  const t = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < t) { hits.set(key, { n: 1, reset: t + 60000 }); return false; }
  return ++h.n > max;
}
const PUBLIC_PATHS = new Set(['/', '/index.html', '/style.css', '/logo.png', '/health', '/manifest.json']);

app.use((req, res, next) => {
  let authed = !ACCESS_TOKEN;
  const m = TOKEN_RE.exec(req.url);
  if (m) {
    if (ACCESS_TOKEN && safeEqual(m[1], ACCESS_TOKEN)) { authed = true; req.tokenPrefix = m[0]; }
    req.url = req.url.slice(m[0].length) || '/';
  }
  const isPublic = PUBLIC_PATHS.has(req.path) || req.path.endsWith('/configure');
  if (isPublic) return next();
  if (overLimit(`${req.ip}:${authed}`, authed ? 120 : 15)) return res.status(429).json({ error: 'Too many requests' });
  if (!authed) return res.status(404).json({ error: 'Not found' });   // 404, not 401: don't reveal the gate
  next();
});

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

// gemini-2.0-flash was shut down 2026-06-01 and gemini-1.5/2.5 are gone too. Any retired id that an old
// install URL, saved profile or the UI still sends is remapped, otherwise every call returns 404.
const GEMINI_DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];
const RETIRED_GEMINI = /^gemini-(1\.5|2\.0|2\.5)/;
function resolveGeminiModel(m) {
  return !m || m === 'default' || RETIRED_GEMINI.test(m) ? GEMINI_DEFAULT_MODEL : m;
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
// Serve ONLY the UI files. express.static('.') used to expose profiles.json (API keys) and server.js.
app.get(['/', '/index.html', '/configure', '/:config/configure', '/p/:profile/configure'],
  (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/health', (req, res) => res.send('ok'));

// ---- Uploaded subtitles (memory only: the newest 20 are kept until the server restarts) ---------------------
const uploads = new Map();   // id -> { id, name, imdb, season, episode, mode, bytes, cues, createdAt }
const MAX_UPLOADS = 20;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const uploadKey = (u) => (u.season ? `${u.imdb}:${u.season}:${u.episode}` : u.imdb);
const uploadsFor = (fullId) => [...uploads.values()].filter(u => uploadKey(u) === String(fullId).toLowerCase()).sort((a, b) => b.createdAt - a.createdAt);

function vttToSrt(vtt) {
  const out = [];
  let n = 1;
  for (const block of String(vtt).replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter(l => l.length);
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [from, to] = lines[ti].split('-->').map(x => x.trim().split(' ')[0].replace('.', ','));
    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '');
    if (!text.trim()) continue;
    out.push(`${n++}\n${from} --> ${to}\n${text}`);
  }
  return `${out.join('\n\n')}\n`;
}

// Asks Stremio's public Cinemeta what an IMDb id is, so a wrong kind (movie vs series) is caught at upload time.
async function lookupTitle(tt) {
  for (const kind of ['series', 'movie']) {
    try {
      const r = await fetch(`https://v3-cinemeta.strem.io/meta/${kind}/${tt}.json`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.meta?.name) return { kind, name: String(j.meta.name) };
    } catch (e) {
      return null;           // offline or slow: skip the check rather than block the upload
    }
  }
  return null;
}

// Translates a fresh upload in the background, so it is already done (⚡) when you open the title in Nuvio.
// It uses the same cache key and in-flight job as the player, so a player asking meanwhile simply joins it.
async function pretranslateUpload(rec, config) {
  const url = `upload://${rec.id}`;
  const id = uploadKey(rec);
  const cacheKey = vttCacheKey(config, [url], id, undefined);
  rec.status = 'translating';
  rec.error = null;
  try {
    let job = inflight.get(cacheKey);
    if (!job) {
      job = generateVtt({ config, candidates: [url], type: rec.season ? 'series' : 'movie', id, raw: undefined, refUrl: null });
      inflight.set(cacheKey, job);
      job.finally(() => inflight.delete(cacheKey)).catch(() => {});
    }
    const { vtt, cacheable } = await job;
    if (cacheable) {
      setInCache(cacheKey, vtt);
      rec.status = 'ready';
      console.log(`[AISUBS] Uploaded subtitle for ${id} is translated and ready.`);
    } else {
      rec.status = 'failed';
      rec.error = ((/Translation failed[^\n]*/.exec(vtt) || [])[0] || 'The translation did not complete (rate limit or an API problem).').slice(0, 200);
    }
  } catch (e) {
    rec.status = 'failed';
    rec.error = String(e.message || e).slice(0, 200);
  }
}

app.post('/api/uploads', async (req, res) => {
  try {
    const { name, data, imdb, season, episode, mode, cfg, translateNow } = req.body || {};
    const tt = String(imdb || '').trim().toLowerCase();
    if (!/^tt\d{5,10}$/.test(tt)) return res.status(400).json({ error: 'The IMDb id should look like tt1234567.' });
    const S = season ? Number(season) : null, E = episode ? Number(episode) : null;
    if (!!S !== !!E) return res.status(400).json({ error: 'Fill in both season and episode for a series, or leave both empty for a movie.' });
    if (S && (!Number.isInteger(S) || S < 1 || S > 99 || !Number.isInteger(E) || E < 1 || E > 999)) {
      return res.status(400).json({ error: 'Season and episode must be whole numbers.' });
    }
    if (!['translate', 'native'].includes(mode)) return res.status(400).json({ error: 'Choose what kind of file this is.' });

    const bytes = Buffer.from(String(data || ''), 'base64');
    if (!bytes.length) return res.status(400).json({ error: 'The file is empty.' });
    if (bytes.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'That file is too large (the limit is 2 MB).' });

    // A wrong season/episode is the usual reason an upload never shows up in the menu, so check what the id really is.
    const info = await lookupTitle(tt);
    if (info && info.kind === 'series' && !S) return res.status(400).json({ error: `${info.name} is a series: fill in the season and episode.` });
    if (info && info.kind === 'movie' && S) return res.status(400).json({ error: `${info.name} is a movie: leave season and episode empty.` });

    let cues;
    try {
      cues = parseSubtitleCues(decompressSubtitleBuffer(bytes, S && E ? { season: S, episode: E } : null));
    } catch (e) {
      return res.status(400).json({ error: `Could not read that file: ${e.message}` });
    }
    if (!cues || cues.length < 3) return res.status(400).json({ error: 'No subtitle lines were found in that file.' });

    const cleanName = String(name || 'subtitle').replace(/[\r\n<>:"|?*\\/]/g, ' ').trim().slice(0, 120) || 'subtitle';
    const rec = {
      id: crypto.randomBytes(6).toString('hex'), name: cleanName, title: info ? info.name : null, imdb: tt, season: S, episode: E,
      mode, bytes, cues: cues.length, createdAt: Date.now(), status: 'manual', error: null
    };
    for (const [k, u] of uploads) if (uploadKey(u) === uploadKey(rec) && u.mode === mode) uploads.delete(k);   // newer replaces older
    uploads.set(rec.id, rec);
    while (uploads.size > MAX_UPLOADS) uploads.delete(uploads.keys().next().value);
    console.log(`[AISUBS] Subtitle uploaded for ${uploadKey(rec)}${rec.title ? ` (${rec.title})` : ''}: ${mode}, ${cues.length} lines.`);

    if (mode === 'native') {
      rec.status = 'ready';                                           // used as it is: nothing to translate
    } else if (translateNow !== false) {
      const config = parseConfig(String(cfg || ''));
      if ((config.apiKey || ENV_GEMINI_KEY) && config.provider !== 'free') pretranslateUpload(rec, config);   // runs in the background
    }
    res.json({ id: rec.id, name: rec.name, title: rec.title, cues: rec.cues, status: rec.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/uploads', (req, res) => {
  res.json({
    uploads: [...uploads.values()].reverse().map(u => ({
      id: u.id, name: u.name, title: u.title, imdb: u.imdb, season: u.season, episode: u.episode, mode: u.mode, cues: u.cues, size: u.bytes.length, createdAt: u.createdAt, status: u.status, error: u.error
    }))
  });
});

app.delete('/api/uploads/:id', (req, res) => {
  res.json({ deleted: uploads.delete(req.params.id) });
});

// Translate an upload now and hand back an .srt to keep (costs the same as translating it in Nuvio).
app.post('/api/uploads/:id/translate', async (req, res) => {
  const u = uploads.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'That upload is no longer on the server (a restart clears them). Upload it again.' });
  if (u.mode !== 'translate') return res.status(400).json({ error: 'This file is already in your language, so there is nothing to translate.' });
  const config = parseConfig(String(req.body?.cfg || ''));
  try {
    const result = await generateVtt({
      config, candidates: [`upload://${u.id}`], type: u.season ? 'series' : 'movie', id: uploadKey(u), raw: undefined, refUrl: null, noBanner: true
    });
    if (!result.cacheable) {
      return res.status(502).json({ error: 'The translation did not complete (rate limit or an API problem). Check the status page, then try again.' });
    }
    const srt = vttToSrt(result.vtt);
    res.json({ filename: `${u.name.replace(/\.[^.]+$/, '')}.${config.lang || 'nld'}.srt`, srt, cues: result.cues, missed: result.missed || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Status page: not in PUBLIC_PATHS, so it needs the /k-TOKEN address whenever ACCESS_TOKEN is set.
const STATUS_HTML = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0c0d11"><link rel="icon" href="/logo.png"><title>AISUBS status</title>
<style>
:root{--bg:#0c0d11;--surface:#14161c;--raised:#1b1e26;--line:#2a2e38;--text:#eceef3;--muted:#8a93a6;--accent:#ffd23f;--ok:#3ddc97;--err:#ff6b6b}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:1.5rem 1rem 3rem;display:flex;justify-content:center}
main{width:100%;max-width:640px}
header{display:flex;align-items:center;gap:.9rem;margin-bottom:1.25rem}
header img{width:48px;height:48px;border-radius:12px}
h1{font-size:1.5rem;letter-spacing:-.02em;line-height:1.1}
.sub{color:var(--muted);font-size:.82rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin-bottom:1rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:.9rem 1rem}
.card .k{color:var(--muted);font-size:.78rem}
.card .v{font-size:1.45rem;font-weight:700;margin-top:.15rem}
h2{font-size:1rem;margin:1.3rem 0 .5rem}
.box{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.row{padding:.7rem 1rem;border-top:1px solid var(--line);font-size:.88rem;word-break:break-word}
.row:first-child{border-top:0}
.row .m{color:var(--muted);font-size:.78rem;margin-top:.1rem}
.ok{color:var(--ok)}.bad{color:var(--err)}.muted{color:var(--muted)}
.kv{display:flex;justify-content:space-between;gap:1rem;padding:.55rem 1rem;border-top:1px solid var(--line);font-size:.88rem}
.kv:first-child{border-top:0}.kv span:first-child{color:var(--muted)}
.cur{margin-left:auto;background:var(--raised);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:.45rem .85rem;font-size:.85rem;cursor:pointer;white-space:nowrap}
.cur:hover{border-color:var(--accent);color:var(--accent)}
</style></head><body><main>
<header><img src="/logo.png" alt=""><div><h1>AISUBS status</h1><div class="sub" id="upd">loading...</div></div><button class="cur" id="cur" type="button">Show in \u20AC</button></header>
<div class="grid" id="cards"></div>
<h2>OpenSubtitles</h2><div class="box" id="os"></div>
<h2>Saved subtitles (Upstash)</h2><div class="box" id="store"></div>
<h2>Recent translations</h2><div class="box" id="recent"></div>
<h2>Recent problems</h2><div class="box" id="errs"></div>
<p class="sub" style="margin-top:1.2rem" id="foot"></p>
</main>
<script>
function $(id){return document.getElementById(id);}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function ago(ms){var s=Math.max(0,Math.round(ms/1000));if(s<60)return s+'s ago';if(s<3600)return Math.round(s/60)+' min ago';if(s<86400)return Math.round(s/3600)+' h ago';return Math.round(s/86400)+' d ago';}
function dur(s){if(s<60)return Math.round(s)+'s';if(s<3600)return Math.floor(s/60)+'m '+Math.round(s%60)+'s';return Math.floor(s/3600)+'h '+Math.round((s%3600)/60)+'m';}
var cur='USD';try{cur=localStorage.getItem('aisubsCur')||'USD';}catch(e){}
var fx={eurPerUsd:0.86};var last=null;
function money(x){var v=cur==='EUR'?x*fx.eurPerUsd:x;return (cur==='EUR'?'\u20AC':'$')+(v<1?v.toFixed(4):v.toFixed(2));}
$('cur').onclick=function(){cur=cur==='EUR'?'USD':'EUR';try{localStorage.setItem('aisubsCur',cur);}catch(e){}if(last)render(last);};
function title(id){var p=String(id).split(':');return p.length>=3?p[0]+' S'+String(p[1]).padStart(2,'0')+'E'+String(p[2]).padStart(2,'0'):String(id);}
function card(k,v){var c=el('div','card');c.appendChild(el('div','k',k));c.appendChild(el('div','v',v));return c;}
function kv(box,k,v,cls){var r=el('div','kv');r.appendChild(el('span','',k));r.appendChild(el('span',cls||'',v));box.appendChild(r);}
function render(d){
  var t=d.totals;fx=d.fx||fx;last=d;
  $('cur').textContent=cur==='EUR'?'Show in $':'Show in \u20AC';
  var c=$('cards');c.textContent='';
  c.appendChild(card('Cost since restart',money(t.usd)));
  c.appendChild(card('Translations',String(t.count)+(t.failed?' ('+t.failed+' failed)':'')));
  c.appendChild(card('Average time',t.count?dur(t.avgSecs):'-'));
  c.appendChild(card('Server uptime',dur(d.uptimeSec)));
  var os=$('os');os.textContent='';var o=d.openSubtitles;
  kv(os,'Login',o.loginAt?'OK ('+o.user+')':(o.lastLoginError?'failed':'not used yet'),o.loginAt?'ok':(o.lastLoginError?'bad':'muted'));
  if(o.allowance!==null)kv(os,'Daily allowance',String(o.allowance)+(o.vip?' (VIP)':''));
  if(o.remaining!==null)kv(os,'Downloads left',String(o.remaining)+(o.remainingEstimated?' (estimated, daily reset at 00:00 UTC)':(o.remainingAt?' (checked '+ago(d.now-o.remainingAt)+')':'')));
  if(o.lastLoginError)kv(os,'Last login error',o.lastLoginError,'bad');
  kv(os,'Quota',o.quotaUsedUntil?'used up - hidden until 00:00 UTC':'available',o.quotaUsedUntil?'bad':'ok');
  var stg=$('store');stg.textContent='';var sg=d.storage||{};
  if(!sg.configured){kv(stg,'Status','not set up (memory only)','muted');}
  else{
    var bad=sg.pausedNow||sg.pingOk===false;
    kv(stg,'Status',sg.pausedNow?'problem - paused for a moment':(sg.pingOk===false?'cannot connect':'connected'),bad?'bad':'ok');
    kv(stg,'Saved this session',String(sg.saves));
    kv(stg,'Loaded from storage',String(sg.hits));
    kv(stg,'Kept for',sg.ttlDays+' days');
    if(sg.lastError)kv(stg,'Last problem',sg.lastError,'bad');
  }
  var rc=$('recent');rc.textContent='';
  if(!d.recent.length){rc.appendChild(el('div','row muted','Nothing translated since the last restart.'));}
  d.recent.slice(0,10).forEach(function(e){
    var r=el('div','row');
    var h=el('div','',(e.ok?'\u2705 ':'\u274C ')+title(e.id));r.appendChild(h);
    r.appendChild(el('div','m',e.cues+' lines'+(e.missed?' ('+e.missed+' missed)':'')+' \u00B7 '+dur(e.secs)+' \u00B7 '+money(e.usd)+' \u00B7 '+(e.model||'')+' \u00B7 '+ago(d.now-e.at)));
    rc.appendChild(r);
  });
  var er=$('errs');er.textContent='';
  if(!d.errors.length){er.appendChild(el('div','row ok','No problems recorded.'));}
  d.errors.slice(0,8).forEach(function(e){var r=el('div','row');r.appendChild(el('div','bad',e.text));r.appendChild(el('div','m',ago(d.now-e.at)));er.appendChild(r);});
  $('upd').textContent='Updated '+new Date(d.now).toLocaleTimeString()+' \u00B7 since last restart \u00B7 refreshes every 15s';
  var used={};d.recent.forEach(function(e){String(e.model).split(' + ').forEach(function(m){used[m]=1;});});if(d.modelInUse)used[d.modelInUse]=1;
  var pr=Object.keys(used).map(function(m){var p=d.prices[m];return p?m+' $'+p[0]+' in / $'+p[1]+' out':m+' (price not in table, Flash-Lite rate used)';}).join(' \u00B7 ');
  $('foot').textContent=(t.aliased?t.aliased+' duplicate track requests skipped \u00B7 ':'')+(d.modelInUse?'Model in use '+d.modelInUse+' (from your install page)':'Model in use: not seen yet')+' \u00B7 fallback default '+d.model+' \u00B7 '+d.savedTranslations+' saved translations in memory \u00B7 pace '+d.pacing.minIntervalMs+' ms, '+d.pacing.concurrency+' at a time \u00B7 prices per 1M tokens: '+(pr||'none used yet')+' \u00B7 1 USD = '+fx.eurPerUsd.toFixed(4)+' EUR ('+fx.source+(fx.date?' '+fx.date:'')+')';
}
function load(){fetch('status.json',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(render).catch(function(e){$('upd').textContent='Could not load: '+e.message;});}
load();setInterval(load,15000);
</script></body></html>`;
app.get('/status.json', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  await Promise.all([refreshFx(), refreshOsQuota()]);
  if (UPSTASH_ON && Date.now() - upstashState.lastPingAt > 5 * 60 * 1000) {   // re-check the connection every 5 minutes
    upstashState.lastPingAt = Date.now();
    upstashState.pingOk = !!(await upstashCall('', ['PING']));
  }
  res.json(statusSnapshot());
});
app.get('/status', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.type('html').send(STATUS_HTML); });
app.get('/style.css', (req, res) => res.sendFile(path.join(ROOT, 'style.css')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(ROOT, 'logo.png')));

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
const TRANSLATE_CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY) || 2;
const failCache = new Map();   // cacheKey -> { vtt, until }: stops the player re-triggering a failing job in a loop

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
    model: GEMINI_DEFAULT_MODEL,
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
    if (decoded.startsWith('http') || decoded.startsWith('os://') || decoded.startsWith('subsource://') || decoded.startsWith('upload://')) return decoded;
  } catch {}
  return param;
}

// ----------------------------------------------------
// Scene Release Matching & Scoring Algorithm
// ----------------------------------------------------
// Release group = the text after the last "-" of the file name, e.g. "...H.264-EDITH[EZTVx.to].mkv" -> "edith".
// (A fixed list of groups can never keep up, so the group is read from the name itself.)
const GENERIC_TAIL = new Set(['dl', 'rip', 'web', 'webdl', 'webrip', 'hdtv', 'hdrip', 'bdrip', 'brrip', 'dvdrip', 'bluray', 'remux', 'hdr', 'dv',
  'atmos', 'aac', 'ac3', 'dts', 'ddp5', 'h264', 'h265', 'x264', 'x265', 'hevc', 'avc', 'av1', 'mkv', 'mp4', 'srt', 'sub', 'subs', 'eng', 'en', 'nl']);
function releaseGroupOf(name) {
  let n = String(name || '');
  const ext = n.search(/\.(mkv|mp4|avi|ts|m4v|srt|vtt|ass|ssa|zip)(?![a-z0-9])/i);
  if (ext >= 0) n = n.slice(0, ext);                              // drop anything after the extension (" H265 🇬🇧")
  n = n.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').trim();             // drop [EZTVx.to] and (tags)
  const m = /-\s*([a-z0-9]+)(?:[. ][a-z0-9]+)*\s*$/i.exec(n);
  const g = m ? m[1].toLowerCase() : '';
  return (g.length >= 3 && !GENERIC_TAIL.has(g) && !/^\d+p$/.test(g)) ? g : '';
}

function scoreSubtitleMatch(subReleaseName, videoFilename, isHashMatch = false) {
  if (isHashMatch) return 1000;

  let score = 0;
  const clean = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const subClean = clean(subReleaseName);
  const vidClean = clean(videoFilename);

  // Same release group as your video (read from the names, so any group works).
  const vidGroup = releaseGroupOf(videoFilename);
  let countedGroup = '';
  if (vidGroup && new Set(subClean.split(' ')).has(vidGroup)) { score += 200; countedGroup = vidGroup; }

  const groups = ['flux', 'ntb', 'yify', 'yts', 'rarbg', 'psa', 'ion10', 'galaxyrg', 'cmrg', 'sparks', 'geckos', 'glhf', 'deflate', 'amzn', 'nf', 'atvp', 'dnp', 'qxr', 'swag'];
  for (const g of groups) {
    if (g === countedGroup) continue;
    if (vidClean.includes(g) && subClean.includes(g)) score += 200;
  }

  const sources = ['web-dl', 'webdl', 'webrip', 'web', 'bluray', 'bdrip', 'brrip', 'hdtv', 'dvdrip', 'remux'];
  for (const src of sources) {
    if (vidClean.includes(src) && subClean.includes(src)) score += 120;
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

  const slug = `${name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 20)}-${crypto.randomBytes(8).toString('hex')}`;
  savedProfiles[slug] = config;
  persistProfiles();

  res.json({ success: true, slug, url: `${publicBase(req)}${req.tokenPrefix || ''}/p/${slug}/manifest.json` });
});

// ----------------------------------------------------
// Manifest Routes
// ----------------------------------------------------
app.get(['/manifest.json', '/p/:profile/manifest.json', '/:param/manifest.json'], (req, res) => {
  const param = req.params.profile || req.params.param || '';
  const config = parseConfig(param);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(getManifest(config, publicBase(req)));
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
        // The v3 proxy doesn't tell us anything about each subtitle, so no match score (shows as unverified);
        // its own ordering is kept because the sort below is stable.
        score: 0,
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
  params.set('machine_translated', 'include');   // by default these are left out of results
  params.set('ai_translated', 'include');

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
    const machineKind = item.attributes?.ai_translated ? 'ai' : (item.attributes?.machine_translated ? 'machine' : null);
    return [{
      source: 'OpenSubtitles', release, isHashMatch, isEmbedded: false,
      score: scoreSubtitleMatch(release, filename || '', isHashMatch),
      lang: item.attributes?.language, machine: !!machineKind, machineKind,
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

// ---- SubSource (needs the SubSource API key from the page) ----------------------------------------
// Flow (as used by Bazarr): find the title id by IMDb id, then list subtitles per language (lowercase English
// language name), then download /subtitles/<id>/download (a zip). Response field names are read defensively.
const SUBSOURCE_BASE = 'https://api.subsource.net/api/v1';
const listFrom = (j) => Array.isArray(j) ? j : (j?.data || j?.subtitles || j?.results || j?.movies || []);

// Finds SubSource's own title id. Tries the IMDb search first; on rejection, falls back to a title-text search
// (title looked up from Stremio's public Cinemeta). Every rejection is logged with the server's reply.
async function subsourceFindTitle(headers, imdbId, season) {
  const search = async (qs) => {
    try {
      const r = await fetch(`${SUBSOURCE_BASE}/movies/search?${qs}`, { headers, signal: AbortSignal.timeout(4000) });
      if (!r.ok) {
        const body = (await r.text()).replace(/\s+/g, ' ').slice(0, 200);
        console.warn(`[AISUBS] SubSource title search (${qs.slice(0, 45)}) HTTP ${r.status}: ${body}`);
        return [];
      }
      return listFrom(await r.json());
    } catch (e) {
      console.warn('[AISUBS] SubSource title search error:', e.message);
      return [];
    }
  };

  // SubSource's reply to the wrong form was: 'imdb parameter is required when searchType is "imdb"'.
  let items = await search(`searchType=imdb&imdb=${encodeURIComponent(imdbId)}`);
  if (!items.length) {
    try {
      const kind = season ? 'series' : 'movie';
      const cm = await fetch(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`, { signal: AbortSignal.timeout(3000) });
      const name = cm.ok ? (await cm.json())?.meta?.name : null;
      if (name) items = await search(`searchType=text&q=${encodeURIComponent(name)}`);
    } catch (e) {
      console.warn('[AISUBS] Cinemeta title lookup failed:', e.message);
    }
  }
  if (!items.length) return null;

  const imdbOf = (i) => String(i.imdbId ?? i.imdb_id ?? i.imdb ?? '');
  // Series: SubSource lists one entry per season, so the season must match, not just the IMDb id.
  const seasonOf = (i) => Number(i.season);
  const pick = (season && (items.find(i => imdbOf(i) === imdbId && seasonOf(i) === Number(season))
                       || items.find(i => seasonOf(i) === Number(season))))
    || items.find(i => imdbOf(i) === imdbId)
    || items[0];
  const id = pick?.movieId ?? pick?.id;
  console.log(`[AISUBS] SubSource title: id=${id} season=${pick?.season ?? '-'} | fields: ${Object.keys(pick || {}).slice(0, 14).join(',')}`);
  return id || null;
}

// Season marks in a release name: "S02", "Season 2", ranges like "S01-S04". Returns true when the name clearly points at
// other seasons only (no mark = unknown = not a mismatch).
function packSeasonMismatch(names, season) {
  const want = Number(season);
  let sawMark = false;
  for (const n of names) {
    const range = /s0*(\d{1,2})\s*(?:-|~|to)\s*s?0*(\d{1,2})/i.exec(n);
    if (range) { sawMark = true; if (want >= Number(range[1]) && want <= Number(range[2])) return false; continue; }
    const marks = [...String(n).matchAll(/(?:^|[^a-z0-9])s0*(\d{1,2})(?![0-9]|[ ._-]?e\d)/gi)].map(m => Number(m[1]))
      .concat([...String(n).matchAll(/season[ ._-]*0*(\d{1,2})/gi)].map(m => Number(m[1])));
    if (marks.length) { sawMark = true; if (marks.includes(want)) return false; }
  }
  return sawMark;
}

async function fromSubSource(config, imdbId, season, episode, filename, L) {
  const headers = { 'X-API-Key': config.subsourceApiKey.trim(), 'User-Agent': 'AISUBS/2.6', Accept: 'application/json' };

  const movieId = await subsourceFindTitle(headers, imdbId, season);
  if (!movieId) return [];

  const epRe = (season && episode) ? episodeRegex(season, episode) : null;
  const langs = [
    { name: 'english', lang: 'en' },
    { name: (config.langName || 'Dutch').toLowerCase(), lang: L.iso1 }
  ];

  const perLang = await Promise.all(langs.map(async ({ name, lang }) => {
    try {
      const r = await fetch(`${SUBSOURCE_BASE}/subtitles?movieId=${encodeURIComponent(movieId)}&language=${encodeURIComponent(name)}`,
        { headers, signal: AbortSignal.timeout(4500) });
      if (!r.ok) { console.warn(`[AISUBS] SubSource list (${name}) HTTP ${r.status}`); return []; }
      const items = listFrom(await r.json());
      console.log(`[AISUBS] SubSource list (${name}): ${items.length} items${items[0] ? ` | fields: ${Object.keys(items[0]).slice(0, 14).join(',')}` : ''}`);
      if (items.length && !(items[0].subtitleId ?? items[0].id)) {
        console.warn('[AISUBS] SubSource: unexpected item shape, keys:', Object.keys(items[0]).join(','));
      }
      // Flags may arrive as true/false, 1/0 or "true"/"false"; only a real "yes" counts (a text "false" is truthy in JS).
      const isTrue = (v) => v === true || v === 1 || v === 'true' || v === '1';
      const dropped = { noId: 0, commentary: 0, foreign: 0, otherEpisode: 0 };
      const kept = items.flatMap(it => {
        const id = it.subtitleId ?? it.id;
        if (!id) { dropped.noId++; return []; }
        // Commentary tracks and "foreign parts only" (forced) subtitles are not full dialogue.
        if (isTrue(it.commentary)) { dropped.commentary++; return []; }
        if (isTrue(it.foreignParts)) { dropped.foreign++; return []; }

        // releaseInfo can be one name or a LIST of names (packs). Match against each; show the best-matching one.
        const names = [].concat(it.releaseInfo ?? it.release_info ?? it.release ?? it.name ?? '').map(String).filter(Boolean);
        const best = names.map(n => ({ n, sc: scoreSubtitleMatch(n, filename || '', false) })).sort((x, y) => y.sc - x.sc)[0] || { n: '', sc: 0 };

        // Series: exact episode names are best. Names with NO episode marker are usually season packs (the right
        // episode is picked from inside the zip). Names that point to a different episode are dropped.
        const exact = !epRe || names.some(n => epRe.test(n));
        const packLike = !!epRe && !exact && !names.some(n => EPISODE_MARK_RE.test(n));
        if (epRe && !exact && !packLike) { dropped.otherEpisode++; return []; }
        if (epRe && packLike && packSeasonMismatch(names, season)) { dropped.otherEpisode++; return []; }   // another season's pack
        const pack = packLike && Number(it.files) > 1;
        const hi = isTrue(it.hearingImpaired);
        return [{
          source: 'SubSource', release: `${best.n || filename || 'Release'}${pack ? ' [season pack]' : ''}${hi ? ' [HI]' : ''}`,
          isHashMatch: false, isEmbedded: false,
          // Hearing-impaired versions rank below plain dialogue; packs rank below exact-episode files.
          score: best.sc - (hi ? 40 : 0) - (packLike ? 60 : 0),
          lang, url: `subsource://${id}`
        }];
      });
      console.log(`[AISUBS] SubSource (${name}): ${items.length} listed -> ${kept.length} usable${epRe ? ' for this episode' : ''}`);
      if (!kept.length && items.length) {
        console.log('[AISUBS] SubSource dropped:', JSON.stringify(dropped));
        const f = items[0];
        console.log('[AISUBS] SubSource flag values (first item):', JSON.stringify({ commentary: f.commentary, foreignParts: f.foreignParts, hearingImpaired: f.hearingImpaired, files: f.files, releaseInfoIsList: Array.isArray(f.releaseInfo) }));
      }
      return kept.slice(0, 8);
    } catch (e) {
      console.warn(`[AISUBS] SubSource list (${name}) error:`, e.message);
      return [];
    }
  }));
  return perLang.flat();
}

// ✅ = made for your exact file (hash match). 🟡 = release name matches your file. ⚠️ = no match info (timing unverified).
const matchMarker = (c) => c.pinned ? '📂' : (c.isHashMatch || c.sync?.state === 'verified' || c.sync?.state === 'corrected')
  ? '✅' : (c.score >= 200 ? '🟡' : '⚠️');

function buildSubtitleTracks({ rankedEn, rankedTarget, targetName, iso3, mkUrl }) {
  const tracks = [];
  const used = new Set();
  const add = (id, source, url) => {
    let uid = id;
    if (used.has(uid)) uid = `${id} (${source})`;
    for (let n = 2; used.has(uid); n++) uid = `${id} (${source}) #${n}`;
    used.add(uid);
    tracks.push({ id: uid, url, lang: iso3, label: uid });
  };
  // Up to 4 English sources (one per source), each its own "translate this one" choice (the best also gets the runner-up as backup).
  rankedEn.slice(0, 4).forEach((c, i) => {
    add(`${matchMarker(c)}${c.ready ? (c.pinned ? '⚡' : ' ⚡') : ''} AI translation from ${c.pinned ? 'your upload' : 'English'} · ${c.release}`, c.source, mkUrl(c, (i === 0 && !c.pinned) ? rankedEn[1] : null, false));
  });
  // Up to 4 ready-made subtitles in your language: instant, no AI cost.
  rankedTarget.slice(0, 4).forEach(c => {
    const kind = c.pinned ? `${targetName} (your upload)` : c.machineKind === 'ai' ? 'AI translation' : (c.machine ? 'Machine translation' : `${targetName} (native)`);
    add(`${matchMarker(c)} ${kind} · ${c.release}`, c.source, mkUrl(c, null, true));
  });
  return tracks;
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
  stats.lastModel = resolveGeminiModel(config.model);
  const L = langHelpers(config);

  // All providers in parallel: worst case ~4s total instead of 4 x 3.5s in series.
  const jobs = [fromStremioOpenSubs(mediaType, fullId, extraStr, filename, videoHash, L)];
  if (config.osApiKey)    jobs.push(fromOpenSubsApi(config, imdbId, season, episode, videoHash, filename, L));
  if (config.subdlApiKey) jobs.push(fromSubDL(config, imdbId, season, episode, filename, L));
  if (config.subsourceApiKey) {
    // Hard 6s cap so a slow SubSource can never delay the whole subtitle list.
    jobs.push(Promise.race([fromSubSource(config, imdbId, season, episode, filename, L), sleep(6000).then(() => [])]));
  }

  const settled = await Promise.allSettled(jobs);
  settled.forEach(s => s.status === 'rejected' && console.warn('[AISUBS] provider error:', s.reason?.message));
  let candidateSubs = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));
  if (Date.now() < osQuotaUntil) candidateSubs = candidateSubs.filter(c => !String(c.url).startsWith('os://'));
  console.log('[AISUBS] candidates by source:', JSON.stringify(candidateSubs.reduce((m, c) => (m[c.source] = (m[c.source] || 0) + 1, m), {})));

  // Subtitles you uploaded for exactly this title (pinned to the top of the menu).
  for (const up of uploadsFor(fullId)) {
    candidateSubs.push({
      source: 'Upload', release: up.name, isHashMatch: false, isEmbedded: false, machine: false,
      score: 0, pinned: true, ready: up.status === 'ready' && up.mode === 'translate', lang: up.mode === 'native' ? L.iso3 : 'eng', url: `upload://${up.id}`
    });
  }

  // Exact-file matches first, then human-made before machine-made, then release-name score.
  const byQuality = (x, y) =>
    (Number(!!y.pinned) - Number(!!x.pinned)) ||                 // your uploads first
    (Number(!!y.isHashMatch) - Number(!!x.isHashMatch)) ||
    (Number(!!x.machine) - Number(!!y.machine)) ||
    (y.score - x.score);
  // Remember what we know: sync results from earlier plays, and which translations are already saved (ready).
  candidateSubs.forEach(c => {
    c.sync = syncStatus.get(c.url) || null;
    c.ready = !!c.ready || subCache.has(vttCacheKey(config, [c.url], fullId, undefined));
  });
  // Reference for timing checks: the file made for your exact video, else a very close release match.
  const refPool = candidateSubs.filter(c => !c.machine && !c.pinned);
  const refCand = refPool.filter(c => c.isHashMatch).sort(byQuality)[0]
    || refPool.filter(c => c.score >= STRONG_RELEASE_SCORE).sort(byQuality)[0] || null;

  // The menu shows the best subtitle from EACH source first (so every source gets a say), then fills up by quality.
  const diversify = (ranked, max) => {
    const picked = [], seen = new Set();
    for (const c of ranked) if (picked.length < max && !seen.has(c.source)) { seen.add(c.source); picked.push(c); }
    for (const c of ranked) if (picked.length < max && !picked.includes(c)) picked.push(c);
    return picked.sort(byQuality);
  };
  const rankedEn = diversify(candidateSubs.filter(c => L.isEnglish(c.lang)).sort(byQuality), 4);
  if (UPSTASH_ON) {                           // ⚡ for tracks that are saved in Upstash (e.g. translated before a restart)
    const todo = rankedEn.filter(c => !c.ready && !c.pinned);
    if (todo.length) {
      const flags = await upstashReadyFlags(todo.map(c => vttCacheKey(config, [c.url], fullId, undefined)));
      todo.forEach((c, i) => { if (flags[i]) c.ready = true; });
    }
  }
  const rankedTarget = candidateSubs.filter(c => L.isTarget(c.lang)).sort(byQuality);

  const base = publicBase(req) + (req.tokenPrefix || '');
  const cfg = encodeURIComponent(profileOrConfig);   // pass through what the user installed; no re-encoding of secrets
  const mkUrl = (c, alt, raw) =>
    `${base}/sub.vtt?cfg=${cfg}&type=${mediaType}&id=${encodeURIComponent(fullId)}&src=${encodeSourceParam(c.url)}` +
    `${alt ? `&alt=${encodeSourceParam(alt.url)}` : ''}${raw ? '&raw=true' : ''}` +
    `${refCand && refCand.url !== c.url && !c.pinned ? `&ref=${encodeSourceParam(refCand.url)}` : ''}` +
    `${filename ? `&fn=${encodeURIComponent(String(filename).slice(0, 200))}` : ''}`;

  const out = buildSubtitleTracks({
    rankedEn, rankedTarget, targetName: config.langName || 'Dutch', iso3: L.iso3, mkUrl
  });

  if (uploadsFor(fullId).length) console.log(`[AISUBS] Menu for ${fullId}: ${uploadsFor(fullId).length} uploaded subtitle(s) pinned on top.`);
  return res.json({ subtitles: out, cacheMaxAge: 10 });
});

// ----------------------------------------------------
// Resilient Multi-Candidate Subtitle Downloader & Live Rescue
// ----------------------------------------------------
// ---- OpenSubtitles login for downloads ----------------------------------------------------------------------
// Without a login the API allows only a handful of downloads a day. With the account details from the page, the
// server signs in once (token kept ~20h in memory) and sends it with every download.
const osTokens = new Map();    // username -> { token, base, until }
let osLastAuth = null;         // the most recent login, so the status page can check the live quota (never shown anywhere)

// Asks OpenSubtitles how many downloads are left today (it also counts downloads made elsewhere with this account).
// Best effort: if it fails, the page falls back to an estimate that knows about the daily reset.
async function refreshOsQuota() {
  const a = osLastAuth;
  if (!a || a.until < Date.now()) return;
  if (Date.now() - stats.os.lastQuotaCheck < 3 * 60 * 1000) return;     // at most every 3 minutes
  stats.os.lastQuotaCheck = Date.now();
  try {
    const r = await fetch(`${a.base}/api/v1/infos/user`, {
      headers: { 'Api-Key': a.apiKey, Authorization: `Bearer ${a.token}`, 'User-Agent': 'AISUBS v2.5.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(4000)
    });
    if (r.status === 401) { osTokens.delete(a.user); osLastAuth = null; return; }     // expired login: a new one is made on the next download
    const j = await r.json().catch(() => ({}));
    const d = j?.data ?? j;
    const left = Number(d?.remaining_downloads);
    if (!r.ok || !Number.isFinite(left)) throw new Error(`HTTP ${r.status}, no remaining_downloads in the reply`);
    stats.os.remaining = left;
    stats.os.remainingAt = Date.now();
    stats.os.lookupOk = true;
    if (Number.isFinite(Number(d.allowed_downloads))) stats.os.allowance = Number(d.allowed_downloads);
    if (left > 0) osQuotaUntil = 0;                                        // never keep hiding tracks on a stale "used up"
    else if (osQuotaUntil <= Date.now()) markOsQuotaUsed();
  } catch (e) {
    if (stats.os.lookupOk !== false) console.warn('[AISUBS] OpenSubtitles live quota check not available:', e.message, '- using an estimate.');
    stats.os.lookupOk = false;
  }
}
let osQuotaUntil = 0;          // while now < this, OpenSubtitles downloads are known to be used up (until 00:00 UTC)

function markOsQuotaUsed() {
  const d = new Date(Date.now());
  osQuotaUntil = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  console.log('[AISUBS] OpenSubtitles daily downloads used up - hiding its tracks until 00:00 UTC.');
  recordError('OpenSubtitles daily downloads used up - its tracks are hidden until 00:00 UTC.');
}

async function getOsAuth(config) {
  if (!config.osApiKey || !config.osUsername || !config.osPassword) return null;
  const cached = osTokens.get(config.osUsername);
  if (cached && cached.until > Date.now()) return cached;
  try {
    const r = await fetch('https://api.opensubtitles.com/api/v1/login', {
      method: 'POST',
      headers: { 'Api-Key': config.osApiKey, 'User-Agent': 'AISUBS v2.5.0', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: config.osUsername, password: config.osPassword }),
      signal: AbortSignal.timeout(7000)
    });
    const j = await r.json();
    if (!r.ok || !j.token) {
      console.warn(`[AISUBS] OpenSubtitles login failed (HTTP ${r.status}): ${j.message || 'check username/password'} - downloading without login.`);
      stats.os.lastLoginError = `HTTP ${r.status}: ${j.message || 'check username/password'}`;
      recordError(`OpenSubtitles login failed: ${stats.os.lastLoginError}`);
      return null;
    }
    const entry = { token: j.token, base: j.base_url ? `https://${j.base_url}` : 'https://api.opensubtitles.com', until: Date.now() + 20 * 3600 * 1000 };
    osTokens.set(config.osUsername, entry);
    osLastAuth = { token: entry.token, base: entry.base, apiKey: config.osApiKey, until: entry.until, user: config.osUsername };
    console.log(`[AISUBS] OpenSubtitles login OK (${config.osUsername}): daily allowance ${j.user?.allowed_downloads ?? '?'}${j.user?.vip ? ', VIP' : ''}.`);
    Object.assign(stats.os, { user: config.osUsername, allowance: j.user?.allowed_downloads ?? null, vip: !!j.user?.vip, loginAt: Date.now(), lastLoginError: null });
    return entry;
  } catch (e) {
    console.warn('[AISUBS] OpenSubtitles login error:', e.message, '- downloading without login.');
    return null;
  }
}

// Never write API keys into the logs (SubDL puts its key in the download URL).
const redactUrl = (u) => String(u).replace(/([?&](?:api_key|apikey|key|token)=)[^&]*/gi, '$1***');

async function downloadSubtitleWithFallbacks(candidateUrls, mediaType, fullId, config = {}) {
  let lastError = null;

  for (let rawUrl of candidateUrls) {
    if (!rawUrl) continue;
    let targetUrl = rawUrl;

    if (targetUrl.startsWith('upload://')) {            // your own uploaded file: no network involved
      const up = uploads.get(targetUrl.slice(9));
      if (up) return { buffer: up.bytes, finalUrl: targetUrl };
      lastError = new Error('The uploaded file is no longer on the server');
      continue;
    }

    if (targetUrl.startsWith('os://')) {
      try {
        const fileId = targetUrl.slice(5);
        const auth = await getOsAuth(config);
        const dlPost = await fetch(`${auth?.base || 'https://api.opensubtitles.com'}/api/v1/download`, {
          method: 'POST',
          headers: {
            'Api-Key': config.osApiKey,
            ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
            'User-Agent': 'AISUBS v2.5.0',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ file_id: Number(fileId) }),
          signal: AbortSignal.timeout(6000)
        });
        if (dlPost.status === 401 && auth) osTokens.delete(config.osUsername);   // expired token: log in again next time
        const dlJson = await dlPost.json();
        if (!dlJson.link) {
          const msg = String(dlJson.message || '');
          console.warn('[AISUBS] OpenSubtitles download returned no link:', msg);
          if (/allowed \d+ subtitles|quota|24h/i.test(msg)) markOsQuotaUsed();
          continue;
        }
        if (dlJson.remaining !== undefined) {
          console.log(`[AISUBS] OpenSubtitles downloads left today: ${dlJson.remaining}${auth ? '' : ' (no login sent)'}`);
          stats.os.remaining = dlJson.remaining;
          stats.os.remainingAt = Date.now();
        }
        targetUrl = dlJson.link;
      } catch (e) {
        console.warn('[AISUBS] OpenSubtitles resolve warning:', e.message);
        continue;
      }
    }

    let reqHeaders = { 'User-Agent': 'Stremio/4.4.168', 'Accept': '*/*' };
    if (targetUrl.startsWith('subsource://')) {
      if (!config.subsourceApiKey) continue;
      targetUrl = `${SUBSOURCE_BASE}/subtitles/${targetUrl.slice(12)}/download`;
      reqHeaders = { ...reqHeaders, 'X-API-Key': config.subsourceApiKey.trim() };
    }

    try {
      console.log(`[AISUBS] Downloading candidate: ${redactUrl(targetUrl).slice(0, 70)}...`);
      const res = await fetch(targetUrl, {
        headers: reqHeaders,
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
              console.log(`[AISUBS] Attempting rescue candidate: ${redactUrl(s.url).slice(0, 70)}...`);
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
// ---- Episode matching + zip handling (season packs hold one file per episode) ----------------------------
function episodeRegex(season, episode) {
  const S = Number(season), E = Number(episode);
  return new RegExp(`s0*${S}[ ._-]?e0*${E}(?!\\d)|(?:^|[^\\d])${S}x0*${E}(?!\\d)|(?:episode|ep)[ ._-]?0*${E}(?!\\d)`, 'i');
}
const EPISODE_MARK_RE = /s\d{1,2}[ ._-]?e\d{1,3}|(?:^|[^\d])\d{1,2}x\d{1,3}(?!\d)|(?:episode|ep)[ ._-]?\d/i;
const SUB_EXT_RE = /\.(srt|vtt|ass|ssa|sub)$/i;
const withFilename = (ep, filename) => (ep ? { ...ep, filename: filename || '' } : null);

const QUALITY_WORDS = new Set(['1080p', '720p', '2160p', '480p', '4k', 'web', 'dl', 'webdl', 'webrip', 'bluray', 'bdrip', 'brrip', 'hdtv', 'dvdrip',
  'remux', 'x264', 'x265', 'h264', 'h265', 'hevc', 'av1', 'aac', 'ac3', 'dts', 'ddp5', 'ddp', 'atmos', 'hdr', 'dv', '10bit', 'amzn', 'nf', 'atvp',
  'dsnp', 'hmax', 'hulu', 'srt', 'ass', 'vtt', 'eng', 'english', 'en', 'nl', 'dutch', 'hi', 'sdh', 'cc', 'forced', 'proper', 'repack', 'internal', 'multi', 'mkv', 'mp4']);
const TITLE_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into']);
// The episode TITLE in a file name = the words after SxxEyy and before the first quality word.
function episodeTitleTokens(name) {
  const base = String(name || '').split('/').pop().replace(/\.(srt|vtt|ass|ssa|sub|mkv|mp4)$/i, '');
  const m = /s\d{1,2}[ ._-]?e\d{1,3}|(?:^|[^\d])\d{1,2}x\d{1,3}(?!\d)/i.exec(base);
  if (!m) return [];
  const out = [];
  for (const w of base.slice(m.index + m[0].length).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (QUALITY_WORDS.has(w) || /^\d{3,4}p$/.test(w)) break;
    if (w.length >= 3 && !TITLE_STOP.has(w)) out.push(w);
  }
  return out;
}

// Chooses the right file inside a multi-episode zip.
//  1. files named for this season+episode; if several (versions), the closest release to your video, never an HI/SDH one first;
//  2. episode numbers differ between sources (air vs DVD order): if the numbered file carries a DIFFERENT title while another
//     file matches your video's episode title, the title wins;
//  3. nothing fits: refuse (a missing subtitle beats the wrong episode).
function pickPackEntry(subs, ep) {
  const re = episodeRegex(ep.season, ep.episode);
  const baseOf = (e) => e.name.split('/').pop();
  const vidTitle = ep.filename ? episodeTitleTokens(ep.filename) : [];
  const overlap = (a, b) => a.filter(w => b.includes(w)).length;
  const byNumber = subs.filter(e => re.test(baseOf(e)));
  let pool = byNumber, via = 'number';

  if (vidTitle.length >= 2) {
    const need = Math.max(2, Math.ceil(vidTitle.length * 0.6));
    const titleHits = subs.filter(e => overlap(vidTitle, episodeTitleTokens(baseOf(e))) >= need);
    const numberedAgree = byNumber.some(e => { const t = episodeTitleTokens(baseOf(e)); return t.length === 0 || overlap(vidTitle, t) > 0; });
    if (titleHits.length && !numberedAgree) { pool = titleHits; via = 'title'; }
  }
  if (!pool.length) {
    const sample = subs.slice(0, 4).map(baseOf).join(', ');
    throw new Error(`Episode not found in subtitle pack (${subs.length} files, e.g. ${sample.slice(0, 160)})`);
  }
  const rank = (e) => {
    const n = baseOf(e);
    const hi = /(^|[^a-z])(hi|sdh|cc)([^a-z]|$)/i.test(n);
    return overlap(vidTitle, episodeTitleTokens(n)) * 50 + scoreSubtitleMatch(n, ep.filename || '') - (hi ? 40 : 0);
  };
  const entry = [...pool].sort((x, y) => rank(y) - rank(x))[0];
  return { entry, matched: pool.length, via };
}

function episodeOf(type, id) {
  if (type !== 'series') return null;
  const [, S, E] = String(id).split(':');
  return (Number.isFinite(Number(S)) && Number.isFinite(Number(E)) && S && E) ? { season: Number(S), episode: Number(E) } : null;
}

// Reads the zip's central directory (reliable sizes), instead of walking local headers.
function listZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < count && p + 46 <= buffer.length; k++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), cmtLen = buffer.readUInt16LE(p + 32);
    entries.push({
      name: buffer.slice(p + 46, p + 46 + nameLen).toString('utf-8'),
      method: buffer.readUInt16LE(p + 10),
      compSize: buffer.readUInt32LE(p + 20),
      lho: buffer.readUInt32LE(p + 42)
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}
function readZipEntry(buffer, e) {
  const start = e.lho + 30 + buffer.readUInt16LE(e.lho + 26) + buffer.readUInt16LE(e.lho + 28);
  const data = buffer.slice(start, start + e.compSize);
  return e.method === 0 ? data : zlib.inflateRawSync(data);
}

// `ep` = { season, episode } for series. In a pack we pick that episode's file; if it isn't there we refuse
// (never fall back to "the first file", which would show another episode's subtitles).
function decompressSubtitleBuffer(buffer, ep = null) {
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
    const entries = listZipEntries(buffer);
    if (entries) {
      const subs = entries.filter(e => SUB_EXT_RE.test(e.name));
      let pick = subs[0];
      if (ep && subs.length > 1) {
        const r = pickPackEntry(subs, ep);
        pick = r.entry;
        console.log(`[AISUBS] Pack: using "${pick.name.split('/').pop().slice(0, 90)}" for S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} (${subs.length} files, ${r.matched} fit${r.via === 'title' ? ', chosen by episode TITLE because the numbering differs' : ''}).`);
      } else if (ep && subs.length === 1) {
        const only = subs[0].name.split('/').pop();
        if (EPISODE_MARK_RE.test(only) && !episodeRegex(ep.season, ep.episode).test(only)) {
          throw new Error(`The file in this zip is for another episode (${only.slice(0, 80)})`);
        }
      }
      if (pick) return decodeText(readZipEntry(buffer, pick));
    }
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
          const text = cleanCueText(parts.slice(9).join(',').replace(/\\N/g, '\n'));
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
      const text = cleanCueText(textLines.join('\n'));
      if (text) cues.push({ start, end, text });
    } else {
      i++;
    }
  }

  return cues;
}

// Many SRT/ASS-derived files carry positioning such as {\an8} (top of screen, used for signs/credits) or
// {\pos(x,y)}. Players apply these literally, which is why some lines jump to the top. We strip every
// override and emit cues WITHOUT VTT settings (no line:/position:/align:), so the player's own
// subtitle-position setting (Nuvio/Stremio) always applies. Must run BEFORE translation so the model can't mangle tags.
function cleanCueText(t) {
  return t
    .replace(/\{[^}]*\}/g, '')           // ASS/SSA override blocks: {\an8} {\pos(..)} {\i1} ...
    .replace(/\\an?[1-9]/g, '')        // stray \an8 without braces
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n');
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
// ---- Auto-sync against a reference subtitle ---------------------------------------------------------------
// Compares WHEN people speak (not what they say), so it also works across languages. The reference is a subtitle
// made for the exact file (hash match) or, failing that, a very close release-name match. Timing is only moved when
// the evidence is clear; otherwise the subtitle is left exactly as it was.
const STRONG_RELEASE_SCORE = 380;
const SYNC_F1_MIN = 0.55;      // how well the speech timelines must overlap
const SYNC_CONF_MIN = 0.12;    // ...and by how much that beats a random alignment
const SYNC_RATIOS = [1, 1.001001, 0.999, 1.042709, 0.95904, 1.041667, 0.96];   // 23.976 / 24 / 25 fps mix-ups
const syncStatus = new Map();  // candidate url -> { state: 'verified'|'corrected'|'unverified', lagSec, ratio, f1 }
const refCache = new Map();    // reference url -> Float64Array of [start, end, ...] in seconds

const tsToSec = (ts) => {
  const [h, m, rest] = ts.split(':');
  const [sec, ms = '0'] = rest.split('.');
  return Number(h) * 3600 + Number(m) * 60 + Number(sec) + Number(ms.padEnd(3, '0').slice(0, 3)) / 1000;
};
const secToTs = (sec) => {
  const t = Math.max(0, Math.round(sec * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor((t % 3600000) / 60000))}:${p(Math.floor((t % 60000) / 1000))}.${p(t % 1000, 3)}`;
};
const cuesToIntervals = (cues) => Float64Array.from(cues.flatMap(c => [tsToSec(c.start), tsToSec(c.end)]));
const maxEnd = (iv) => { let m = 0; for (let k = 1; k < iv.length; k += 2) if (iv[k] > m) m = iv[k]; return m; };

function speechBins(iv, scale, binSec, n) {
  const b = new Uint8Array(n);
  for (let k = 0; k < iv.length; k += 2) {
    const from = Math.max(0, Math.floor(iv[k] * scale / binSec));
    const to = Math.min(n, Math.ceil(iv[k + 1] * scale / binSec));
    for (let i = from; i < to; i++) b[i] = 1;
  }
  return b;
}

// F1 overlap between reference bins R and candidate bins C shifted forward by `lag`, for lag in [lo, hi].
function scanLags(R, C, lo, hi) {
  let sumR = 0, sumC = 0;
  for (let i = 0; i < R.length; i++) sumR += R[i];
  for (let i = 0; i < C.length; i++) sumC += C[i];
  const denom = (sumR + sumC) || 1;
  let best = -1, bestLag = 0, total = 0, n = 0;
  for (let lag = lo; lag <= hi; lag++) {
    const from = Math.max(0, lag), to = Math.min(R.length, C.length + lag);
    let ov = 0;
    for (let i = from; i < to; i++) ov += R[i] & C[i - lag];
    const f1 = (2 * ov) / denom;
    total += f1; n++;
    if (f1 > best) { best = f1; bestLag = lag; }
  }
  return { lag: bestLag, f1: best, baseline: total / n };
}

function findAlignment(refIv, candIv) {
  const coarse = 0.5, maxLagSec = 180, span = Math.round(maxLagSec / coarse);
  const endR = maxEnd(refIv), endC = maxEnd(candIv);
  const attempt = (r) => {
    const n = Math.ceil((Math.max(endR, endC * r) + maxLagSec + 5) / coarse);
    const res = scanLags(speechBins(refIv, 1, coarse, n), speechBins(candIv, r, coarse, n), -span, span);
    return { ratio: r, lagSec: res.lag * coarse, f1: res.f1, conf: res.f1 - res.baseline };
  };
  const clear = (x) => x.f1 >= SYNC_F1_MIN && x.conf >= SYNC_CONF_MIN;

  let best = attempt(1);
  if (!clear(best)) for (const r of SYNC_RATIOS.slice(1)) { const x = attempt(r); if (x.conf > best.conf) best = x; }
  if (!clear(best)) return { state: 'unverified', ...best };

  // Fine pass (0.1s) around the coarse answer.
  const fine = 0.1;
  const n = Math.ceil((Math.max(endR, endC * best.ratio) + maxLagSec + 5) / fine);
  const centre = Math.round(best.lagSec / fine), w = Math.round(1.0 / fine);
  const f = scanLags(speechBins(refIv, 1, fine, n), speechBins(candIv, best.ratio, fine, n), centre - w, centre + w);
  return { state: 'ok', ratio: best.ratio, lagSec: Math.round(f.lag * fine * 10) / 10, f1: f.f1, conf: best.conf };
}

async function alignToReference({ cues, refUrl, candUrl, config, type, id, filename = '' }) {
  try {
    if (cues.length < 50) return { state: 'unverified' };
    let refIv = refCache.get(refUrl);
    if (!refIv) {
      const { buffer } = await downloadSubtitleWithFallbacks([refUrl], type, id, config);
      const refCues = parseSubtitleCues(decompressSubtitleBuffer(buffer, withFilename(episodeOf(type, id), filename)));
      if (!refCues || refCues.length < 50) throw new Error('reference subtitle too short');
      refIv = cuesToIntervals(refCues);
      if (refCache.size >= 30) refCache.delete(refCache.keys().next().value);
      refCache.set(refUrl, refIv);
    }
    const a = findAlignment(refIv, cuesToIntervals(cues));
    let state = 'unverified';
    if (a.state === 'ok') {
      const inSync = a.ratio === 1 && Math.abs(a.lagSec) <= 0.35;
      state = inSync ? 'verified' : 'corrected';
      if (!inSync) {
        cues.forEach(c => {
          c.start = secToTs(tsToSec(c.start) * a.ratio + a.lagSec);
          c.end = secToTs(tsToSec(c.end) * a.ratio + a.lagSec);
        });
      }
    }
    const res = { state, lagSec: a.lagSec, ratio: a.ratio, f1: a.f1 };
    syncStatus.set(candUrl, res);
    return res;
  } catch (e) {
    console.warn('[AISUBS] Sync check skipped:', e.message);
    return { state: 'unverified' };
  }
}

// Long translated lines are split into two balanced lines so they read well on screen.
function wrapSubtitleLine(t) {
  if (t.includes('\n') || t.length <= 42) return t;
  const mid = t.length / 2;
  let best = -1, dist = Infinity;
  for (let i = 0; i < t.length; i++) if (t[i] === ' ' && Math.abs(i - mid) < dist) { dist = Math.abs(i - mid); best = i; }
  return best > 0 ? `${t.slice(0, best)}\n${t.slice(best + 1)}` : t;
}

async function fetchCuesFromCandidates(candidates, type, id, config, filename = '') {
  const ep = withFilename(episodeOf(type, id), filename);
  let lastErr = new Error('No subtitle candidates');
  for (const url of candidates) {
    try {
      const { buffer } = await downloadSubtitleWithFallbacks([url], type, id, config);
      const cues = parseSubtitleCues(decompressSubtitleBuffer(buffer, ep));
      if (cues && cues.length) return cues;
      lastErr = new Error('No subtitle cues found after decompression');
    } catch (e) {
      lastErr = e;
      console.warn(`[AISUBS] Candidate failed: ${e.message}`);
      recordError(`Subtitle download failed for ${id}: ${e.message}`);
    }
  }
  throw lastErr;
}

// ---- Status page data (kept in memory; resets on restart) -----------------------------------------------------
const stats = {
  startedAt: Date.now(),
  lastModel: null,   // model most recently requested by your install (not the server fallback)
  totals: { count: 0, failed: 0, aliased: 0, inTok: 0, outTok: 0, thinkTok: 0, usd: 0, secs: 0 },
  recent: [],    // newest first, max 50
  errors: [],    // newest first, max 20
  os: { user: null, allowance: null, vip: false, loginAt: null, remaining: null, remainingAt: null, lastQuotaCheck: 0, lookupOk: null, lastLoginError: null }
};
function recordError(text) {
  stats.errors.unshift({ at: Date.now(), text: String(text).slice(0, 220) });
  if (stats.errors.length > 20) stats.errors.pop();
}
function recordTranslation(e) {
  stats.recent.unshift({ at: Date.now(), ...e });
  if (stats.recent.length > 50) stats.recent.pop();
  stats.totals.count++;
  if (!e.ok) stats.totals.failed++;
  stats.totals.secs += e.secs;
}
function recordUsage(usage, usd) {
  if (!usage) return;
  stats.totals.inTok += usage.in || 0;
  stats.totals.outTok += usage.out || 0;
  stats.totals.thinkTok += usage.think || 0;
  stats.totals.usd += usd || 0;
}
// EUR conversion for the status page: ECB reference rate via Frankfurter (free, no key), refreshed twice a day.
// If the lookup fails, the last known rate (or EUR_PER_USD, default 0.86) is used and the page says so.
const fxState = { eurPerUsd: Number(process.env.EUR_PER_USD) || 0.86, date: null, source: 'fallback rate', nextTry: 0 };
async function refreshFx() {
  const now = Date.now();
  if (now < fxState.nextTry) return;
  fxState.nextTry = now + 3600e3;   // if this fails, try again in an hour
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const rate = Number(j?.rates?.EUR);
    if (!r.ok || !(rate > 0.3 && rate < 3)) throw new Error('unexpected reply');
    Object.assign(fxState, { eurPerUsd: rate, date: j.date || null, source: 'ECB via Frankfurter', nextTry: now + 12 * 3600e3 });
  } catch (e) {
    console.warn('[AISUBS] Exchange rate lookup failed:', e.message);
  }
}

function statusSnapshot() {
  const now = Date.now();
  const t = stats.totals;
  return {
    now, startedAt: stats.startedAt, uptimeSec: Math.round((now - stats.startedAt) / 1000),
    model: GEMINI_DEFAULT_MODEL,
    modelInUse: stats.lastModel,
    pacing: { minIntervalMs: GEMINI_MIN_INTERVAL_MS, concurrency: TRANSLATE_CONCURRENCY },
    prices: GEMINI_PRICES,
    fx: { eurPerUsd: fxState.eurPerUsd, date: fxState.date, source: fxState.source },
    totals: { ...t, avgSecs: t.count ? t.secs / t.count : 0 },
    savedTranslations: subCache.size,
    recent: stats.recent,
    errors: stats.errors,
    openSubtitles: (() => {
      const d = new Date(now);
      const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      // A reading from before today's 00:00 UTC reset is out of date: the daily allowance has been restored.
      const stale = !!stats.os.remainingAt && stats.os.remainingAt < dayStart && stats.os.allowance != null;
      return { ...stats.os, remaining: stale ? stats.os.allowance : stats.os.remaining, remainingEstimated: stale, quotaUsedUntil: osQuotaUntil > now ? osQuotaUntil : null };
    })(),
    storage: { configured: UPSTASH_ON, ttlDays: UPSTASH_TTL_DAYS, hits: upstashState.hits, misses: upstashState.misses, saves: upstashState.saves, errors: upstashState.errors, lastError: upstashState.lastError, pingOk: upstashState.pingOk, pausedNow: now < upstashState.pausedUntil }
  };
}

// ---- Saved subtitles in Upstash (optional second layer behind the memory cache) -------------------------------
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Render to switch it on. Finished subtitles are then kept
// across restarts and redeploys. Memory stays the fast first stop; if Upstash is slow or down, the addon simply behaves as
// before (memory only). Only finished subtitle text is stored (under a hashed key), never keys, passwords or settings.
let UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
if (UPSTASH_URL && !/^https?:\/\//i.test(UPSTASH_URL)) UPSTASH_URL = `https://${UPSTASH_URL}`;
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const UPSTASH_ON = !!(UPSTASH_URL && UPSTASH_TOKEN);
const UPSTASH_TTL_DAYS = Number(process.env.UPSTASH_TTL_DAYS) > 0 ? Number(process.env.UPSTASH_TTL_DAYS) : 90;
const UPSTASH_TTL_SEC = Math.round(UPSTASH_TTL_DAYS * 86400);
const upstashState = { hits: 0, misses: 0, saves: 0, errors: 0, fails: 0, lastError: null, lastOkAt: null, pausedUntil: 0, lastPingAt: 0, pingOk: null, lastLogAt: 0 };
const upstashKey = (cacheKey) => `aisubs:v1:${crypto.createHash('sha1').update(String(cacheKey)).digest('hex')}`;

function onUpstashError(e) {
  upstashState.errors++;
  upstashState.lastError = String(e.message || e).slice(0, 160);
  // A full database only refuses new writes (reads still work), so it is reported but never pauses reading.
  if (!/capacity quota/i.test(upstashState.lastError)) {
    upstashState.fails++;
    if (upstashState.fails >= 3) upstashState.pausedUntil = Date.now() + 2 * 60 * 1000;   // real outage: stop trying for 2 minutes
  }
  if (Date.now() - upstashState.lastLogAt > 60000) {
    upstashState.lastLogAt = Date.now();
    console.warn('[AISUBS] Upstash problem:', upstashState.lastError);
    recordError(`Upstash: ${upstashState.lastError}`);
  }
}

async function upstashCall(path, body) {
  if (!UPSTASH_ON || Date.now() < upstashState.pausedUntil) return null;
  try {
    const r = await fetch(UPSTASH_URL + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    upstashState.fails = 0;
    upstashState.lastOkAt = Date.now();
    return j;
  } catch (e) {
    onUpstashError(e);
    return null;
  }
}

async function upstashGetVtt(cacheKey) {
  const j = await upstashCall('', ['GET', upstashKey(cacheKey)]);
  if (!j) return null;
  if (!j.result) { upstashState.misses++; return null; }
  try {
    const vtt = zlib.gunzipSync(Buffer.from(String(j.result), 'base64')).toString('utf-8');
    upstashState.hits++;
    return vtt;
  } catch (e) {
    onUpstashError(new Error('a saved subtitle could not be read back'));
    return null;
  }
}

function upstashSaveVtt(cacheKey, vtt) {   // fire and forget: never makes a player wait
  if (!UPSTASH_ON) return;
  const packed = zlib.gzipSync(Buffer.from(vtt, 'utf-8')).toString('base64');
  upstashCall('', ['SET', upstashKey(cacheKey), packed, 'EX', UPSTASH_TTL_SEC]).then(j => { if (j) upstashState.saves++; });
}

async function upstashReadyFlags(cacheKeys) {   // which of these are already saved? (one request, tiny reply)
  const j = await upstashCall('/pipeline', cacheKeys.map(k => ['EXISTS', upstashKey(k)]));
  return Array.isArray(j) ? j.map(x => Number(x?.result) === 1) : cacheKeys.map(() => false);
}

if (UPSTASH_ON) {
  upstashCall('', ['PING']).then(j => {
    upstashState.pingOk = !!j; upstashState.lastPingAt = Date.now();
    console.log(j ? `[AISUBS] Upstash connected - subtitles are kept for ${UPSTASH_TTL_DAYS} days, across restarts.`
                  : '[AISUBS] Upstash is set up but not reachable yet - check the URL and token (see the status page).');
  });
} else {
  console.log('[AISUBS] Upstash not set up - saved subtitles live in memory only (lost on restart).');
}

// ---- Shared translations ---------------------------------------------------------------------------------
// Different sources often serve the SAME subtitle (e.g. SubDL mirrors SubSource). Subtitles with identical text,
// target language and model share one translation, running or finished, so it is only paid for once.
// USD per 1M tokens [input, output], from Google's published list prices (Nov 2026). Thinking tokens are billed as output.
// Prices change: set GEMINI_PRICES_JSON in Render for per-model changes (or PRICE_IN_PER_M + PRICE_OUT_PER_M for one price for all).
const GEMINI_PRICES = {
  'gemini-3.1-flash-lite': [0.25, 1.5],
  'gemini-3.5-flash-lite': [0.30, 2.5],
  'gemini-3.5-flash': [1.5, 9.0],
  'gemini-3.6-flash': [1.5, 7.5]
};
// Per-model overrides from Render: GEMINI_PRICES_JSON = {"gemini-3.6-flash":[1.5,7.5],"some-new-model":[0.4,3]}
// (each entry is [input, output] in USD per 1M tokens). New model names can be added the same way.
const PRICE_OVERRIDDEN = new Set();
try {
  const extra = JSON.parse(process.env.GEMINI_PRICES_JSON || '{}');
  for (const [m, p] of Object.entries(extra)) {
    if (Array.isArray(p) && p.length === 2 && p.every(x => Number.isFinite(Number(x)) && Number(x) >= 0)) {
      GEMINI_PRICES[m] = [Number(p[0]), Number(p[1])];
      PRICE_OVERRIDDEN.add(m);
    } else {
      console.warn(`[AISUBS] GEMINI_PRICES_JSON: "${m}" must look like [input, output] - ignored.`);
    }
  }
  if (PRICE_OVERRIDDEN.size) console.log('[AISUBS] Price overrides from GEMINI_PRICES_JSON:', [...PRICE_OVERRIDDEN].join(', '));
} catch (e) {
  console.warn('[AISUBS] GEMINI_PRICES_JSON is not valid JSON - ignoring it:', e.message);
}

function priceFor(model) {
  if (PRICE_OVERRIDDEN.has(model)) return GEMINI_PRICES[model];            // most specific wins
  const envIn = Number(process.env.PRICE_IN_PER_M), envOut = Number(process.env.PRICE_OUT_PER_M);
  if (envIn > 0 && envOut > 0) return [envIn, envOut];                      // one price for every other model
  return GEMINI_PRICES[model] || GEMINI_PRICES['gemini-3.1-flash-lite'];   // unknown model: assume Flash-Lite rates
}

async function translateAllTexts(sourceTexts, config) {
  const ctx = { errors: [], usage: { in: 0, out: 0, think: 0 }, usageByModel: {} };
  const batchSize = 100;
  const batches = [];
  for (let i = 0; i < sourceTexts.length; i += batchSize) batches.push({ start: i, texts: sourceTexts.slice(i, i + batchSize) });
  const out = new Array(sourceTexts.length).fill(null);

  await mapPool(batches, TRANSLATE_CONCURRENCY, async (b, bi) => {
    console.log(`[AISUBS] Translating batch ${bi + 1}/${batches.length} (${b.texts.length} lines)...`);
    const context = b.start === 0 ? [] : sourceTexts.slice(Math.max(0, b.start - 6), b.start);
    const translated = await translateBatch(b.texts, config.langName || 'Dutch', config, ctx, context);
    translated.forEach((t, k) => { out[b.start + k] = t; });
  });
  const u = ctx.usage;
  let usd = 0;
  const models = Object.keys(ctx.usageByModel);
  for (const m of models) {
    const t = ctx.usageByModel[m], [pin, pout] = priceFor(m);
    const cost = (t.in * pin + (t.out + t.think) * pout) / 1e6;
    usd += cost;
    console.log(`[AISUBS] Gemini usage (${m}): ${t.in} in, ${t.out} out, ${t.think} thinking = about $${cost.toFixed(4)} (at $${pin}/$${pout} per 1M)`);
  }
  return { translated: out, errors: ctx.errors, usage: u, usd, models };
}

const sharedTranslations = new Map();   // content hash -> Promise<{ translated, errors }>
function getSharedTranslation(sourceTexts, config) {
  const h = crypto.createHash('sha1');
  h.update(`${config.lang}|${config.langName}|${config.provider}|${config.model}\n`);
  for (const t of sourceTexts) h.update(`${t}\n`);
  const key = h.digest('hex');

  let p = sharedTranslations.get(key);
  if (p) {
    console.log('[AISUBS] Same subtitle text already translated or in progress - reusing it.');
    return p.then(r => ({ ...r, reused: true }));
  }
  p = translateAllTexts(sourceTexts, config);
  sharedTranslations.set(key, p);
  if (sharedTranslations.size > 30) sharedTranslations.delete(sharedTranslations.keys().next().value);
  // Don't keep a failed run around, so a later try can start fresh.
  p.then(r => { if (r.translated.filter(x => x == null).length > sourceTexts.length * 0.2) sharedTranslations.delete(key); })
   .catch(() => sharedTranslations.delete(key));
  return p;
}

const translationTimes = [];   // seconds per finished translation (last 50), for the running average in the log

async function generateVtt({ config, candidates, type, id, raw, refUrl, noBanner = false, filename = '' }) {
  const t0 = Date.now();
  const ctx = { errors: [] };
  let missed = 0;
  const cues = await fetchCuesFromCandidates(candidates, type, id, config, filename);
  console.log(`[AISUBS] Parsed ${cues.length} cues.`);

  if (refUrl && candidates[0] && refUrl !== candidates[0]) {
    const st = await alignToReference({ cues, refUrl, candUrl: candidates[0], config, type, id, filename });
    console.log(`[AISUBS] Sync check: ${st.state}${st.state === 'corrected' ? ` (shift ${st.lagSec}s, speed x${st.ratio})` : ''}`);
  }
  const sourceTexts = cues.map(c => c.text);   // untouched originals, used as read-only context for translation

  if (config.offsetMs) {
    cues.forEach(c => {
      c.start = shiftTimestamp(c.start, config.offsetMs);
      c.end = shiftTimestamp(c.end, config.offsetMs);
    });
  }

  let wasReused = false;
  let sharedInfo = null;
  if (raw !== 'true') {
    const { translated, errors, reused, usage, usd, models } = await getSharedTranslation(sourceTexts, config);
    wasReused = !!reused;
    if (!reused) recordUsage(usage, usd);        // money is spent even when a run fails
    sharedInfo = { usd: reused ? 0 : (usd || 0), models: reused ? [] : (models || []) };
    ctx.errors.push(...errors);
    cues.forEach((c, i) => {
      const trans = translated[i];
      if (trans == null) { missed++; return; }      // keep the original line, but remember it failed
      const shown = wrapSubtitleLine(trans);
      c.text = config.bilingual ? `${c.text}\n<c.cyan>${shown}</c>` : shown;
    });
  }

  const targetName = config.langName || 'Dutch';
  const providerName = config.provider === 'gemini' ? 'Gemini AI' : String(config.provider).toUpperCase();

  // Status message, plain text. No [square brackets] (some players hide bracketed text as "sound descriptions"),
  // no colour tags and no emoji besides the check/cross marks.
  const pct = cues.length ? Math.round(100 * (cues.length - missed) / cues.length) : 100;
  const plain = (t) => String(t).replace(/[<>&]/g, ' ');

  if (raw !== 'true' && missed > cues.length * 0.2) {
    const reason = plain((ctx.errors[0] || 'unknown error').slice(0, 140));
    console.error(`[AISUBS] Translation failed for ${missed}/${cues.length} cues. First error: ${reason}`);
    recordError(`Translation failed for ${id}: ${reason}`);
    if (!wasReused) recordTranslation({ id, type, cues: cues.length, missed, secs: (Date.now() - t0) / 1000, usd: sharedInfo?.usd || 0, model: sharedInfo?.models?.length ? sharedInfo.models.join(' + ') : config.model, ok: false });
    return { vtt: buildWebVTT(cues, `Translation failed ✗ (${pct}% translated) - ${reason}`), cacheable: false, missed, cues: cues.length };   // don't cache a failure
  }

  if (raw !== 'true' && !wasReused) {
    const secs = (Date.now() - t0) / 1000;
    translationTimes.push(secs);
    if (translationTimes.length > 50) translationTimes.shift();
    const avg = translationTimes.reduce((a, b) => a + b, 0) / translationTimes.length;
    recordTranslation({ id, type, cues: cues.length, missed, secs, usd: sharedInfo?.usd || 0, model: sharedInfo?.models?.length ? sharedInfo.models.join(' + ') : config.model, ok: true });
    console.log(`[AISUBS] Translation took ${secs.toFixed(1)}s (${cues.length} cues, ${missed} missed) | average ${avg.toFixed(1)}s over ${translationTimes.length} run(s)`);
  }

  const banner = (raw === 'true' || noBanner) ? '' : (missed === 0 ? 'Translation Started ✅' : `Translation Started ✅ (${pct}% translated)`);
  return { vtt: buildWebVTT(cues, banner), cacheable: true, missed, cues: cues.length };
}

// One key function, so the menu can tell which translations are already saved (the ⚡ marker).
function vttCacheKey(config, candidates, id, raw) {
  return `${candidates[0] || id}_${config.lang}_${config.provider}_${config.model}_${config.offsetMs}_${config.bilingual}_${raw === 'true' ? 'raw' : 'ai'}`;
}

// ---- Burst guard ---------------------------------------------------------------------------------------------
// Some players ask for EVERY track the addon lists, right after a title opens (nobody can pick 4 tracks in a second).
// Translating each one would be paid for several times. So: the first AI track of a title is translated normally;
// other AI tracks of the SAME title asked for within BURST_WINDOW_SEC (or while the first is still running) get the
// first track's translation instead. Later, deliberate picks translate their own source as usual.
// Set BURST_WINDOW_SEC=0 in Render to turn this off.
const BURST_WINDOW_MS = (process.env.BURST_WINDOW_SEC !== undefined && process.env.BURST_WINDOW_SEC !== '' ? Number(process.env.BURST_WINDOW_SEC) : 25) * 1000;
const titleBursts = new Map();   // title key -> { cacheKey, startedAt, running, promise }

function noteBurst(titleKey, cacheKey, promise, running) {
  const now = Date.now();
  const cur = titleBursts.get(titleKey);
  if (cur && (cur.running || now - cur.startedAt <= BURST_WINDOW_MS)) return null;   // a first track is already active
  const rec = { cacheKey, startedAt: now, running, promise };
  titleBursts.set(titleKey, rec);
  if (titleBursts.size > 200) titleBursts.delete(titleBursts.keys().next().value);
  return rec;
}

app.get('/sub.vtt', async (req, res) => {
  const { cfg, src, alt, ref, type, id, raw, fn } = req.query;
  const config = parseConfig(cfg);
  stats.lastModel = resolveGeminiModel(config.model);
  const candidates = [decodeSourceParam(src), decodeSourceParam(alt)].filter(Boolean);
  const refUrl = decodeSourceParam(ref) || null;

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const isAi = raw !== 'true';
  const isUpload = String(candidates[0] || '').startsWith('upload://');   // uploads are memory-only
  const titleKey = `${type}|${id}|${config.lang}|${config.provider}|${config.model}|${config.bilingual}|${config.offsetMs}`;
  console.log(`[AISUBS] Track request (${isAi ? 'AI' : 'native'}) from ${String(req.get('user-agent') || '?').slice(0, 70)}`);

  const cacheKey = vttCacheKey(config, candidates, id, raw);
  if (subCache.has(cacheKey)) {
    const cached = subCache.get(cacheKey);
    if (isAi && BURST_WINDOW_MS > 0) noteBurst(titleKey, cacheKey, Promise.resolve({ vtt: cached }), false);
    return res.send(cached);
  }
  const recentFail = failCache.get(cacheKey);
  if (recentFail && recentFail.until > Date.now()) return res.send(recentFail.vtt);

  if (UPSTASH_ON && !isUpload) {              // saved before a restart? load it instead of paying again
    const saved = await upstashGetVtt(cacheKey);
    if (saved) {
      console.log('[AISUBS] Served a saved subtitle from Upstash (no download, no translation).');
      setInCache(cacheKey, saved);
      if (isAi && BURST_WINDOW_MS > 0) noteBurst(titleKey, cacheKey, Promise.resolve({ vtt: saved }), false);
      return res.send(saved);
    }
  }

  if (isAi && BURST_WINDOW_MS > 0) {
    const b = titleBursts.get(titleKey);
    if (b && b.cacheKey !== cacheKey && !String(candidates[0] || '').startsWith('upload://') && (b.running || Date.now() - b.startedAt <= BURST_WINDOW_MS)) {
      console.log('[AISUBS] Another track of the same title was requested right after the first - serving the first translation instead of paying for a second.');
      stats.totals.aliased++;
      try { const { vtt } = await b.promise; return res.send(vtt); } catch (e) { /* first one failed: translate this one itself */ }
    }
  }

  try {
    let job = inflight.get(cacheKey);
    if (!job) {
      job = generateVtt({ config, candidates, type, id, raw, refUrl, filename: fn || '' });
      inflight.set(cacheKey, job);
      const rec = (isAi && BURST_WINDOW_MS > 0) ? noteBurst(titleKey, cacheKey, job, true) : null;
      job.finally(() => { inflight.delete(cacheKey); if (rec) rec.running = false; }).catch(() => {});
    }
    const { vtt, cacheable } = await job;
    if (cacheable) { setInCache(cacheKey, vtt); if (!isUpload) upstashSaveVtt(cacheKey, vtt); }
    else failCache.set(cacheKey, { vtt, until: Date.now() + 120000 });   // retry allowed after 2 min
    res.send(vtt);
  } catch (err) {
    console.error('[AISUBS] Stream error:', err.message);
    res.send(`WEBVTT\n\n1\n00:00:01.000 --> 00:00:06.000\n[AISubs: Error loading/translating: ${err.message}]\n`);
  }
});

// Translation Routing
// Every function returns an array aligned with `texts`; an entry is null when that line could NOT be
// translated. Callers must never silently substitute the original text (that is what hid the failures).
async function translateBatch(texts, targetLang, config, ctx = { errors: [] }, context = []) {
  const apiKey = (config.apiKey || ENV_GEMINI_KEY || '').trim();
  const provider = config.provider || 'gemini';

  if (provider === 'gemini' && apiKey) {
    return translateWithGemini(texts, targetLang, apiKey, resolveGeminiModel(config.model), ctx, context);
  }
  if (['openrouter', 'openai', 'groq', 'deepseek'].includes(provider) && apiKey) {
    return translateWithOpenAICompatible(texts, targetLang, provider, apiKey, config.model, ctx, context);
  }

  ctx.errors.push(apiKey ? `unknown provider "${provider}"` : 'no AI API key configured');
  return translateWithFreeFallback(texts, targetLang, ctx);
}

function buildPrompt(texts, targetLang, context = []) {
  const ctxBlock = context.length
    ? `Context: the lines just before this batch (for reference only; do NOT translate or repeat them):\n${context.map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}\n\n`
    : '';
  return `You are a film and television subtitle translator.
Translate the following numbered dialogue lines into ${targetLang}.
Preserve line numbers and the '|' delimiter. Example format: '1| Translated line'.
Rules: keep character names, place names and brand names exactly as written; give one output line per numbered line, but let sentences that continue across lines read naturally; keep sound descriptions in [brackets] and ♪ symbols; keep every line short enough to read on screen.
Maintain the exact natural dialogue, timing brevity, and tone.
Return ONLY the numbered list of translations, with NO intro, markdown fences, or outro.

${ctxBlock}Lines to translate:
${texts.map((t, idx) => `${idx + 1}| ${t.replace(/\n/g, ' ')}`).join('\n')}`;
}

// ~15 Gemini requests/minute across the whole server (free-tier friendly). Override with GEMINI_MIN_INTERVAL_MS.
const GEMINI_MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS) || 4000;
let geminiNextSlot = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function paceGemini() {
  const now = Date.now();
  const start = Math.max(now, geminiNextSlot);
  geminiNextSlot = start + GEMINI_MIN_INTERVAL_MS;
  if (start > now) await sleep(start - now);
}
function retryDelayMs(res, body, attempt) {
  const h = Number(res.headers?.get?.('retry-after'));
  if (h > 0) return Math.min(h * 1000, 60000);
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body) || /retry in ([\d.]+)s/i.exec(body);
  if (m) return Math.min(Number(m[1]) * 1000 + 500, 60000);
  return Math.min(5000 * 2 ** attempt, 40000);
}

// Rate limits (429) and overloads (5xx) are retried on the SAME model with a wait. Falling through to other
// models only happens when a model is unusable (404/400/403), never to dodge a rate limit.
async function translateWithGemini(texts, targetLang, apiKey, model, ctx, context = []) {
  const modelsToTry = [...new Set([model, ...GEMINI_FALLBACK_MODELS])];
  const prompt = buildPrompt(texts, targetLang, context);

  for (const m of modelsToTry) {
    let again = true;
    for (let attempt = 0; attempt < 4 && again; attempt++) {
      again = false;
      try {
        await paceGemini();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.15 } }),
          signal: AbortSignal.timeout(45000)
        });

        if (!res.ok) {
          const body = (await res.text()).replace(/\s+/g, ' ');
          const msg = `Gemini ${m} HTTP ${res.status}: ${body.slice(0, 160)}`;
          console.warn(`[AISUBS] ${msg}`);
          ctx.errors.push(msg);
          if (res.status === 429 || res.status >= 500) {
            if (/per ?day/i.test(body) || attempt === 3) return texts.map(() => null);   // daily quota / still limited
            await sleep(retryDelayMs(res, body, attempt));
            again = true;                                                                  // retry same model
          }
          continue;                                                                        // else: next model
        }

        const data = await res.json();
        const um = data.usageMetadata;
        if (um && ctx.usage) {
          ctx.usage.in += um.promptTokenCount || 0;
          ctx.usage.out += um.candidatesTokenCount || 0;
          ctx.usage.think += um.thoughtsTokenCount || 0;
          if (ctx.usageByModel) {   // billed by the model that actually answered (the fallback chain may switch models)
            const mu = (ctx.usageByModel[m] = ctx.usageByModel[m] || { in: 0, out: 0, think: 0 });
            mu.in += um.promptTokenCount || 0;
            mu.out += um.candidatesTokenCount || 0;
            mu.think += um.thoughtsTokenCount || 0;
          }
        }
        const parts = data.candidates?.[0]?.content?.parts || [];
        const reply = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
        if (!reply.trim()) {
          ctx.errors.push(`Gemini ${m}: ${data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty reply'}`);
          continue;
        }
        return parseNumberedReply(reply, texts);
      } catch (e) {
        console.warn(`[AISUBS] Gemini ${m} error:`, e.message);
        ctx.errors.push(`Gemini ${m}: ${e.message}`);
        again = attempt < 1;                                                               // one retry on network/timeout
      }
    }
  }
  return translateWithFreeFallback(texts, targetLang, ctx);
}

async function translateWithOpenAICompatible(texts, targetLang, provider, apiKey, model, ctx, context = []) {
  let endpoint = 'https://api.openai.com/v1/chat/completions';
  let defaultModel = 'gpt-4o-mini';

  if (provider === 'openrouter') {
    endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    defaultModel = 'google/gemini-3.6-flash';   // NOTE: verify this id on openrouter.ai/models
  } else if (provider === 'groq') {
    endpoint = 'https://api.groq.com/openai/v1/chat/completions';
    defaultModel = 'llama-3.3-70b-versatile';
  } else if (provider === 'deepseek') {
    endpoint = 'https://api.deepseek.com/chat/completions';
    defaultModel = 'deepseek-chat';
  }

  // The UI/old profiles may still send a retired Gemini id as the model; don't forward it to other providers.
  const chosenModel = model && model !== 'default' && !RETIRED_GEMINI.test(model) ? model : defaultModel;
  const prompt = buildPrompt(texts, targetLang, context);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chosenModel,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(25000)
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
      const msg = `${provider} ${chosenModel} HTTP ${res.status}: ${body}`;
      console.warn(`[AISUBS] ${msg}`);
      ctx.errors.push(msg);
      return translateWithFreeFallback(texts, targetLang, ctx);
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || '';
    if (!reply.trim()) {
      ctx.errors.push(`${provider}: empty reply`);
      return translateWithFreeFallback(texts, targetLang, ctx);
    }
    return parseNumberedReply(reply, texts);
  } catch (e) {
    console.error(`[AISUBS] ${provider} error:`, e.message);
    ctx.errors.push(`${provider}: ${e.message}`);
    return translateWithFreeFallback(texts, targetLang, ctx);
  }
}

async function translateWithFreeFallback(texts, targetLang, ctx = { errors: [] }) {
  const iso1 = targetLang.toLowerCase() === 'dutch' ? 'nl' : targetLang.slice(0, 2).toLowerCase();
  return mapPool(texts, 8, async (text) => {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${iso1}&dt=t&q=${encodeURIComponent(text)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      return json[0]?.map(p => p[0]).join('') || null;
    } catch (e) {
      if (ctx.errors.length < 6 && !ctx.errors.some(x => x.startsWith('free fallback'))) {
        ctx.errors.push(`free fallback: ${e.message}`);
      }
      return null;
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
  return original.map((_, idx) => map.get(idx + 1) ?? null);
}

function buildWebVTT(cues, bannerText) {
  let vtt = 'WEBVTT\n\n';
  let cueIndex = 1;

  if (bannerText) {
    vtt += `${cueIndex}\n00:00:00.500 --> 00:00:06.000\n${bannerText}\n\n`;
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
