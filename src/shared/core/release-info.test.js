import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bumpPatchVersion,
  parseChangelogMarkdown,
  buildReleaseData,
  syncReleaseFiles
} from '../../../scripts/sync-release.mjs';
import { RELEASE_INFO } from './release-info.js';

describe('release-info & build sync script', () => {
  it('increments patch versions cleanly', () => {
    assert.equal(bumpPatchVersion('0.1.0'), '0.1.1');
    assert.equal(bumpPatchVersion('0.1.9'), '0.1.10');
    assert.equal(bumpPatchVersion('invalid'), '0.1.0');
  });

  it('parses log.md sections and bullets accurately', () => {
    const md = `# Changelog
## v0.1.2 — 2026-11-26
- Prima modifica
- Seconda modifica

## v0.1.1 - 2026-11-25
* Fix precedente
`;
    const parsed = parseChangelogMarkdown(md);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], {
      version: '0.1.2',
      date: '2026-11-26',
      items: ['Prima modifica', 'Seconda modifica']
    });
    assert.deepEqual(parsed[1], {
      version: '0.1.1',
      date: '2026-11-25',
      items: ['Fix precedente']
    });
  });

  it('matches exact version in log.md or falls back to latest entry if build bumped ahead', () => {
    const md = `## v0.1.1 — 2026-11-26
- Note release 0.1.1

## v0.1.0 — 2026-11-25
- Note iniziali
`;
    const exact = buildReleaseData({ version: '0.1.1', markdown: md, builtAt: '2026-11-26T10:00:00.000Z' });
    assert.equal(exact.version, '0.1.1');
    assert.equal(exact.hasExactChangelog, true);
    assert.deepEqual(exact.currentNotes, ['Note release 0.1.1']);

    const ahead = buildReleaseData({ version: '0.1.2', markdown: md, builtAt: '2026-11-26T11:00:00.000Z' });
    assert.equal(ahead.version, '0.1.2');
    assert.equal(ahead.hasExactChangelog, false);
    assert.equal(ahead.notesSourceVersion, '0.1.1');
    assert.deepEqual(ahead.currentNotes, ['Note release 0.1.1']);
  });

  it('bumps package.json and writes static release-info.js module in an isolated temp dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inknote-rel-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'src', 'shared', 'core'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', version: '0.1.0' }, null, 2));
      fs.writeFileSync(path.join(tmpDir, 'log.md'), '## v0.1.1 — 2026-11-26\n- Build incrementale attiva\n');

      const res = syncReleaseFiles({ rootDir: tmpDir, bump: true, builtAt: '2026-11-26T12:00:00.000Z' });
      assert.equal(res.version, '0.1.1');
      assert.equal(res.hasExactChangelog, true);
      assert.deepEqual(res.currentNotes, ['Build incrementale attiva']);

      const updatedPkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8'));
      assert.equal(updatedPkg.version, '0.1.1');

      const generated = fs.readFileSync(path.join(tmpDir, 'src', 'shared', 'core', 'release-info.js'), 'utf8');
      assert.ok(generated.includes('Build incrementale attiva'));
      assert.ok(generated.includes('"version": "0.1.1"'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exposes frozen static RELEASE_INFO object', () => {
    assert.equal(Object.isFrozen(RELEASE_INFO), true);
    assert.ok(typeof RELEASE_INFO.version === 'string' && RELEASE_INFO.version.length > 0);
    assert.ok(Array.isArray(RELEASE_INFO.releases));
  });
});
