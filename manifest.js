export function getManifest(config = {}) {
  const lang = config.langName || 'AI Subtitles';
  return {
    id: 'org.aisubs.translator',
    version: '1.2.0',
    name: `AISUBS (${lang})`,
    description: 'High-speed AI subtitle translation & auto-sync for Stremio & Nuvio.',
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
