import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ChromeVisualBrowser, findChrome } from '../vendor/core/bin/visual-check.mjs';

const vendor = process.env.APITU_EXPORT_VENDOR || fileURLToPath(new URL('../vendor/core/', import.meta.url));

// Inject failures into real browser APIs rather than matching implementation
// strings. Native streams/recorders still run, so cleanup assertions detect
// abandoned browser resources as well as pending promises and false receipts.
test('real Chrome export failures settle, report errors, and release recording resources', { timeout: 120_000 }, async (t) => {
  const chrome = findChrome();
  assert.ok(chrome, 'A real Chrome installation is required; no silent skips.');
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apitu-export-errors-')));
  const html = path.join(scratch, 'trace.html');
  const rendered = spawnSync(process.execPath, [path.join(vendor, 'bin/apitu.mjs'), 'render', 'sequence',
    path.join(vendor, 'examples/cache-miss-request.sequence.json'), html], {
    cwd: scratch, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(rendered.error, undefined);
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  const browser = new ChromeVisualBrowser(chrome);
  t.after(async () => {
    await browser.close();
    console.log(`APITU_EXPORT_ERROR_ARTIFACTS=${scratch}`);
  });
  const session = await browser.sessionPromise;
  const send = (method, params, timeout) => browser.cdp.send(method, params, session, timeout);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 25_000);
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
    return result.result?.value;
  }
  async function load() {
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    loaded.catch(() => {});
    const navigation = await send('Page.navigate', { url: pathToFileURL(html).href });
    assert.equal(navigation.errorText, undefined);
    await loaded;
    await evaluate('document.fonts.ready.then(() => true)');
    assert.equal(await evaluate("document.querySelector('.diagram-container svg').getAttribute('data-animation')"), 'trace');
  }

  const scenarios = [
    ['svg serialization', 'svg', 'serialize', 0],
    ['WebM serialization', 'webm', 'serialize', 0],
    ['WebM scene initialization', 'webm', 'scene', 0],
    ['WebM captureStream', 'webm', 'capture', 0],
    ['WebM recorder construction', 'webm', 'constructor', 1],
    ['WebM first frame drawing', 'webm', 'first-draw', 1],
    ['WebM recorder.start', 'webm', 'start', 1],
    ['WebM synchronous start error event', 'webm', 'start-error-event', 1],
    ['WebM subsequent animation frame', 'webm', 'later-draw', 1],
    ['WebM recorder error callback', 'webm', 'recorder-error', 1],
    ['WebM data callback', 'webm', 'data-callback', 1],
    ['WebM final Blob construction', 'webm', 'final-blob', 1],
    ['WebM recorder.requestData', 'webm', 'request-data', 1],
    ['WebM synchronous flush data error', 'webm', 'flush-data-error', 1],
    ['WebM recorder.stop', 'webm', 'stop', 1],
  ];
  for (const [name, format, fault, minimumTracks] of scenarios) {
    await t.test(name, async () => {
      await load();
      const result = await evaluate(`(async () => {
        const fault = ${JSON.stringify(fault)};
        const format = ${JSON.stringify(format)};
        const message = 'injected ' + fault + ' failure';
        const errors = [], alerts = [], urls = new Set(), tracks = [], recorders = [];
        const timers = new Set(), frames = new Set();
        let draws = 0, downloads = 0, syncThrow = false, settled = 'pending', rejection = '';
        const nativeTimeout = window.setTimeout.bind(window);
        const nativeClearTimeout = window.clearTimeout.bind(window);
        const nativeRaf = window.requestAnimationFrame.bind(window);
        const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
        window.addEventListener('error', e => errors.push(e.message));
        window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
        window.alert = text => alerts.push(text);
        const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => { const url = createUrl(blob); urls.add(url); return url; };
        URL.revokeObjectURL = url => { urls.delete(url); revokeUrl(url); };
        HTMLAnchorElement.prototype.click = function () { downloads++; };
        window.setTimeout = function (callback, ms) {
          // The export's duration, flush and deadline timers, not toast/viewer timers.
          const recordingTimer = [6000, 120, 16000].includes(ms);
          let id = nativeTimeout(() => { timers.delete(id); callback(); }, ms);
          if (recordingTimer) timers.add(id);
          return id;
        };
        window.clearTimeout = id => { timers.delete(id); nativeClearTimeout(id); };
        window.requestAnimationFrame = callback => {
          let id = nativeRaf(now => { frames.delete(id); callback(now); });
          if (callback.name === 'draw') frames.add(id);
          return id;
        };
        window.cancelAnimationFrame = id => { frames.delete(id); nativeCancelRaf(id); };
        const capture = HTMLCanvasElement.prototype.captureStream;
        HTMLCanvasElement.prototype.captureStream = function (...args) {
          if (fault === 'capture') throw new Error(message);
          const stream = capture.apply(this, args);
          tracks.push(...stream.getTracks());
          return stream;
        };
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) {
          draws++;
          if (fault === 'first-draw' || (fault === 'later-draw' && draws > 1)) throw new Error(message);
          return draw.apply(this, args);
        };
        const NativeRecorder = window.MediaRecorder;
        window.MediaRecorder = new Proxy(NativeRecorder, { construct(target, args) {
          if (fault === 'constructor') throw new Error(message);
          const recorder = new target(...args);
          recorders.push(recorder);
          const start = recorder.start.bind(recorder);
          recorder.start = (...values) => {
            if (fault === 'start') throw new Error(message);
            const result = start(...values);
            if (fault === 'start-error-event') recorder.dispatchEvent(new ErrorEvent('error', { error: new Error(message) }));
            if (fault === 'recorder-error') nativeTimeout(() => recorder.dispatchEvent(new ErrorEvent('error', { error: new Error(message) })), 30);
            if (fault === 'data-callback') nativeTimeout(() => {
              const event = new Event('dataavailable');
              Object.defineProperty(event, 'data', { get() { throw new Error(message); } });
              recorder.dispatchEvent(event);
            }, 30);
            return result;
          };
          if (fault === 'request-data') recorder.requestData = () => { throw new Error(message); };
          if (fault === 'flush-data-error') recorder.requestData = () => {
            const event = new Event('dataavailable');
            Object.defineProperty(event, 'data', { get() { throw new Error(message); } });
            recorder.dispatchEvent(event);
          };
          if (fault === 'stop') {
            const stop = recorder.stop.bind(recorder);
            let calls = 0;
            recorder.stop = () => { if (++calls === 1) throw new Error(message); return stop(); };
          }
          return recorder;
        }});
        if (fault === 'final-blob') {
          const NativeBlob = window.Blob;
          let calls = 0;
          window.Blob = new Proxy(NativeBlob, { construct(target, args) {
            if (++calls > 1) throw new Error(message);
            return new target(...args);
          }});
        }
        if (fault === 'serialize') XMLSerializer.prototype.serializeToString = () => { throw new Error(message); };
        if (fault === 'scene') document.querySelector('.diagram-container svg').getCTM = () => { throw new Error(message); };
        // A previous success must not survive an unsuccessful export attempt.
        document.documentElement.setAttribute('data-last-export-format', 'old-success');
        document.documentElement.setAttribute('data-last-export-bytes', '123');
        try {
          apitu.exportMenu.run(format).then(() => { settled = 'resolved'; }, error => {
            settled = 'rejected'; rejection = error.message;
          });
        } catch (error) { syncThrow = true; rejection = error.message; }
        const deadline = performance.now() + 9000;
        while (!syncThrow && settled === 'pending' && performance.now() < deadline) await new Promise(r => nativeTimeout(r, 25));
        await new Promise(r => nativeTimeout(r, 200));
        const root = document.documentElement;
        return { settled, syncThrow, rejection, errors, alerts, downloads, draws,
          uiError: root.getAttribute('data-last-export-error'), errorFormat: root.getAttribute('data-last-export-error-format'),
          receipt: root.getAttribute('data-last-export-format'), receiptBytes: root.getAttribute('data-last-export-bytes'),
          activeUrls: urls.size, activeTimers: timers.size, activeFrames: frames.size,
          trackCount: tracks.length, trackStates: tracks.map(track => track.readyState),
          recorderStates: recorders.map(recorder => recorder.state),
          toast: document.querySelector('.apitu-toast').textContent,
          motionTitle: document.querySelector('[data-format=webm]').title };
      })()`);
      assert.equal(result.syncThrow, false, JSON.stringify(result));
      assert.equal(result.settled, 'rejected', JSON.stringify(result));
      assert.equal(result.rejection, `injected ${fault} failure`);
      assert.deepEqual(result.errors, [], JSON.stringify(result));
      assert.equal(result.uiError, result.rejection);
      assert.equal(result.errorFormat, format);
      assert.equal(result.receipt, null);
      assert.equal(result.receiptBytes, null);
      assert.equal(result.downloads, 0);
      assert.equal(result.activeUrls, 0, JSON.stringify(result));
      assert.equal(result.activeTimers, 0, JSON.stringify(result));
      assert.equal(result.activeFrames, 0, JSON.stringify(result));
      assert.ok(result.trackCount >= minimumTracks, JSON.stringify(result));
      assert.ok(result.trackStates.every(state => state === 'ended'), JSON.stringify(result));
      assert.ok(result.recorderStates.every(state => state === 'inactive'), JSON.stringify(result));
      if (format === 'svg') {
        assert.equal(result.alerts.length, 1);
        assert.ok(result.alerts[0].includes(result.rejection), JSON.stringify(result));
      } else {
        assert.ok(result.toast.includes(result.rejection), JSON.stringify(result));
        assert.ok(result.motionTitle.includes(result.rejection), JSON.stringify(result));
      }
      console.log(`EXPORT_FAILURE=${name} ${JSON.stringify(result)}`);
    });
  }

  await t.test('real export menu clicks display failure without unhandled rejection', async () => {
    for (const format of ['svg', 'webm']) {
      await load();
      await evaluate(`(() => {
        window.exportClickErrors = []; window.exportClickAlerts = [];
        window.addEventListener('error', e => exportClickErrors.push(e.message));
        window.addEventListener('unhandledrejection', e => exportClickErrors.push(String(e.reason)));
        window.alert = text => exportClickAlerts.push(text);
        ${format === 'svg' ? 'XMLSerializer.prototype.serializeToString' : 'HTMLCanvasElement.prototype.captureStream'} = () => { throw new Error('injected menu failure'); };
      })()`);
      async function click(selector) {
        const box = await evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el || el.disabled) throw new Error('Missing or disabled export control');
          el.scrollIntoView({ block: 'center' });
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) throw new Error('Invisible export control');
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
      }
      await click('#btn-export');
      await click('[data-format=' + JSON.stringify(format) + ']');
      const result = await evaluate(`(async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return { errors: exportClickErrors, alerts: exportClickAlerts,
          message: document.documentElement.getAttribute('data-last-export-error'),
          receipt: document.documentElement.getAttribute('data-last-export-format'),
          toast: document.querySelector('.apitu-toast').textContent };
      })()`);
      assert.deepEqual(result.errors, [], JSON.stringify(result));
      assert.equal(result.message, 'injected menu failure', format + ' ' + JSON.stringify(result));
      assert.equal(result.receipt, null);
      assert.ok((format === 'svg' ? result.alerts[0] : result.toast).includes(result.message), JSON.stringify(result));
    }
  });
});
