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
