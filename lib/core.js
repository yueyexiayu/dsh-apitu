import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { parseBrowserExecutionRequest } from '@deepseek-ai/dsh-browser-use/execution';
import { OwnedCliJob } from '../vendor/core/bin/browser-owner.mjs';

const previews = new Map();
let startingPreviews = 0;
export const PREVIEW_LIMITS = Object.freeze({ active: 8, retained: 32, retentionMs: 30 * 60 * 1000 });
function prunePreviews() {
  const ended = [...previews.values()].filter(item => !['running', 'stopping'].includes(item.status));
  for (const item of ended) if (Date.now() - item.endedAt > PREVIEW_LIMITS.retentionMs) previews.delete(item.id);
  const retained = [...previews.values()].filter(item => !['running', 'stopping'].includes(item.status)).sort((a, b) => a.endedAt - b.endedAt);
  for (const item of retained.slice(0, Math.max(0, retained.length - PREVIEW_LIMITS.retained))) previews.delete(item.id);
}
async function refreshPreview(item) {
  if (item.status !== 'running') return;
  try {
    const response = await fetch(new URL('/state', item.url), { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`Preview state returned HTTP ${response.status}.`);
    const state = await response.json();
    if (!['checking', 'verified', 'needs-fix'].includes(state.status) || !Number.isInteger(state.generation)) throw new Error('Preview returned an invalid build state.');
    item.buildStatus = state.status;
    item.generation = state.generation;
    item.failure = state.failure;
    item.lastVerified = state.lastVerified;
    item.stateError = '';
  } catch (error) {
    item.stateError = error.message;
    item.buildStatus = 'unavailable';
  }
  // A broken state endpoint must not discard a still-valid earlier artifact.
  try {
    if (item.lastVerified) {
      const metadata = await lstat(item.output);
      if (!metadata.isFile() || metadata.size !== item.lastVerified.bytes) throw new Error('Preview artifact no longer matches its verified size.');
      const digest = createHash('sha256').update(await readFile(item.output)).digest('hex');
      if (digest !== item.lastVerified.sha256) throw new Error('Preview artifact no longer matches its verified digest.');
      item.artifacts = [item.output];
    } else item.artifacts = [];
  } catch (error) {
    item.stateError = [item.stateError, error.message].filter(Boolean).join('; ');
    item.buildStatus = 'unavailable';
    item.artifacts = [];
  }
}
export async function previewStatus(id) {
  prunePreviews();
  const item = previews.get(id);
  if (!item) throw new Error('Preview does not exist in this Host process or its ended record expired.');
  await refreshPreview(item);
  return previewSnapshot(item);
}
function previewSnapshot(item) {
  return { id: item.id, url: item.url, status: item.status, processStatus: item.status,
    buildStatus: item.buildStatus, generation: item.generation, failure: item.failure,
    lastVerified: item.lastVerified, artifacts: [...item.artifacts],
    exitCode: item.exitCode ?? null, error: item.error || item.stateError || item.failure?.message || item.failure?.error || '', stdout: item.stdout, stderr: item.stderr };
}
export async function stopPreview(id) {
  prunePreviews();
  const item = previews.get(id);
  if (!item) throw new Error('Preview does not exist in this Host process or its ended record expired.');
  await refreshPreview(item);
  await item.stop();
  // Snapshot directly: pruning another ended record must not break this stop.
  const preview = previewSnapshot(item);
  return { ok: preview.status !== 'failed' && !preview.error, preview, error: preview.error };
}
export async function stopAllPreviews() {
  await Promise.all([...previews.values()].filter(item => ['running', 'stopping'].includes(item.status)).map(item => item.stop()));
  prunePreviews();
}
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_ROOT = path.join(ROOT, 'vendor/core');
export const VERSION = '1.2.3';
export const CORE_VERSION = '3.1.0';
export const COMMANDS = Object.freeze(['help', 'render', 'compare', 'deliver', 'finalize', 'preview', 'validate', 'migrate', 'inspect', 'check', 'browser-check', 'visual-check', 'guide', 'brands', 'examples', 'doctor', 'demo', 'recover-output']);
const OPTIONS_WITH_VALUE = new Set(['--quality', '--repo-root', '--receipt', '--out-dir', '--candidate-sha256', '--output', '--to-schema', '--lang']);
const MAX_OUTPUT = 2 * 1024 * 1024;

export async function nodeExecutable() {
  const candidates = [process.env.APITU_NODE, /^(node|nodejs)(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : null, '/usr/local/bin/node', '/opt/homebrew/bin/node'];
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate, constants.X_OK); return candidate; } catch (error) {
      if (process.env.APITU_NODE === candidate) throw new Error(`APITU_NODE is not executable: ${candidate}`, { cause: error });
    }
  }
  throw new Error('apitu requires Node.js >=18; set APITU_NODE to an executable absolute path.');
}

export async function resolveCwd(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('cwd must be an explicit absolute local directory; the Host working directory is never used.');
  const actual = await realpath(value);
  if (!(await stat(actual)).isDirectory()) throw new Error('cwd is not a directory.');
  return actual;
}

export function parseArgs(args) {
  if (!Array.isArray(args) || !args.length || args.length > 64 || args.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0') || arg.length > 8192)) throw new Error('args must contain 1–64 non-empty CLI argument strings.');
  if (!COMMANDS.includes(args[0])) throw new Error(`Unsupported command: ${args[0]}. Use help for the complete CLI.`);
  const positional = [], options = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq < 0 ? arg : arg.slice(0, eq);
      if (OPTIONS_WITH_VALUE.has(key)) {
        const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
        if (!value || value.startsWith('--')) throw new Error(`${key} requires a value.`);
        if (key in options) throw new Error(`Duplicate option: ${key}`);
        options[key] = value;
      } else options[key] = true;
    } else positional.push(arg);
  }
  return { command: args[0], positional, options };
}

async function assertNew(target, cwd) {
  const resolved = path.resolve(cwd, target);
  try { await lstat(resolved); } catch (error) { if (error.code === 'ENOENT') return resolved; throw error; }
  throw new Error(`apitu refuses to overwrite an existing output: ${resolved}. Choose a new path; keep previous versions intact.`);
}

// The bundled CLI performs its own atomic artifact/sidecar writes. This adapter
// only starts new outputs, and refuses sandboxed invocations rather than bypassing
// DSH's FS policy with an unsandboxed child process.
export async function prepareRun(args, cwd) {
  const parsed = parseArgs(args);
  const { command, positional: p, options } = parsed;
  const outputs = [];
  if (['render', 'deliver', 'finalize', 'preview'].includes(command)) {
    if (!p[2]) throw new Error(`${command} requires type, input.json and an explicit NEW output.html in apitu.`);
    outputs.push(p[2]);
  }
  if (command === 'compare') {
    if (!p[3]) throw new Error('compare requires architecture, base.json, head.json and an explicit NEW output.html.');
    outputs.push(p[3]);
  }
  if (command === 'demo') {
    if (!p[0]) throw new Error('demo requires an explicit NEW output directory.');
    outputs.push(p[0]);
  }
  if (command === 'migrate') {
    if (!p[2]) throw new Error('migrate requires workflow, old.json and a NEW new.json.');
    outputs.push(p[2]);
  }
  // migrate --output only changes meta.output in the migrated JSON.
  for (const key of ['--receipt', '--out-dir']) if (typeof options[key] === 'string') outputs.push(options[key]);
  for (const output of outputs) await assertNew(output, cwd);
  return parsed;
}

async function listHtml(directory, budget = { count: 0 }) {
  const items = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return items; throw error; }
  for (const entry of entries) {
    if (++budget.count > 400) throw new Error('Too many demo output entries to enumerate.');
    const full = path.join(directory, entry.name);
    if (entry.isFile() && /\.html$/i.test(entry.name)) items.push(full);
    else if (entry.isDirectory()) items.push(...await listHtml(full, budget));
  }
  return items;
}

async function artifactPaths(parsed, cwd) {
  const { command, positional: p } = parsed;
  let candidates = [];
  if (['render', 'deliver', 'finalize', 'preview'].includes(command)) candidates = [path.resolve(cwd, p[2])];
  if (command === 'compare') candidates = [path.resolve(cwd, p[3])];
  if (command === 'demo') candidates = await listHtml(path.resolve(cwd, p[0]));
  const result = [];
  for (const candidate of candidates) {
    try { if ((await lstat(candidate)).isFile()) result.push(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

export async function runCore({ args, cwd, signal, timeoutMs = 180000, node, env = {}, scope }) {
  cwd = await resolveCwd(cwd);
  const execution = parseBrowserExecutionRequest({
    scope: scope ?? { sessionId: `apitu-cli:${process.pid}`, taskId: randomUUID() },
    purpose: 'web-regression', mode: 'headless', ownership: 'owned-process', capabilities: ['dom', 'screenshot'],
  });
  const parsed = await prepareRun(args, cwd);
  signal?.throwIfAborted();
  const executable = node || await nodeExecutable();
  let runtimeRoot = SKILL_ROOT;
  // The examples command regenerates its own packaged examples, not a listing.
  // Preserve the vendored snapshot by running that command in an isolated copy.
  if (args[0] === 'examples') {
    await mkdir(path.join(cwd, '.apitu'), { recursive: true });
    const isolated = await mkdtemp(path.join(cwd, '.apitu', 'examples-'));
    runtimeRoot = path.join(isolated, 'core');
    await cp(SKILL_ROOT, runtimeRoot, {
      recursive: true, errorOnExist: true, force: false,
      // Regeneration must publish new files, not overwrite packaged HTML copies.
      filter: source => !(path.dirname(source) === path.join(SKILL_ROOT, 'examples') && source.endsWith('.html')),
    });
  }
  const cli = path.join(runtimeRoot, 'bin', args[0] === 'recover-output' ? 'recover-output.mjs' : 'apitu.mjs');
  const cliArgs = args[0] === 'recover-output' ? args.slice(1) : [...args];
  // preview may open a browser only when explicitly requested through the UI.
  if (args[0] === 'preview' && !cliArgs.includes('--no-open')) cliArgs.push('--no-open');
  const isPreview = args[0] === 'preview';
  if (isPreview) {
    prunePreviews();
    const active = [...previews.values()].filter(item => ['running', 'stopping'].includes(item.status)).length;
    if (active + startingPreviews >= PREVIEW_LIMITS.active) throw new Error(`Preview capacity reached (${PREVIEW_LIMITS.active}); stop an active preview first.`);
    startingPreviews += 1;
  }
  let owner;
  try {
    signal?.throwIfAborted(); // Recheck after async node/examples preparation, before allocating a job.
    const receiptTargets = [];
    if (['finalize', 'browser-check', 'visual-check'].includes(parsed.command)) {
      const visual = await import('../vendor/core/bin/visual-check.mjs');
      const artifact = path.resolve(cwd, parsed.positional[parsed.command === 'finalize' ? 2 : 0]);
      const outDir = typeof parsed.options['--out-dir'] === 'string' ? path.resolve(cwd, parsed.options['--out-dir']) : undefined;
      receiptTargets.push((parsed.command === 'visual-check' ? visual.sidecarPaths : visual.browserCheckSidecarPaths)(artifact, { outDir }).receipt);
      if (parsed.command === 'finalize') {
        const finalize = await import('../vendor/core/bin/finalize.mjs');
        const receipt = typeof parsed.options['--receipt'] === 'string' ? path.resolve(cwd, parsed.options['--receipt']) : finalize.defaultFinalizeReceiptPath(artifact, { outDir });
        receiptTargets.push(receipt, finalize.defaultFinalizeSummaryPath(receipt));
      }
      const { canonicalFuturePath } = await import('../vendor/core/renderers/shared/output-path.mjs');
      for (let index = 0; index < receiptTargets.length; index++) receiptTargets[index] = canonicalFuturePath(receiptTargets[index]);
    }
    owner = await OwnedCliJob.create(execution.scope, receiptTargets);
  } catch (error) { if (isPreview) startingPreviews -= 1; throw error; }
  const captured = await new Promise((resolve, reject) => {
    let child;
    try {
      signal?.throwIfAborted();
      child = spawn(executable, [cli, ...cliArgs], {
        cwd, shell: false, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, ...env, TMPDIR: owner.tmpDir, APITU_NO_CLOBBER: '1', APITU_BROWSER_EXECUTION_SCOPE: JSON.stringify(execution.scope) },
      });
      owner.bind(child);
    } catch (error) {
      owner.close().then(() => reject(error), cleanupError => reject(new AggregateError([error, cleanupError], 'CLI acquisition and temporary-container cleanup failed', { cause: error })));
      return;
    }
    let stdout = '', stderr = '', bytes = 0, failure = '';
    let livePreview = null;
    let finishPreview;
    const previewDone = new Promise(resolve => { finishPreview = resolve; });
    let killTimer, releaseTimer;
    function signalOwned(name) {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name); else child.kill(name); }
      catch (error) { if (error.code !== 'ESRCH') failure += `; ${name} failed: ${error.message}`; }
    }
    function stop(reason) {
      if (failure) return;
      failure = reason;
      signalOwned('SIGTERM'); // CLI aborts its work and awaits its original browser/profile cleanup.
      killTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) signalOwned('SIGKILL');
        releaseTimer = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) {
            cleanup();
            const timeoutError = Object.assign(new Error(`Owned CLI ${child.pid} exit was not confirmed; success is not published`), { code: 'APITU_CLEANUP_TIMEOUT', pid: child.pid });
            owner.close().then(() => reject(new AggregateError([new Error(failure), timeoutError], timeoutError.message)), cleanupError => reject(new AggregateError([new Error(failure), timeoutError, cleanupError], `${timeoutError.message}; ${cleanupError.message}`)));
          }
        }, 2000);
      }, 12000);
    }
    const abort = () => stop('apitu execution cancelled.');
    let timer;
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(releaseTimer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => {
      if (child.pid) { stop(`apitu owned CLI error: ${error.message}`); return; }
      cleanup();
      owner.close().then(() => { finishPreview(); reject(error); }, cleanupError => { finishPreview(); reject(new AggregateError([error, cleanupError], 'CLI spawn and container cleanup failed', { cause: error })); });
    });
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT) { stop('apitu output exceeded 2 MiB; captured output is incomplete.'); return; }
        if (key === 'stdout') stdout += chunk; else stderr += chunk;
        if (livePreview) { livePreview.stdout = stdout; livePreview.stderr = stderr; }
        if (args[0] === 'preview' && !livePreview && !failure) {
          const ready = stdout.match(/^preview (http:\/\/127\.0\.0\.1:\d+\/\S*)/m);
          if (ready) {
            cleanup();
            const id = randomUUID();
            livePreview = { id, url: ready[1], status: 'running', output: path.resolve(cwd, parsed.positional[2]),
              buildStatus: 'checking', generation: 0, failure: null, lastVerified: null, artifacts: [], stateError: '', stdout, stderr, error: '',
              async stop() {
                if (livePreview.status !== 'running') return previewDone;
                livePreview.status = 'stopping';
                signalOwned('SIGTERM');
                const killTimer = setTimeout(() => stop('Preview required forced shutdown.'), 4000);
                try { await previewDone; } finally { clearTimeout(killTimer); }
              },
            };
            previews.set(id, livePreview);
            resolve({ ok: true, exitCode: null, stdout, stderr, preview: { id, url: ready[1], status: 'running', exitCode: null } });
          }
        }
      });
    }
    child.once('close', async (code, childSignal) => {
      cleanup();
      try { await owner.close({ commitReceipts: code === 0 && !failure && !signal?.aborted }); }
      catch (error) { failure = [failure, error.message].filter(Boolean).join('; '); }
      if (livePreview) {
        livePreview.exitCode = code ?? -1;
        const requestedStop = livePreview.status === 'stopping';
        livePreview.status = requestedStop && !failure ? 'stopped' : 'failed';
        livePreview.error = requestedStop && !failure ? '' : failure || `Preview exited unexpectedly (${code ?? childSignal}).`;
        livePreview.endedAt = Date.now();
        prunePreviews();
      }
      finishPreview();
      resolve({ ok: code === 0 && !failure, exitCode: code ?? -1, stdout, stderr: [stderr, failure, childSignal ? `Process signal: ${childSignal}` : ''].filter(Boolean).join('\n') });
    });
    timer = setTimeout(() => stop(`apitu exceeded ${timeoutMs}ms execution limit.`), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  }).finally(() => { if (isPreview) startingPreviews -= 1; });
  let data = null;
  try { data = JSON.parse(captured.stdout); } catch { /* Many bundled commands intentionally emit plain text, retained in full. */ }
  if (!captured.ok && data?.ok === true) {
    data = { ...data, ok: false, status: 'fail', hostSettlement: { status: 'fail', error: captured.stderr } };
    captured.stdout = `${JSON.stringify(data, null, 2)}\n`;
  }
  if (captured.preview) {
    captured.preview = await previewStatus(captured.preview.id);
    captured.ok = captured.preview.processStatus === 'running' && captured.preview.buildStatus === 'verified';
  }
  const artifacts = captured.preview ? captured.preview.artifacts : !captured.ok ? []
    : args[0] === 'examples' ? await listHtml(path.join(runtimeRoot, 'examples')) : await artifactPaths(parsed, cwd);
  return { ...captured, args: [...args], cwd, artifacts, data };
}

export async function readResource(resource = 'SKILL.md', offset = 1, limit = 180) {
  if (typeof resource !== 'string' || path.isAbsolute(resource) || resource.includes('\0')) throw new Error('resource must be relative to the bundled apitu core.');
  const root = await realpath(SKILL_ROOT);
  const target = await realpath(path.resolve(root, resource));
  if (!target.startsWith(root + path.sep)) throw new Error('Resource is outside the bundled core.');
  if (!/\.(md|json)$/i.test(target)) throw new Error('Only packaged Markdown/JSON references may be read.');
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 400) throw new Error('offset >=1 and limit 1–400 must be integers.');
  if ((await stat(target)).size > 1024 * 1024) throw new Error('Resource exceeds 1 MiB. Use a specific schema/reference instead.');
  const lines = (await readFile(target, 'utf8')).split('\n');
  return { ok: true, resource, path: target, offset, totalLines: lines.length, nextOffset: offset - 1 + limit < lines.length ? offset + limit : null, text: lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join('\n') };
}
