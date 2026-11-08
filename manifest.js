module.exports = {
  id: "community.ai.autosync.subtitles",
  version: "1.0.0",
  name: "SubNova AI - NL AutoSync",
  description: "Vindt Nederlandse ondertitels via OpenSubtitles, SubDL & SubSource met releasematch. Automatische Gemini 3.5 AI-vertaling als fallback.",
  logo: "https://raw.githubusercontent.com/stremio/stremio-addon-sdk/master/resources/logo.png",
  resources: ["subtitles"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
};