import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, rm, symlink, open } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fixture as makeFixture } from './headless-fixture.mjs';
import os from 'node:os';
import path from 'node:path';
import { findChrome as resolveBrowser, runBrowserCheck } from '../vendor/core/bin/visual-check.mjs';

// Published Playwright 1.58.2 acceptance values, independent of resolver code.
const digest = 'a46b3b1e63163fa2d2437fb6ae967cb5a73b50050bca32f1964e6129b6228244';
const override = 'APITU_CHROME';
const fixture = t => makeFixture(t, resolveBrowser);
test('selects pinned 1208 even when another project has newer 9999', async t => {
  const f = await fixture(t); const pinned = await f.shell(); await f.shell(f.cache, '9999'); assert.equal(await f.resolve(), pinned);
});
test('does not borrow another revision or architecture when pinned install is absent', async t => {
  const f = await fixture(t); await f.shell(f.cache, '9999'); await f.shell(f.cache, '1208', 'x64'); await assert.rejects(f.resolve(), /1208|installation|headless/i);
});
test('Playwright PATH=0 uses its package-local .local-browsers', async t => {
  const f = await fixture(t); const expected = await f.shell(path.join(f.playwrightPackageRoot, '.local-browsers')); assert.equal(await f.resolve({ env: { PLAYWRIGHT_BROWSERS_PATH: '0' } }), expected);
});
test('absolute and relative caches resolve with execution cwd; empty means Playwright default', async t => {
  const f = await fixture(t); const defaultShell = await f.shell(); assert.equal(await f.resolve({ env: { PLAYWRIGHT_BROWSERS_PATH: '' } }), defaultShell);
  const custom = await f.shell(path.join(f.home, 'execution/cache'));
  for (const value of [path.join(f.home, 'execution/cache'), 'cache']) assert.equal(await f.resolve({ cwd: path.join(f.home, 'execution'), env: { PLAYWRIGHT_BROWSERS_PATH: value } }), custom);
});
test('cache env precedence follows fixed package; INIT_CWD cannot replace execution cwd', async t => {
  const f = await fixture(t); const defaultShell = await f.shell(); const custom = await f.shell(path.join(f.home, 'execution/cache'));
  assert.equal(await f.resolve({ cwd: path.join(f.home, 'execution'), env: { PLAYWRIGHT_BROWSERS_PATH: 'cache', INIT_CWD: path.join(f.home, 'wrong') } }), custom);
  for (const env of [{ npm_config_playwright_browsers_path: path.join(f.home, 'execution/cache') }, { npm_package_config_playwright_browsers_path: path.join(f.home, 'execution/cache') }, { PLAYWRIGHT_BROWSERS_PATH: '', npm_config_playwright_browsers_path: path.join(f.home, 'missing') }]) assert.equal(await f.resolve({ env }), env.PLAYWRIGHT_BROWSERS_PATH === '' ? defaultShell : custom);
  assert.equal(await f.resolve({ env: { npm_config_playwright_browsers_path: '', npm_package_config_playwright_browsers_path: path.join(f.home, 'missing') } }), defaultShell);
});

test('unset, empty, valid and invalid explicit overrides are distinct; never fallback', async t => {
  const f = await fixture(t); const shell = await f.shell(); assert.equal(await f.resolve(), shell); assert.equal(await f.resolve({ env: { [override]: shell } }), shell);
  for (const value of ['', ' ', path.join(f.home, 'missing')]) await assert.rejects(f.resolve({ env: { [override]: value } }), new RegExp(override));
});
test('rejects renamed executable, GUI path and GUI symlink before version execution', async t => {
  const f = await fixture(t); await f.shell(); const gui = path.join(f.home, 'Chrome.app/Contents/MacOS/chrome-headless-shell'); await mkdir(path.dirname(gui), { recursive: true }); await writeFile(gui, 'fake'); await chmod(gui, 0o755);
  const alias = path.join(f.home, 'chrome-headless-shell'); await symlink(gui, alias);
  for (const file of [gui, alias]) await assert.rejects(f.resolve({ env: { [override]: file } }), /GUI|installation|layout/i);
  assert.equal(f.versionCalls.length, 0);
});
test('requires completion marker and essential resources', async t => {
  const f = await fixture(t); const shell = await f.shell(); await rm(path.join(path.dirname(path.dirname(shell)), 'INSTALLATION_COMPLETE')); await assert.rejects(f.resolve(), /INSTALLATION_COMPLETE/);
  await f.shell(); await rm(path.join(path.dirname(shell), 'icudtl.dat')); await assert.rejects(f.resolve(), /icudtl.dat/);
});
test('checks real binary format, native architecture and content digest', async t => {
  const f = await fixture(t); const shell = await f.shell(); const foreign = Buffer.alloc(32); foreign.writeUInt32LE(0xfeedfacf); foreign.writeUInt32LE(0x01000007, 4); foreign.writeUInt32LE(2, 12); await writeFile(shell, foreign); await assert.rejects(f.resolve(), /architecture/i);
  await writeFile(shell, '#!/bin/sh\necho Google Chrome for Testing 145.0.7632.6'); await assert.rejects(f.resolve(), /Mach-O|binary/i);
  await f.shell(); const handle = await open(shell, 'r+'); await handle.write(Buffer.from('forged!'), 0, 7, 64); await handle.close();
  await assert.rejects(f.resolve(), /SHA-256|digest/i); assert.equal(f.versionCalls.length, 0);
});
test('rejects active download lock, marker directories, corrupt resources and forged binary bytes', async t => {
  const f = await fixture(t); const shell = await f.shell();
  await mkdir(path.join(f.cache, '__dirlock')); await assert.rejects(f.resolve(), /download lock/); await rm(path.join(f.cache, '__dirlock'), { recursive: true });
  const marker = path.join(path.dirname(path.dirname(shell)), 'INSTALLATION_COMPLETE'); await rm(marker); await mkdir(marker); await assert.rejects(f.resolve(), /regular file/); await rm(marker, { recursive: true }); await f.shell();
  await writeFile(path.join(path.dirname(shell), 'icudtl.dat'), 'corrupt resource'); await assert.rejects(f.resolve(), /resource SHA-256/);
  for (const extra of [{ binaryDigest: () => digest }, { resourceDigest: () => digest }, { versionProbe: () => '145.0.7632.6' }, { platform: 'darwin' }]) await assert.rejects(f.resolve(extra), /Unsupported.*field/);
});

test('checks the actual --version result, not folder revision', async t => {
  const f = await fixture(t); await f.shell();
  for (const result of ['Google Chrome for Testing 146.0.1.0', '145.0.7632.6', '']) { f.setVersion(result); await assert.rejects(f.resolve(), /version/i); }
  assert.equal(f.versionCalls.length, 3);
});
test('unavailable resolver preserves explicit failure receipt without fabricated observations', async t => {
  const f = await fixture(t);
  for (const [name, env] of [['empty', { APITU_CHROME: '' }], ['missing', { APITU_CHROME: path.join(f.home, 'missing') }]]) {
    const artifactPath = path.join(f.home, `${name}.html`); await writeFile(artifactPath, '<!doctype html><main>real missing-browser fixture</main>');
    const result = await runBrowserCheck({ artifactPath, env, cwd: f.home });
    assert.equal(result.exitCode, 1); assert.equal(result.receipt.ok, false); assert.equal(result.receipt.status, 'fail'); assert.equal(result.receipt.browserUnavailable, true); assert.equal(result.receipt.chrome.status, 'unavailable');
    for (const gate of ['containment', 'readability', 'viewerChrome', 'themeStates']) { assert.equal(result.receipt[gate].status, 'fail'); assert.match(result.receipt[gate].reason, /not executed/); assert.deepEqual(result.receipt[gate].viewports, []); }
    assert.match(result.receipt.error, /APITU_CHROME/);
  }
});

test('rejects unsupported system, architecture, host override and inconsistent package manifest', async t => {
  const f = await fixture(t); await f.shell();
  for (const [key, value] of [['platform', 'linux'], ['arch', 'x64'], ['release', '21.0.0']]) {
    const original = os[key]; os[key] = () => value; syncBuiltinESMExports();
    try { await assert.rejects(f.resolve(), /supported|verified|system/i); } finally { os[key] = original; syncBuiltinESMExports(); }
  }
  await assert.rejects(f.resolve({ env: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'mac15-arm64' } }), /override/i);
  await writeFile(path.join(f.playwrightPackageRoot, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.59.0' })); await assert.rejects(f.resolve(), /1.58.2|package/i);
});
