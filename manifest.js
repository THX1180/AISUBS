export function getManifest(config = {}) {
  const langName = config.langName || 'Dutch';
  return {
    id: 'org.aisubs.translator',
    version: '2.0.0',
    name: `AISUBS (${langName})`,
    description: 'Auto-synced and AI-translated subtitles for Stremio & Nuvio, timed to your exact video file.',
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
