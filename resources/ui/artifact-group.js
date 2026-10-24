// Claude Artifact pages (claude.ai/artifact/<id>, claude.ai/code/artifact/<uuid>) the person opened get their own
// sidebar section. Tabs an agent opened or acted on (agentMark) stay in Tabs. Test: scripts/test-artifact-group.sh.
const isArtifactUrl = (url) => /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/.test(url || '');
const artifactGrouped = (t, settings) => settings?.artifactGroup !== false && !t.pinned && !t.group && !t.agentMark && isArtifactUrl(t.url);
if (typeof module === 'object') module.exports = { isArtifactUrl, artifactGrouped };
