import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromeVisualBrowser, findChrome } from '../vendor/core/bin/visual-check.mjs';

const vendor = fileURLToPath(new URL('../vendor/core/', import.meta.url));

test('real isolated Chrome viewer: theme, node search/focus, PNG/SVG/WebM downloads', { timeout: 120_000 }, async (t) => {
  const chrome = findChrome();
  assert.ok(chrome, 'A real Chrome installation is required; this suite does not silently skip browser acceptance.');
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apitu-viewer-browser-')));
  let html = process.env.APITU_VIEWER_HTML;
  if (!html) {
    html = path.join(scratch, 'viewer.html');
    const rendered = spawnSync(process.execPath, [path.join(vendor, 'bin/apitu.mjs'), 'render', 'architecture',
      path.join(vendor, 'examples/web-app.architecture.json'), html], {
      cwd: scratch, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(rendered.error, undefined);
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  }
  html = fs.realpathSync(html);
  assert.ok(fs.statSync(html).isFile());
  const downloads = path.join(scratch, 'downloads');
  fs.mkdirSync(downloads);
  const browser = new ChromeVisualBrowser(chrome);
  t.after(async () => {
    // Only close the disposable browser we launched. The browser class owns
    // and removes its own newly-created profile; user Chrome is untouched.
    await browser.close();
    console.log(`APITU_VIEWER_ARTIFACTS=${scratch}`);
    console.log(`APITU_VIEWER_INPUT=${html}`);
  });
  const session = await browser.sessionPromise;
  const send = (method, params, timeout) => browser.cdp.send(method, params, session, timeout);
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 45_000);
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
    return result.result?.value;
  }
  async function click(selector) {
    const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing element'); if (el.disabled || el.hidden) throw new Error('Unavailable control'); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); if (!r.width || !r.height) throw new Error('Invisible control'); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
  loaded.catch(() => {});
  const url = pathToFileURL(html); url.searchParams.set('theme', 'dark');
  const nav = await send('Page.navigate', { url: url.href });
  assert.equal(nav.errorText, undefined);
  await loaded;
  await evaluate('document.fonts.ready.then(() => true)');
  assert.ok(await evaluate("document.querySelectorAll('.diagram-container svg [data-node-id]').length > 0"));

  await t.test('toolbar toggles dark to light and restores dark', async () => {
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
    await click('#btn-theme');
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    await click('#btn-theme');
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  });

  await t.test('node finder filters a stable ID and selecting it focuses the diagram node', async () => {
    const id = await evaluate("document.querySelector('.diagram-container svg [data-node-id]').dataset.nodeId");
    await click('#btn-node-finder');
    await click('#node-finder-input');
    await send('Input.insertText', { text: id });
    const matches = await evaluate("Array.from(document.querySelectorAll('#node-finder-results .node-finder-result')).map(el=>el.dataset.nodeId)");
    assert.ok(matches.includes(id));
    await click('#node-finder-results .node-finder-result[data-node-id=' + JSON.stringify(id) + ']');
    assert.equal(await evaluate("document.querySelector('.diagram-container svg').getAttribute('data-focus-active')"), id);
    assert.equal(await evaluate("document.querySelector('.diagram-container svg [data-focus-selected]').dataset.nodeId"), id);
    // Clear the reading focus through the real Escape keyboard interaction.
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  });

  async function exportFile(format) {
    await click('#btn-export');
    assert.equal(await evaluate("document.querySelector('#btn-export').getAttribute('aria-expanded')"), 'true');
    await click('[data-format=' + JSON.stringify(format) + ']');
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const filename = fs.readdirSync(downloads).find((name) => name.endsWith('.' + format));
      if (filename) {
        const result = path.join(downloads, filename);
        if (fs.statSync(result).size > 0) return result;
      }
      await delay(150);
    }
    const visible = await evaluate('document.body.innerText');
    throw new Error(`No completed ${format} download within 45 seconds. Viewer state:\n${visible}`);
  }

  await t.test('PNG export emits a decodable image with dimensions', async () => {
    const file = await exportFile('png');
    const bytes = fs.readFileSync(file);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(bytes.readUInt32BE(16) > 100); assert.ok(bytes.readUInt32BE(20) > 100);
    const uri = 'data:image/png;base64,' + bytes.toString('base64');
    const dimensions = await evaluate(`(async()=>{const image=new Image();image.src=${JSON.stringify(uri)};await image.decode();return [image.naturalWidth,image.naturalHeight]})()`);
    assert.deepEqual(dimensions, [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]);
    console.log(`PNG=${file} (${bytes.length} bytes, ${dimensions.join('x')})`);
  });

  await t.test('SVG export parses as SVG and retains graph geometry', async () => {
    const file = await exportFile('svg');
    const text = fs.readFileSync(file, 'utf8');
    const summary = await evaluate(`(()=>{const d=new DOMParser().parseFromString(${JSON.stringify(text)},'image/svg+xml');return {root:d.documentElement.localName,errors:d.querySelectorAll('parsererror').length,nodes:d.querySelectorAll('[data-node-id]').length,viewBox:d.documentElement.getAttribute('viewBox')};})()`);
    assert.equal(summary.root, 'svg'); assert.equal(summary.errors, 0); assert.ok(summary.nodes > 0); assert.ok(summary.viewBox);
    console.log(`SVG=${file} (${Buffer.byteLength(text)} bytes, ${summary.nodes} nodes)`);
  });

  await t.test('static diagrams correctly disable WebM export', async () => {
    assert.notEqual(await evaluate("document.querySelector('.diagram-container svg').getAttribute('data-animation')"), 'trace');
    assert.equal(await evaluate("document.querySelector('[data-format=webm]').disabled"), true);
  });

  await t.test('trace-enabled diagram exports and decodes a nonempty WebM motion clip', async () => {
    // Use an authored trace example, not DOM mutation that bypasses viewer guards.
    const traceHtml = path.join(scratch, 'trace-viewer.html');
    const rendered = spawnSync(process.execPath, [path.join(vendor, 'bin/apitu.mjs'), 'render', 'sequence',
      path.join(vendor, 'examples/cache-miss-request.sequence.json'), traceHtml], {
      cwd: scratch, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(rendered.error, undefined);
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
    const traceLoaded = browser.cdp.waitFor('Page.loadEventFired', session);
    traceLoaded.catch(() => {});
    const navigation = await send('Page.navigate', { url: pathToFileURL(traceHtml).href });
    assert.equal(navigation.errorText, undefined);
    await traceLoaded;
    await evaluate('document.fonts.ready.then(() => true)');
    assert.equal(await evaluate("document.querySelector('.diagram-container svg').getAttribute('data-animation')"), 'trace');
    assert.equal(await evaluate("document.querySelector('[data-format=webm]').disabled"), false);
    assert.ok(await evaluate("typeof MediaRecorder === 'function' && typeof HTMLCanvasElement.prototype.captureStream === 'function'"));
    const file = await exportFile('webm');
    const bytes = fs.readFileSync(file);
    assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    assert.ok(bytes.length > 1000);
    const uri = 'data:video/webm;base64,' + bytes.toString('base64');
    const video = await evaluate(`new Promise((resolve,reject)=>{const video=document.createElement('video');video.muted=true;video.onloadeddata=()=>resolve({width:video.videoWidth,height:video.videoHeight,readyState:video.readyState});video.onerror=()=>reject(new Error('Exported WebM decode failed'));video.src=${JSON.stringify(uri)};video.load();})`);
    assert.ok(video.width > 100); assert.ok(video.height > 100); assert.ok(video.readyState >= 2);
    console.log(`WEBM=${file} (${bytes.length} bytes, ${video.width}x${video.height})`);
  });
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(scratch, 'viewer.png'), Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
});
