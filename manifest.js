export function getManifest(config = {}, baseUrl = '') {
  const lang = (config.lang || 'nld').toLowerCase();
  const langName = config.langName || 'Dutch';
  return {
    // Stremio identifies addons by id. One id per target language so a Dutch and a
    // Spanish install don't overwrite each other.
    id: `org.aisubs.translator.${lang}`,
    version: '2.6.0',
    name: `AISUBS (${langName})`,
    description: 'Auto-synced subtitles matched to your exact video release & translated with Gemini AI.',
    logo: baseUrl ? `${baseUrl}/logo.png` : undefined,       // square PNG, shown in Stremio/Nuvio
    background: baseUrl ? `${baseUrl}/logo.png` : undefined,
    resources: ['subtitles'],
    types: ['movie', 'series'],
    // Only IMDb ids ("tt1234567" / "tt1234567:1:2") are supported by the providers used in server.js.
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}
