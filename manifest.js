export function getManifest(config = {}) {
  const langName = config.langName || 'AI Subtitles';
  return {
    id: 'org.aisubs.translator',
    version: '1.4.0',
    name: `AISUBS (${langName})`,
    description: 'Context-aware AI subtitle translation and auto-sync for Stremio and Nuvio.',
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
