import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCore } from '../lib/core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.join(root, 'vendor/core/examples/web-app.architecture.json');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'apitu-output-race-'));
const wrapper = path.join(scratch, 'claim-after-preflight.mjs');
await writeFile(wrapper, `#!/usr/local/bin/node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.writeFileSync(process.env.RACE_TARGET, 'CONCURRENT_USER_FILE', { flag: 'wx' });
const result = spawnSync(process.execPath, process.argv.slice(2), { env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
await chmod(wrapper, 0o755);

for (const command of ['render', 'deliver', 'finalize', 'demo']) {
  test(`${command} preserves a claimant created after Host preflight`, async () => {
    const output = path.join(scratch, `${command}.html`);
    const args = command === 'demo' ? [command, output] : [command, 'architecture', input, output, ...(command === 'render' ? [] : ['--json'])];
    const result = await runCore({ args, cwd: scratch, node: wrapper, env: { RACE_TARGET: output, APITU_NO_CLOBBER: '0' } });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.stdout + result.stderr, command === 'demo' ? /EEXIST/ : command === 'render' ? /output\/target-changed/ : /output-no-clobber/);
    assert.equal(await readFile(output, 'utf8'), 'CONCURRENT_USER_FILE');
    assert.deepEqual(result.artifacts, []);
    assert.ok((await lstat(output)).isFile());
  });
}

test('compare preserves a claimant created after Host preflight', async () => {
  const output = path.join(scratch, 'compare.html');
  const result = await runCore({ args: ['compare', 'architecture', path.join(root, 'vendor/core/examples/checkout-platform.base.architecture.json'), path.join(root, 'vendor/core/examples/checkout-platform.head.architecture.json'), output, '--json'], cwd: scratch, node: wrapper, env: { RACE_TARGET: output } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.stdout + result.stderr, /output-no-clobber/);
  assert.equal(await readFile(output, 'utf8'), 'CONCURRENT_USER_FILE');
});

test('migrate preserves a claimant created after Host preflight', async () => {
  const output = path.join(scratch, 'migrated.json');
  const result = await runCore({ args: ['migrate', 'workflow', path.join(root, 'vendor/core/examples/agent-tool-call.workflow.json'), output, '--to-schema', '2', '--json'], cwd: scratch, node: wrapper, env: { RACE_TARGET: output } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.stdout + result.stderr, /output-no-clobber/);
  assert.equal(await readFile(output, 'utf8'), 'CONCURRENT_USER_FILE');
});

test('delivery provenance claimant survives after Host preflight', async () => {
  const output = path.join(scratch, 'sidecar.html');
  const sidecar = path.join(scratch, 'sidecar.delivery.json');
  const result = await runCore({ args: ['deliver', 'architecture', input, output, '--json'], cwd: scratch, node: wrapper, env: { RACE_TARGET: sidecar } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.stdout + result.stderr, /output-no-clobber/);
  assert.equal(await readFile(sidecar, 'utf8'), 'CONCURRENT_USER_FILE');
  assert.deepEqual(result.artifacts, []);
});

test('Host finalize permits owned journal and receipt updates without overriding no-clobber', async () => {
  const output = path.join(scratch, 'finalize-owned.html');
  const receipt = path.join(scratch, 'finalize-owned.receipt.json');
  const result = await runCore({ args: ['finalize', 'architecture', input, output, '--receipt', receipt, '--json'], cwd: scratch, node: '/usr/local/bin/node' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.gates['browser-check'], 'pass');
  const fullReceipt = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(fullReceipt.ok, true);
  assert.deepEqual(fullReceipt.artifact, result.data.artifact);
  assert.equal(fullReceipt.stages['browser-check'].exitCode, 0);
  assert.equal(fullReceipt.stages['browser-check'].receipt.status, 'pass');
  assert.deepEqual(result.artifacts, [output]);
});

test('finalize receipt claimant survives after Host preflight', async () => {
  const output = path.join(scratch, 'receipt.html');
  const receipt = path.join(scratch, 'receipt.json');
  const result = await runCore({ args: ['finalize', 'architecture', input, output, '--receipt', receipt, '--json'], cwd: scratch, node: wrapper, env: { RACE_TARGET: receipt } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.stdout + result.stderr, /output-no-clobber/);
  assert.equal(await readFile(receipt, 'utf8'), 'CONCURRENT_USER_FILE');
});
