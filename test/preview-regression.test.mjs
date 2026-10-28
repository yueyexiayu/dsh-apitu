import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCore, previewStatus, stopPreview, stopAllPreviews, PREVIEW_LIMITS } from '../lib/core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'apitu-preview-regression-'));
const source = path.join(root, 'vendor/core/examples/web-app.architecture.json');
const node = '/usr/local/bin/node';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(id, predicate, budget = 90000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const state = await previewStatus(id);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error('Preview did not reach expected state before deadline.');
}

test('real preview separates broken builds, retains last verified artifact and updates owned output', { timeout: 180000 }, async () => {
  const input = path.join(scratch, 'live.json');
  const output = path.join(scratch, 'live.html');
  await writeFile(input, '{ broken JSON');
  const started = await runCore({ args: ['preview', 'architecture', input, output], cwd: scratch, node });
  const id = started.preview.id;
  try {
    const broken = await until(id, state => state.buildStatus === 'needs-fix');
    assert.equal(broken.processStatus, 'running');
    assert.ok(broken.failure);
    assert.ok(broken.error);
    assert.deepEqual(broken.artifacts, []);
    const document = JSON.parse(await readFile(source, 'utf8'));
    await writeFile(input, JSON.stringify(document));
    const first = await until(id, state => state.buildStatus === 'verified');
    assert.deepEqual(first.artifacts, [output]);
    assert.ok(first.lastVerified.sha256);
    document.meta.title = 'Preview owned generation two';
    await writeFile(input, JSON.stringify(document));
    const second = await until(id, state => state.buildStatus === 'verified' && state.lastVerified.sha256 !== first.lastVerified.sha256);
    assert.deepEqual(second.artifacts, [output]);
    await writeFile(input, '{ broken again');
    const failed = await until(id, state => state.buildStatus === 'needs-fix');
    assert.deepEqual(failed.artifacts, [output]);
    assert.equal(failed.lastVerified.sha256, second.lastVerified.sha256);
    const stopped = await stopPreview(id);
    assert.equal(stopped.preview.processStatus, 'stopped');
    assert.deepEqual(stopped.preview.artifacts, [output]);
  } finally { await stopAllPreviews(); }
});

const fake = path.join(scratch, 'fake-preview.mjs');
await writeFile(fake, `#!/usr/local/bin/node
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ schemaVersion: 1, status: process.env.BAD_STATE ? 'nonsense' : 'checking', generation: 0, failure: null, lastVerified: null }));
});
server.listen(0, '127.0.0.1', () => console.log('preview http://127.0.0.1:' + server.address().port + '/'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
await chmod(fake, 0o755);
let serial = 0;
const fakeRun = env => runCore({ args: ['preview', 'architecture', source, path.join(scratch, `fake-${serial++}.html`)], cwd: scratch, node: fake, env });

test('state protocol failure is visible, not a verified preview', async () => {
  const result = await fakeRun({ BAD_STATE: '1' });
  try {
    assert.equal(result.ok, false);
    assert.equal(result.preview.buildStatus, 'unavailable');
    assert.match(result.preview.error, /invalid build state/);
    assert.deepEqual(result.artifacts, []);
  } finally { await stopAllPreviews(); }
});

test('preview lifecycle bounds active capacity and retains only bounded ended records', { timeout: 60000 }, async () => {
  const results = [];
  try {
    for (let i = 0; i < PREVIEW_LIMITS.active; i++) results.push(await fakeRun());
    await assert.rejects(fakeRun(), /capacity reached/);
    await Promise.all(results.map(result => stopPreview(result.preview.id)));
    const oldest = results[0].preview.id;
    const longLived = await fakeRun();
    for (let i = 0; i < PREVIEW_LIMITS.retained; i++) {
      const result = await fakeRun();
      await stopPreview(result.preview.id);
    }
    await assert.rejects(previewStatus(oldest), /expired/);
    const stopped = await stopPreview(longLived.preview.id);
    assert.equal(stopped.preview.status, 'stopped');
    const now = Date.now;
    try {
      Date.now = () => now() + PREVIEW_LIMITS.retentionMs + 1;
      await assert.rejects(previewStatus(longLived.preview.id), /expired/);
    } finally { Date.now = now; }
  } finally { await stopAllPreviews(); }
});
