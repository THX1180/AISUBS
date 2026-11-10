export function getManifest(config = {}) {
  const langName = config.langName || 'Dutch';
  return {
    id: 'org.aisubs.translator',
    version: '2.5.0',
    name: `AISUBS (${langName})`,
    description: 'Auto-synced subtitles matched to your exact video release & translated with Gemini AI.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}
