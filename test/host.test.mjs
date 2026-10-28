import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply, createApi, createTools, inject } from '../lib/index.js';
import { SKILL_ROOT, parseArgs, prepareRun, previewStatus, readResource, resolveCwd, runCore, stopPreview } from '../lib/core.js';

const temp = await mkdtemp(path.join(os.tmpdir(), 'apitu-host-test-'));
const session = { id: 'test-session', header: { cwd: temp } };
const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) }, sessions: { get: id => id === session.id ? session : undefined } };
const sample = path.join(SKILL_ROOT, 'examples/web-app.architecture.json');
const request = (body, query = '') => new Request(`http://local/api/apitu?sessionId=${session.id}${query ? '&' + query.slice(1) : ''}`, body === undefined ? undefined : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify({ ...body, sessionId: session.id }) });

async function finished(api, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const body = await (await api.fetch(request(undefined, `?jobId=${id}`))).json();
    if (body.status !== 'running') return body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Mock job did not finish.');
}

test('Host declares services and registers a complete tool and buffered route', () => {
  let tool, route, disposer;
  apply({ ...ctx, tools: { register: value => { tool = value; } }, connection: { fetch: { register: value => { route = value; } } }, on: (event, callback) => { assert.equal(event, 'dispose'); disposer = callback; } });
  assert.deepEqual(inject, ['tools', 'connection', 'sandboxPolicy', 'sessions']);
  assert.equal(tool.name, 'apitu');
  assert.ok(tool.output.schema && tool.output.render);
  assert.equal(route.path, '/api/apitu');
  assert.equal(route.requestBody, 'buffered');
  assert.equal(typeof disposer, 'function');
});

test('guide returns the complete authoring entry and references are paginated', async () => {
  const tool = createTools({});
  const guide = await tool.execute({ action: 'guide' });
  assert.ok(guide.guidance.includes('current conversation agent'));
  assert.ok(guide.authoring.text.includes('apitu'));
  const resource = await readResource('schemas/architecture.schema.json', 1, 3);
  assert.equal(resource.nextOffset, 4);
  assert.equal(resource.text.split('\n').length, 3);
  await assert.rejects(readResource('../../package.json'), /outside/);
  await assert.rejects(readResource('SKILL.md', 0, 3), /offset/);
  await assert.rejects(readResource('bin/apitu.mjs'), /Markdown/);
});

test('CLI is denied without a verified full-access policy, never silently bypassed', async () => {
  let called = false;
  const runner = async () => { called = true; };
  for (const mode of ['read-only', 'workspace-write', 'unknown']) {
    await assert.rejects(createTools({ sandboxPolicy: { resolve: () => ({ mode }) } }, runner).execute({ action: 'run', args: ['help'], cwd: temp }), /sandbox/);
  }
  await assert.rejects(createTools({}, runner).execute({ action: 'run', args: ['help'], cwd: temp }), /cannot verify/);
  assert.equal(called, false);
});

test('tool resolves cwd from live session and passes the actual session into policy', async () => {
  const session = { requestHeader: () => ({ cwd: temp }) };
  let policyInput, runInput;
  const tool = createTools({ sandboxPolicy: { resolve: value => { policyInput = value; return { mode: 'danger-full-access' }; } } }, async value => { runInput = value; return { ok: true }; });
  const controller = new AbortController();
  await tool.execute({ action: 'run', args: ['help'] }, { agent: { session }, signal: controller.signal });
  assert.equal(policyInput.session, session);
  assert.equal(runInput.cwd, await resolveCwd(temp));
  assert.ok(runInput.signal instanceof AbortSignal);
  assert.equal(runInput.signal.aborted, false);
  await assert.rejects(resolveCwd(undefined), /explicit absolute/);
  await assert.rejects(resolveCwd('.'), /explicit absolute/);
});

test('bad argv, duplicate options and unsafe output reuse are explicit errors', async () => {
  assert.throws(() => parseArgs([]), /1–64/);
  assert.throws(() => parseArgs(['sh', '-c', 'anything']), /Unsupported/);
  assert.throws(() => parseArgs(['guide', '--lang']), /requires/);
  assert.throws(() => parseArgs(['guide', '--lang', 'zh', '--lang', 'en']), /Duplicate/);
  await assert.rejects(prepareRun(['render', 'architecture', sample], temp), /explicit NEW/);
  const existing = path.join(temp, 'keep.html');
  await writeFile(existing, 'sentinel');
  await assert.rejects(prepareRun(['render', 'architecture', sample, existing], temp), /refuses to overwrite/);
  const link = path.join(temp, 'link.html');
  await symlink(existing, link);
  await assert.rejects(prepareRun(['render', 'architecture', sample, link], temp), /refuses to overwrite/);
  assert.equal(await readFile(existing, 'utf8'), 'sentinel');
  // migrate --output is metadata, not a write to HTML.
  await prepareRun(['migrate', 'workflow', 'old.json', 'new.json', '--output', existing, '--to-schema', '2'], temp);
});

test('real runner validates/renders a new file and retains nonzero CLI diagnostics', async () => {
  const valid = await runCore({ args: ['validate', 'architecture', sample, '--json'], cwd: temp });
  assert.equal(valid.ok, true, valid.stderr);
  assert.ok(valid.stdout.length > 10);
  const output = path.join(temp, 'rendered.html');
  const rendered = await runCore({ args: ['render', 'architecture', sample, output], cwd: temp });
  assert.equal(rendered.ok, true, rendered.stderr);
  assert.deepEqual(rendered.artifacts, [output]);
  const bad = await runCore({ args: ['guide', '--not-a-real-option'], cwd: temp });
  assert.equal(bad.ok, false);
  assert.notEqual(bad.exitCode, 0);
  assert.ok(bad.stderr.length > 0);
});

test('pre-cancel and deadline never masquerade as success', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCore({ args: ['help'], cwd: temp, signal: controller.signal }), /abort/i);
  const result = await runCore({ args: ['help'], cwd: temp, timeoutMs: 1 });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /exceeded/);
});

test('preview returns a live URL, serves generated HTML, and stops explicitly', async t => {
  const result = await runCore({ args: ['preview', 'architecture', sample, path.join(temp, 'preview.html')], cwd: temp });
  assert.ok(result.preview?.id);
  t.after(() => stopPreview(result.preview.id));
  assert.equal(result.ok, result.preview.buildStatus === 'verified');
  let state;
  for (let i = 0; i < 100; i++) {
    state = await previewStatus(result.preview.id);
    if (state.buildStatus !== 'checking') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state.status, 'running');
  assert.equal(state.buildStatus, 'verified', state.error);
  const response = await fetch(result.preview.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html/i);
  let first = true;
  const api = createApi(ctx, { runner: async () => {
    if (first) { first = false; return result; }
    return { ok: true, exitCode: 0, stdout: '', stderr: '', artifacts: [] };
  } });
  let liveJobId;
  for (let i = 0; i < 34; i++) {
    const accepted = await (await api.fetch(request({ action: 'run', args: ['help'], cwd: temp }))).json();
    if (i === 0) liveJobId = accepted.jobId;
    await finished(api, accepted.jobId);
  }
  const stillVisible = await (await api.fetch(request(undefined, `?jobId=${liveJobId}`))).json();
  assert.equal(stillVisible.result.preview.status, 'running', 'history pruning must retain live preview controls');
  await stopPreview(result.preview.id);
  assert.equal((await previewStatus(result.preview.id)).status, 'stopped');
  await assert.rejects(fetch(result.preview.url));
});

test('API bad body/action/job errors are visible', async () => {
  const api = createApi(ctx);
  assert.equal((await api.fetch(request('{'))).status, 400);
  assert.equal((await api.fetch(request({ action: 'not-supported' }))).status, 400);
  assert.equal((await api.fetch(request(undefined, '?jobId=absent'))).status, 404);
  assert.equal((await api.fetch(request({ action: 'run', args: ['help'], cwd: 'relative' }))).status, 400);
  assert.equal((await api.fetch(request('x'.repeat(65537)))).status, 413);
});

test('API publishes success results and opens only its registered HTML', async () => {
  let opened, actualInput;
  const api = createApi(ctx, { runner: async input => { actualInput = input; return { ok: true, exitCode: 0, stdout: 'done', stderr: '', artifacts: [path.join(input.cwd, 'result.html')] }; },  opener: async target => { opened = target; } });
  const response = await api.fetch(request({ action: 'run', args: ['help'], cwd: temp }));
  assert.equal(response.status, 202);
  const { jobId } = await response.json();
  const job = await finished(api, jobId);
  assert.equal(job.status, 'completed');
  assert.deepEqual(actualInput.scope, { sessionId: job.sessionId, taskId: jobId });
  assert.equal(actualInput.cwd, job.cwd);
  assert.equal((await api.fetch(request({ action: 'open', jobId, index: 99 }))).status, 404);
  assert.equal((await api.fetch(request({ action: 'open', jobId }))).status, 200);
  assert.equal(opened, path.join(job.cwd, 'result.html'));
  const list = await (await api.fetch(request())).json();
  assert.equal(list.jobs[0].id, jobId);
});

test('API failed subprocess and thrown exception both produce failed jobs', async () => {
  for (const runner of [async () => ({ ok: false, exitCode: 2, stdout: '', stderr: 'bad candidate', artifacts: [] }), async () => { throw new Error('cannot spawn'); }]) {
    const api = createApi(ctx, { runner });
    const { jobId } = await (await api.fetch(request({ action: 'run', args: ['help'], cwd: temp }))).json();
    const job = await finished(api, jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.ok, false);
    assert.match(job.error, /bad candidate|cannot spawn/);
    assert.equal((await api.fetch(request({ action: 'open', jobId }))).status, 409);
  }
});

test('first API read after a preview crash is already failed with its actual exit code', async () => {
  const fakeNode = path.join(temp, 'crashing-preview-node');
  await writeFile(fakeNode, '#!/usr/local/bin/node\nconsole.log("preview http://127.0.0.1:1/"); setTimeout(() => process.exit(3), 200);\n');
  await chmod(fakeNode, 0o700);
  const api = createApi(ctx, { runner: options => runCore({ ...options, node: fakeNode }) });
  const { jobId } = await (await api.fetch(request({ action: 'run', cwd: temp, args: ['preview', 'architecture', sample, path.join(temp, 'crash.html')] }))).json();
  const started = await finished(api, jobId);
  assert.equal(started.result.exitCode, null);
  let failed = false;
  for (let i = 0; i < 100; i++) {
    if ((await previewStatus(started.result.preview.id)).status === 'failed') { failed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(failed, true);
  const firstRead = await (await api.fetch(request(undefined, `?jobId=${jobId}`))).json();
  assert.equal(firstRead.ok, false);
  assert.equal(firstRead.status, 'failed');
  assert.equal(firstRead.result.ok, false);
  assert.equal(firstRead.result.exitCode, 3);
});

test('API disposal aborts a running operation', async () => {
  let seen;
  const api = createApi(ctx, { runner: input => { seen = input.signal; return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled')))); } });
  const { jobId } = await (await api.fetch(request({ action: 'run', args: ['help'], cwd: temp }))).json();
  assert.ok(seen);
  api.dispose();
  assert.equal(seen.aborted, true);
  assert.equal((await finished(api, jobId)).status, 'failed');
});
