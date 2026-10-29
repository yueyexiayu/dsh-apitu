import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './headless-fixture.mjs';
import { ChromeVisualBrowser, chromeVisualBrowserArgs, findChrome, runBrowserCheck, runVisualCheck } from '../vendor/core/bin/visual-check.mjs';
import { runFinalize } from '../vendor/core/bin/finalize.mjs';

for (const key of ['spawnImpl', 'getuid']) test(`constructor rejects obsolete ${key} before resolver/profile/spawn`, async t => {
  const f = await fixture(t, findChrome); const executable = await f.shell();
  t.mock.method(os, 'tmpdir', () => f.home);
  let builtinCalls = 0, injectedCalls = 0;
  t.mock.method(childProcess, 'spawn', () => { builtinCalls++; throw new Error('BUILTIN_SPAWN_TRIPWIRE_NO_BROWSER'); }); syncBuiltinESMExports();
  const before = (await readdir(f.home)).sort();
  const injected = () => { injectedCalls++; if (key === 'getuid') return 0; throw new Error('PUBLIC_SPAWN_HOOK_REACHED_NO_BROWSER'); };
  assert.throws(() => new ChromeVisualBrowser(executable, { env: {}, cwd: f.home, [key]: injected }), { code: 'UNSUPPORTED_BROWSER_ADAPTER_OPTION' });
  assert.equal(injectedCalls, 0); assert.equal(builtinCalls, 0); assert.equal(f.versionCalls.length, 0);
  assert.deepEqual((await readdir(f.home)).sort(), before);
});

for (const run of [runBrowserCheck, runVisualCheck]) for (const key of ['browserFactory', 'resolveChrome']) test(`${run.name} rejects public ${key} before writing evidence`, async t => {
  const f = await fixture(t, findChrome); const executable = await f.shell();
  const artifactPath = path.join(f.home, 'artifact.html'); await writeFile(artifactPath, '<!doctype html><main>public acquisition regression</main>');
  t.mock.method(os, 'tmpdir', () => f.home);
  let builtinCalls = 0, injectedCalls = 0;
  t.mock.method(childProcess, 'spawn', () => { builtinCalls++; throw new Error('BUILTIN_SPAWN_TRIPWIRE_NO_BROWSER'); }); syncBuiltinESMExports();
  const before = (await readdir(f.home)).sort();
  const injected = () => { injectedCalls++; return key === 'resolveChrome' ? executable : { close: async () => {} }; };
  await assert.rejects(run({ artifactPath, chromePath: key === 'resolveChrome' ? undefined : executable, env: {}, cwd: f.home, [key]: injected }), { code: 'UNSUPPORTED_BROWSER_ADAPTER_OPTION' });
  assert.equal(injectedCalls, 0); assert.equal(builtinCalls, 0); assert.equal(f.versionCalls.length, 0);
  assert.deepEqual((await readdir(f.home)).sort(), before, 'no receipt/profile/sidecar may be created for an obsolete acquisition hook');
});

for (const key of ['createBrowser', 'resolveChrome', 'runBrowserCheck']) test(`finalize rejects obsolete ${key} before any required-path or receipt work`, async () => {
  await assert.rejects(runFinalize({ [key]: () => { throw new Error('must never call public acquisition hook'); } }), { code: 'UNSUPPORTED_BROWSER_ADAPTER_OPTION' });
});

test('roadmap finalize forces roadmap-v1 without assigning a const quality', async () => {
  await assert.rejects(runFinalize({
    cliPath: '/tmp/apitu-cli.mjs',
    type: 'architecture',
    input: '/tmp/apitu-missing.json',
    output: '/tmp/apitu-missing.html',
    quality: 'roadmap-v1',
  }), /only valid for roadmap/);
  let failed;
  try {
    await runFinalize({
      cliPath: '/tmp/apitu-cli.mjs',
      type: 'roadmap',
      input: '/tmp/apitu-missing-candidate.json',
      output: path.join(os.tmpdir(), `apitu-roadmap-quality-${Date.now()}.html`),
    });
  } catch (error) {
    failed = error;
  }
  assert.notEqual(failed?.message, 'Assignment to constant variable.');
});

test('inherited/nonenumerable acquisition keys reject without reading getters; null-prototype DTOs remain legal', async () => {
  for (const key of ['spawnImpl', 'getuid', 'browserFactory', 'resolveChrome', 'createBrowser', 'runBrowserCheck']) {
    let calls = 0;
    const prototype = Object.defineProperty({}, key, { get() { calls++; throw new Error('obsolete hook getter must not run'); } });
    const inherited = Object.create(prototype);
    assert.throws(() => new ChromeVisualBrowser('/invalid-not-resolved', inherited), { code: 'UNSUPPORTED_BROWSER_ADAPTER_OPTION' });
    assert.throws(() => chromeVisualBrowserArgs('/invalid-not-created', inherited), { code: 'UNSUPPORTED_BROWSER_ADAPTER_OPTION' });
    for (const run of [runBrowserCheck, runVisualCheck, runFinalize]) await assert.rejects(run(inherited), { code: 'UNSUPPORTED_BROWSER_ADAPTER_OPTION' });
    const nonenumerable = Object.defineProperty({}, key, { get() { calls++; }, enumerable: false });
    await assert.rejects(runBrowserCheck(nonenumerable), { code: 'UNSUPPORTED_BROWSER_ADAPTER_OPTION' });
    assert.equal(calls, 0);
  }
  const dto = Object.assign(Object.create(null), { env: {} });
  assert.ok(chromeVisualBrowserArgs('/no-files-written', dto).includes('--headless=new'));
});

test('a forged managed browser prototype/metadata cannot enter the private instance evidence path', async () => {
  const forged = Object.create(ChromeVisualBrowser.prototype);
  forged.execution = { scope: { sessionId: 'forged', taskId: 'forged' }, purpose: 'web-regression', mode: 'headless', ownership: 'owned-process', capabilities: ['dom', 'screenshot'] };
  await assert.rejects(ChromeVisualBrowser.prototype.browserCheck.call(forged, { artifactPath: '/not-read.html' }), { code: 'BROWSER_ADAPTER_HANDLE_REQUIRED' });
});
