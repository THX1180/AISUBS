export function getManifest(config = {}) {
  const langName = config.langName || 'AI Subtitles';
  return {
    id: 'org.aisubs.translator',
    version: '1.3.0',
    name: `AISUBS (${langName})`,
    description: 'AI subtitle translation & auto-sync powered by OpenSubtitles, SubDL, SubSource & LLMs.',
    resources: [
      {
        name: 'subtitles',
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'kitsu']
      }
    ],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}
