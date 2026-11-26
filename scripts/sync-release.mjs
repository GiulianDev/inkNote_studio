import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function bumpPatchVersion(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return '0.1.0';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]) + 1;
  return `${major}.${minor}.${patch}`;
}

export function normalizeVersionTag(raw) {
  return String(raw || '').trim().replace(/^v/i, '');
}

/**
 * Analizza `log.md` estraendo le sezioni `## vX.Y.Z — YYYY-MM-DD` (o `## X.Y.Z`)
 * e i relativi punti elenco.
 */
export function parseChangelogMarkdown(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];

  const lines = markdown.split(/\r?\n/);
  const releases = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const headingMatch = line.match(/^##\s+v?(\d+\.\d+\.\d+(?:[-+][^\s—–-]+)?)(?:\s*[—–-]\s*(.+))?$/i);
    if (headingMatch) {
      if (current) releases.push(current);
      current = {
        version: normalizeVersionTag(headingMatch[1]),
        date: (headingMatch[2] || '').trim(),
        items: []
      };
      continue;
    }

    if (!current) continue;
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      current.items.push(bulletMatch[1].trim());
    }
  }

  if (current) releases.push(current);
  return releases;
}

export function buildReleaseData({ version, markdown, builtAt = new Date().toISOString() }) {
  const normalizedVersion = normalizeVersionTag(version) || '0.1.0';
  const releases = parseChangelogMarkdown(markdown);
  const exactMatch = releases.find((entry) => entry.version === normalizedVersion) || null;
  const fallbackMatch = exactMatch || releases[0] || null;

  return {
    version: normalizedVersion,
    builtAt,
    date: fallbackMatch?.date || builtAt.slice(0, 10),
    currentNotes: fallbackMatch ? [...fallbackMatch.items] : [],
    notesSourceVersion: fallbackMatch?.version || normalizedVersion,
    hasExactChangelog: Boolean(exactMatch),
    releases
  };
}

export function renderReleaseInfoModule(releaseData) {
  const serialized = JSON.stringify(releaseData, null, 2);
  return `// File generato automaticamente da scripts/sync-release.mjs durante il build.
// NON modificare manualmente: viene rigenerato ad ogni \`npm run build\`.

export const RELEASE_INFO = Object.freeze(${serialized});
`;
}

export function syncReleaseFiles({
  rootDir = ROOT_DIR,
  bump = false,
  builtAt = new Date().toISOString()
} = {}) {
  const pkgPath = path.join(rootDir, 'package.json');
  const logPath = path.join(rootDir, 'log.md');
  const outPath = path.join(rootDir, 'src', 'shared', 'core', 'release-info.js');

  const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const prevVersion = pkg.version || '0.0.0';
  const nextVersion = bump ? bumpPatchVersion(prevVersion) : normalizeVersionTag(prevVersion);

  if (bump && nextVersion !== prevVersion) {
    pkg.version = nextVersion;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }

  const markdown = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const releaseData = buildReleaseData({
    version: nextVersion,
    markdown,
    builtAt
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderReleaseInfoModule(releaseData), 'utf8');

  return releaseData;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const bump = process.argv.includes('--bump');
  const info = syncReleaseFiles({ bump });
  console.log(`[sync-release] v${info.version} (${info.releases.length} release in log.md)`);
}
