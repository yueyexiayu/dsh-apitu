import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, copyFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

// Test dependencies only: production options cannot replace hashing, OS or probes.
export async function fixture(t, resolveBrowser) {
  const source = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64');
  assert.equal(createHash('sha256').update(await readFile(path.join(source, 'chrome-headless-shell'))).digest('hex'), 'a46b3b1e63163fa2d2437fb6ae967cb5a73b50050bca32f1964e6129b6228244');
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pinned-headless-')));
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(home, { recursive: true, force: true }); });
  t.mock.method(os, 'homedir', () => home);
  let version = 'Google Chrome for Testing 145.0.7632.6';
  const versionCalls = [];
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    assert.deepEqual(args, ['--version']); assert.equal(options.killSignal, 'SIGKILL');
    versionCalls.push(file); return version;
  });
  syncBuiltinESMExports();
  const cache = path.join(home, 'Library/Caches/ms-playwright');
  const playwrightPackageRoot = path.join(home, 'node_modules/playwright-core');
  await mkdir(playwrightPackageRoot, { recursive: true });
  await writeFile(path.join(playwrightPackageRoot, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.58.2' }));
  await writeFile(path.join(playwrightPackageRoot, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium-headless-shell', revision: '1208', browserVersion: '145.0.7632.6' }] }));
  async function shell(root = cache, revision = '1208', arch = 'arm64') {
    const dir = path.join(root, `chromium_headless_shell-${revision}`, `chrome-headless-shell-mac-${arch}`);
    await mkdir(dir, { recursive: true });
    for (const name of ['chrome-headless-shell', 'ABOUT', 'LICENSE.headless_shell', 'icudtl.dat', 'headless_lib_data.pak', 'headless_lib_strings.pak', 'headless_command_resources.pak', 'v8_context_snapshot.arm64.bin', 'libEGL.dylib', 'libGLESv2.dylib', 'libvk_swiftshader.dylib', 'vk_swiftshader_icd.json', 'PrivacySandboxAttestationsPreloaded/manifest.json', 'PrivacySandboxAttestationsPreloaded/privacy-sandbox-attestations.dat', 'resources/accessibility/reading_mode_gdocs_helper/content.js', 'resources/accessibility/reading_mode_gdocs_helper/gdocs_script.js', 'resources/accessibility/reading_mode_gdocs_helper_manifest.json']) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await copyFile(path.join(source, name), path.join(dir, name), constants.COPYFILE_FICLONE);
    }
    await writeFile(path.join(path.dirname(dir), 'INSTALLATION_COMPLETE'), '');
    return path.join(dir, 'chrome-headless-shell');
  }
  const options = { env: {}, cwd: home, playwrightPackageRoot };
  const resolve = extra => Promise.resolve().then(() => resolveBrowser({ ...options, ...extra }));
  return { home, cache, playwrightPackageRoot, shell, options, resolve, versionCalls, setVersion: value => { version = value; } };
}
