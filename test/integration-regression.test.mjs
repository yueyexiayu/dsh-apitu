import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApi, createTaskManager, createTools } from '../lib/index.js';
import { SKILL_ROOT } from '../lib/core.js';

const temp = await mkdtemp(path.join(os.tmpdir(), 'apitu-integration-regression-'));
function fixture(mode = 'danger-full-access', defaultMode = 'read-only') {
  const session = { id: 'current-session', header: { cwd: temp }, mode };
  const other = { id: 'other-session', header: { cwd: temp }, mode: 'danger-full-access' };
  const calls = [];
  const ctx = {
    sessions: { get: id => [session, other].find(value => value.id === id) },
    sandboxPolicy: { resolve: input => { calls.push(input); return { mode: input.session?.mode || defaultMode, sessionId: input.session?.id, workspaceRoot: temp }; } },
  };
  const exec = { agent: { session } };
  function request(body, query = '', sessionId = session.id) {
    const url = new URL('http://local/api/apitu');
    if (sessionId !== null) url.searchParams.set('sessionId', sessionId);
    if (query) url.searchParams.set('jobId', query);
    return new Request(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(sessionId === null ? body : { ...body, sessionId }) });
  }
  return { ctx, session, exec, calls, request };
}
async function settled(api, f, id) {
  for (let i = 0; i < 100; i++) {
    const body = await (await api.fetch(f.request(undefined, id))).json();
    if (body.status !== 'running') return body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Task did not leave its CLI-running state.');
}

test('single-job GET reflects preview build success while list GET only confirms retrieval', async () => {
  const f = fixture();
  let preview = { id: 'build-states', status: 'running', processStatus: 'running', buildStatus: 'checking', artifacts: [] };
  const manager = createTaskManager({ statusReader: async () => ({ ...preview }) });
  const api = createApi(f.ctx, { manager });
  const result = await createTools(f.ctx, async () => ({ ok: true, preview: { ...preview } }), manager).execute({ action: 'run', args: ['preview'] }, f.exec);
  for (const [buildStatus, expected] of [['needs-fix', false], ['unavailable', false], ['checking', false], ['verified', true]]) {
    preview = { ...preview, buildStatus };
    const response = await api.fetch(f.request(undefined, result.jobId));
    assert.equal(response.status, 200);
    const job = await response.json();
    assert.equal(job.status, 'previewing');
    assert.equal(job.result.preview.buildStatus, buildStatus);
    assert.equal(job.result.ok, expected);
    assert.equal(job.ok, expected, `single-job GET must not claim ${buildStatus} is success`);
    const list = await (await api.fetch(f.request())).json();
    assert.equal(list.ok, true, 'list retrieval succeeds even when an individual build fails');
  }
});

test('single-job GET preserves pending retrieval success and exposes eventual CLI failure', async () => {
  const f = fixture(), manager = createTaskManager();
  let finish;
  const job = await manager.start({ args: ['help'], cwd: temp, source: 'tool', sessionId: f.session.id,
    runner: () => new Promise(resolve => { finish = resolve; }),
  });
  const api = createApi(f.ctx, { manager });
  const pending = await (await api.fetch(f.request(undefined, job.id))).json();
  assert.equal(pending.status, 'running');
  assert.equal(pending.result, null);
  assert.equal(pending.ok, true);
  finish({ ok: false, exitCode: 7, stderr: 'CLI failed' });
  await job.promise;
  const failed = await (await api.fetch(f.request(undefined, job.id))).json();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /CLI failed/);
  await api.dispose();
});

test('sidebar and tool use the same trusted live session despite reversed Host defaults', async () => {
  for (const [mode, defaultMode, allowed] of [
    ['danger-full-access', 'read-only', true],
    ['read-only', 'danger-full-access', false],
  ]) {
    const f = fixture(mode, defaultMode);
    let runs = 0;
    const runner = async () => { runs++; return { ok: true, artifacts: [], exitCode: 0 }; };
    const tool = createTools(f.ctx, runner), api = createApi(f.ctx, { runner });
    const execution = tool.execute({ action: 'run', args: ['help'] }, f.exec);
    if (allowed) await execution; else await assert.rejects(execution, /sandbox/);
    const response = await api.fetch(f.request({ action: 'run', args: ['help'], mode: 'danger-full-access', policy: { mode: 'danger-full-access' } }));
    assert.equal(response.status, allowed ? 202 : 400);
    if (allowed) await settled(api, f, (await response.json()).jobId);
    assert.equal(runs, allowed ? 2 : 0);
    const state = await (await api.fetch(f.request())).json();
    assert.equal(state.scope, 'session');
    assert.equal(state.policy.mode, mode);
    assert.ok(f.calls.length >= 3);
    assert.ok(f.calls.every(input => input.session === f.session), 'never resolve an untrusted mode or Host-default request');
    await api.dispose();
  }
});

test('missing, unknown and unloaded sessions fail closed without executing or listing another scope', async () => {
  const f = fixture();
  let runs = 0;
  const api = createApi(f.ctx, { runner: async () => { runs++; return { ok: true }; } });
  for (const id of [null, 'unknown']) {
    for (const body of [undefined, { action: 'run', args: ['help'], cwd: temp, mode: 'danger-full-access' }]) {
      const response = await api.fetch(f.request(body, '', id));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /sessionId|不存在或未加载/);
    }
  }
  f.ctx.sessions.get = () => undefined;
  assert.equal((await api.fetch(f.request({ action: 'demo', cwd: temp }))).status, 400);
  assert.equal(runs, 0);
  assert.equal(f.calls.length, 0);
});

test('real conversation render enters session history and opens only its registered artifact', async () => {
  const f = fixture();
  const output = path.join(temp, 'conversation.html');
  let opened;
  const tool = createTools(f.ctx), api = createApi(f.ctx, { opener: async value => { opened = value; } });
  const result = await tool.execute({ action: 'run', args: ['render', 'architecture', path.join(SKILL_ROOT, 'examples/web-app.architecture.json'), output] }, f.exec);
  assert.equal(result.ok, true, result.stderr);
  const list = await (await api.fetch(f.request())).json();
  assert.equal(list.jobs.length, 1);
  assert.equal(list.jobs[0].id, result.jobId);
  assert.equal(list.jobs[0].source, 'tool');
  assert.equal(list.jobs[0].sessionId, f.session.id);
  assert.deepEqual(list.jobs[0].result.artifacts, [output]);
  assert.equal((await api.fetch(f.request({ action: 'open', jobId: result.jobId, path: '/etc/untrusted.html' }))).status, 200);
  assert.equal(opened, output);
  assert.equal((await api.fetch(f.request({ action: 'open', jobId: result.jobId }, '', 'other-session'))).status, 409);
  assert.deepEqual((await (await api.fetch(f.request(undefined, '', 'other-session'))).json()).jobs, []);
  await api.dispose();
});

test('thrown conversation failures are registered and disposal aborts a tool-owned task', async () => {
  const f = fixture();
  const failTool = createTools(f.ctx, async () => { throw new Error('runner unavailable'); });
  await assert.rejects(failTool.execute({ action: 'run', args: ['help'] }, f.exec), /runner unavailable/);
  const api = createApi(f.ctx);
  const failed = (await (await api.fetch(f.request())).json()).jobs[0];
  assert.equal(failed.source, 'tool');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'runner unavailable');
  let signal;
  const tool = createTools(f.ctx, input => {
    signal = input.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('task cancelled')), { once: true }));
  });
  const pending = tool.execute({ action: 'run', args: ['help'] }, f.exec);
  const rejected = assert.rejects(pending, /task cancelled/);
  while (!signal) await new Promise(setImmediate);
  await api.dispose();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal((await (await api.fetch(f.request())).json()).jobs[0].status, 'failed');
});

test('preview build repair refreshes artifacts; stopped summaries survive core record eviction', async () => {
  const f = fixture();
  const output = path.join(temp, 'verified-preview.html');
  let current = { id: 'preview', status: 'running', processStatus: 'running', buildStatus: 'needs-fix', generation: 1, failure: { message: 'Invalid JSON' }, error: 'Invalid JSON', artifacts: [], lastVerified: null };
  let evicted = false;
  const manager = createTaskManager({
    statusReader: async () => { if (evicted) throw new Error('expired'); return { ...current }; },
    stopper: async () => { current = { ...current, status: 'stopped', processStatus: 'stopped' }; return { ok: true, preview: { ...current } }; },
  });
  const tool = createTools(f.ctx, async () => ({ ok: true, preview: { ...current }, artifacts: [] }), manager);
  let opened;
  const api = createApi(f.ctx, { manager, opener: async target => { opened = target; } });
  const started = await tool.execute({ action: 'run', args: ['preview'] }, f.exec);
  assert.equal(started.ok, false, 'a running process does not mean a valid build');
  let job = (await (await api.fetch(f.request())).json()).jobs[0];
  assert.equal(job.status, 'previewing');
  assert.match(job.error, /Invalid JSON/);
  assert.deepEqual(job.result.artifacts, []);
  current = { ...current, buildStatus: 'verified', generation: 2, failure: null, error: '', artifacts: [output], lastVerified: { generation: 2, path: output } };
  job = (await (await api.fetch(f.request())).json()).jobs[0];
  assert.equal(job.status, 'previewing');
  assert.equal(job.error, '');
  assert.equal(job.result.ok, true);
  assert.deepEqual(job.result.artifacts, [output]);
  assert.equal((await api.fetch(f.request({ action: 'open', jobId: started.jobId }))).status, 200);
  assert.equal(opened, output);
  assert.equal((await api.fetch(f.request({ action: 'stop-preview', jobId: started.jobId }))).status, 200);
  evicted = true;
  job = (await (await api.fetch(f.request())).json()).jobs[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.result.preview.processStatus, 'stopped');
  assert.deepEqual(job.result.artifacts, [output]);
  assert.equal((await api.fetch(f.request({ action: 'open', jobId: started.jobId }))).status, 200);
  await api.dispose(); // Must not stop a terminal record whose core cache expired.
});

test('preview disposal attempts every live preview and exposes a stop failure', async () => {
  const f = fixture();
  const stopped = [];
  const states = new Map(['one', 'two'].map(id => [id, { id, status: 'running', processStatus: 'running', buildStatus: 'verified', artifacts: [] }]));
  const manager = createTaskManager({
    statusReader: async id => states.get(id),
    stopper: async id => {
      stopped.push(id);
      if (id === 'one') throw new Error('stop failed');
      states.set(id, { ...states.get(id), status: 'stopped', processStatus: 'stopped' });
    },
  });
  for (const id of ['one', 'two']) await createTools(f.ctx, async () => ({ ok: true, preview: states.get(id) }), manager).execute({ action: 'run', args: ['preview'] }, f.exec);
  await assert.rejects(manager.dispose(), /disposal failed/);
  assert.deepEqual(stopped.sort(), ['one', 'two']);
  const jobs = await manager.list(f.session.id);
  assert.equal(jobs.find(job => job.result.preview.id === 'two').status, 'completed');
  const failed = jobs.find(job => job.result.preview.id === 'one');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result.ok, false);
  assert.match(failed.error, /stop failed/);
});

test('externally stopped then evicted previews do not break all task history or disposal', async () => {
  const f = fixture();
  const artifact = path.join(temp, 'external-preview.html');
  const preview = { id: 'external', status: 'running', processStatus: 'running', buildStatus: 'verified', artifacts: [artifact], lastVerified: { generation: 1 } };
  let evicted = false, stopCalls = 0;
  const manager = createTaskManager({
    statusReader: async () => { if (evicted) throw new Error('ended record expired'); return preview; },
    stopper: async () => { stopCalls++; throw new Error('already expired'); },
  });
  const tool = createTools(f.ctx, async () => ({ ok: true, preview }), manager);
  const started = await tool.execute({ action: 'run', args: ['preview'] }, f.exec);
  const api = createApi(f.ctx, { manager, opener: async () => {} });
  evicted = true;
  const response = await api.fetch(f.request());
  assert.equal(response.status, 200);
  const job = (await response.json()).jobs[0];
  assert.equal(job.status, 'failed');
  assert.equal(job.result.ok, false);
  assert.equal(job.result.preview.processStatus, 'unknown');
  assert.match(job.error, /ended record expired/);
  assert.deepEqual(job.result.artifacts, [artifact]);
  assert.equal((await api.fetch(f.request({ action: 'open', jobId: started.jobId }))).status, 200);
  const second = await createTools(f.ctx, async () => ({ ok: true, artifacts: [] }), manager).execute({ action: 'run', args: ['help'] }, f.exec);
  assert.equal(second.ok, true, 'an expired record must not prevent future tasks');
  await api.dispose();
  assert.equal(stopCalls, 0);
});

test('unavailable preview state is a visible failed build, not empty verified success', async () => {
  const f = fixture();
  const preview = { id: 'unavailable', status: 'running', processStatus: 'running', buildStatus: 'unavailable', error: 'State request failed', artifacts: [] };
  const manager = createTaskManager({ statusReader: async () => preview });
  const result = await createTools(f.ctx, async () => ({ ok: true, preview }), manager).execute({ action: 'run', args: ['preview'] }, f.exec);
  assert.equal(result.ok, false);
  const api = createApi(f.ctx, { manager });
  const job = (await (await api.fetch(f.request())).json()).jobs[0];
  assert.equal(job.status, 'previewing');
  assert.match(job.error, /State request failed/);
  assert.equal((await api.fetch(f.request({ action: 'open', jobId: result.jobId }))).status, 409);
});

test('real tool preview exposes invalid JSON, then verified persistent HTML usable after stop', async t => {
  const f = fixture();
  const candidate = path.join(temp, 'preview-candidate.json'), output = path.join(temp, 'real-preview.html');
  await writeFile(candidate, '{ invalid');
  let opened;
  const api = createApi(f.ctx, { opener: async target => { opened = target; } });
  t.after(() => api.dispose());
  const result = await createTools(f.ctx).execute({ action: 'run', args: ['preview', 'architecture', candidate, output] }, f.exec);
  assert.equal(result.ok, false);
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await (await api.fetch(f.request())).json()).jobs[0];
    if (job.result.preview.buildStatus === 'needs-fix') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(job.source, 'tool');
  assert.equal(job.status, 'previewing');
  assert.equal(job.result.preview.buildStatus, 'needs-fix');
  assert.match(job.error, /JSON/);
  assert.deepEqual(job.result.artifacts, []);
  await writeFile(candidate, await readFile(path.join(SKILL_ROOT, 'examples/web-app.architecture.json')));
  for (let i = 0; i < 100; i++) {
    job = (await (await api.fetch(f.request())).json()).jobs[0];
    if (job.result.preview.buildStatus === 'verified') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(job.result.preview.buildStatus, 'verified', job.error);
  assert.ok(job.result.preview.lastVerified);
  assert.deepEqual(job.result.artifacts, [output]);
  const verifiedHTML = await readFile(output, 'utf8');
  assert.match(verifiedHTML, /<html/i);
  await writeFile(output, '<html>tampered</html>');
  const unavailable = await createTools(f.ctx).execute({ action: 'preview-status', previewId: result.preview.id }, f.exec);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.preview.buildStatus, 'unavailable');
  assert.ok(unavailable.error);
  await writeFile(output, verifiedHTML);
  assert.equal((await api.fetch(f.request({ action: 'stop-preview', jobId: result.jobId }))).status, 200);
  assert.equal((await api.fetch(f.request({ action: 'open', jobId: result.jobId }))).status, 200);
  assert.equal(opened, output);
  assert.equal((await settled(api, f, result.jobId)).result.preview.processStatus, 'stopped');
});
