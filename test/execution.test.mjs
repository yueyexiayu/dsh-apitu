import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './headless-fixture.mjs';
import { ChromeVisualBrowser, findChrome, runBrowserCheck, visualBrowserExecution } from '../vendor/core/bin/visual-check.mjs';
import { runCore } from '../lib/core.js';

const scope = { sessionId: 'actual-host-session', taskId: 'actual-host-job' };

test('visual execution carries Host scope, owned true headless purpose, and no unsupported capabilities', () => {
  const execution = visualBrowserExecution({ env: { APITU_BROWSER_EXECUTION_SCOPE: JSON.stringify(scope) } });
  assert.deepEqual(execution.scope, scope); assert.equal(execution.purpose, 'web-regression'); assert.equal(execution.mode, 'headless'); assert.equal(execution.ownership, 'owned-process');
  for (const capability of ['authenticated-state', 'isolated-context', 'isolated-download-directory']) {
    assert.throws(() => visualBrowserExecution({ execution: { ...execution, capabilities: [capability] } }), { code: 'UNSUPPORTED_BROWSER_CAPABILITY' });
  }
  assert.throws(() => visualBrowserExecution({ env: { APITU_BROWSER_EXECUTION_SCOPE: '{}' } }), /scope/);
});

test('direct constructor validates explicit GUI/script paths and final incompatible mode before spawn', async t => {
  const f = await fixture(t, findChrome); await f.shell();
  const gui = path.join(f.home, 'Chrome.app/Contents/MacOS/chrome-headless-shell');
  await mkdir(path.dirname(gui), { recursive: true }); await writeFile(gui, 'GUI sentinel'); await chmod(gui, 0o755);
  const script = path.join(f.home, 'chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell');
  await mkdir(path.dirname(script), { recursive: true }); await writeFile(script, '#!/bin/sh\necho forged'); await chmod(script, 0o755);
  t.mock.method(os, 'tmpdir', () => f.home);
  const before = (await readdir(f.home)).sort();
  let spawns = 0;
  t.mock.method(childProcess, 'spawn', () => { spawns++; throw new Error('test forbids browser launch'); });
  syncBuiltinESMExports();
  for (const executable of [gui, script, '', path.join(f.home, 'missing')]) {
    assert.throws(() => new ChromeVisualBrowser(executable, { cwd: f.home, env: {}, scope }), /GUI|installation|Mach-O|binary|executable|APITU_CHROME/i);
  }
  const executable = await f.shell();
  assert.throws(() => new ChromeVisualBrowser(executable, { cwd: f.home, env: {}, execution: { scope, purpose: 'capture', mode: 'headed', ownership: 'owned-process', capabilities: ['dom', 'screenshot'] } }), { code: 'BROWSER_MODE_MISMATCH' });
  assert.throws(() => new ChromeVisualBrowser(executable, { cwd: f.home, env: {}, execution: { scope, purpose: 'web-regression', mode: 'headless', ownership: 'borrowed-connection', capabilities: ['dom', 'screenshot'] } }), { code: 'BROWSER_OWNERSHIP_MISMATCH' });
  assert.equal(spawns, 0);
  assert.deepEqual((await readdir(f.home)).sort(), before, 'invalid launch cannot allocate a browser profile');
});

test('browser evidence explicit GUI path cannot bypass the real pinned resolver', async t => {
  const f = await fixture(t, findChrome);
  const artifactPath = path.join(f.home, 'artifact.html'); await writeFile(artifactPath, '<!doctype html><main>explicit-path fixture</main>');
  let spawns = 0;
  t.mock.method(childProcess, 'spawn', () => { spawns++; throw new Error('test forbids browser launch'); }); syncBuiltinESMExports();
  const result = await runBrowserCheck({ artifactPath, cwd: f.home, env: {}, chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', execution: { scope, purpose: 'web-regression', mode: 'headless', ownership: 'owned-process', capabilities: ['dom', 'screenshot'] } });
  assert.equal(result.exitCode, 1); assert.equal(result.receipt.ok, false); assert.equal(result.receipt.browserUnavailable, true);
  assert.deepEqual(result.receipt.executionRequest.scope, scope);
  assert.equal(spawns, 0); assert.equal(f.versionCalls.length, 0);
});

test('Host runner overrides injected execution scope env with its actual Session/job', async t => {
  const f = await fixture(t, findChrome);
  const node = path.join(f.home, 'fake-node');
  await writeFile(node, '#!/usr/local/bin/node\nprocess.stdout.write(process.env.APITU_BROWSER_EXECUTION_SCOPE);\n'); await chmod(node, 0o755);
  const result = await runCore({ args: ['help'], cwd: f.home, node, scope, env: { APITU_BROWSER_EXECUTION_SCOPE: JSON.stringify({ sessionId: 'forged', taskId: 'forged' }) } });
  assert.equal(result.ok, true, result.stderr); assert.deepEqual(JSON.parse(result.stdout), scope);
});
