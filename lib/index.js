import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { COMMANDS, CORE_VERSION, SKILL_ROOT, VERSION, previewStatus, readResource, resolveCwd, runCore, stopAllPreviews, stopPreview } from './core.js';

export const name = 'apitu';
export const inject = ['tools', 'connection', 'sandboxPolicy', 'sessions'];
export const API_PATH = '/api/apitu';
const GUIDANCE = `apitu uses the complete apitu ${CORE_VERSION} core. For natural-language/codebase diagrams first read resource SKILL.md, references/authoring-defaults.md, the matching example and schema. Read references/repository-authoring.md for actual codebases; inspect real source and never infer an architecture from names alone. Write candidate JSON with normal DSH file tools, then run finalize TYPE INPUT NEW_OUTPUT --json. Six types: roadmap, architecture, workflow, sequence, dataflow, lifecycle. Use roadmap for Chinese feature/API station maps; read references/roadmap.md, examples/apitu-plugin.roadmap.json and schemas/roadmap.schema.json. Roadmap preserves the api-sheji dual-map template with zoom/pan, station clicks, filters and route packets; it does not implement legacy viewer themes/search/presentation/exports. Compare/migrate remain limited to their original supported types. Use the supplied absolute skillRoot for reference/CLI paths. Prefer .apitu/<type>-<slug>-<timestamp>/ for each request; use new output names on repair. apitu provides the bundled CLI commands and interactive HTML exports. Diagram validation is not a human visual review. Do not report failed checks as completed. Return the actual HTML path, receipt and browser/visual-review status. No separate model account or API key is required: the current conversation agent authors the diagram.`;

const message = error => error instanceof Error ? error.message : String(error);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const managers = new WeakMap();

export function assertExecutionPolicy(ctx, exec) {
  const policyService = ctx.sandboxPolicy;
  if (!policyService?.resolve) throw new Error('apitu cannot verify the DSH filesystem policy; CLI execution is blocked. Reference reading remains available.');
  const policy = policyService.resolve(exec?.agent ? { session: exec.agent.session } : {});
  if (policy?.mode !== 'danger-full-access') throw new Error(`[sandbox: apitu CLI requires danger-full-access; current mode: ${policy?.mode || 'unknown'}]. The bundled CLI starts child processes and cannot safely inherit a restricted filesystem sandbox. No command was run.`);
  return policy;
}

// One registry per plugin context, shared by conversation tools and sidebar requests.
export function createTaskManager({ statusReader = previewStatus, stopper = stopPreview } = {}) {
  const jobs = new Map();
  const controllers = new Set();
  let disposed = false;
  function update(job, result) {
    job.result = result;
    const preview = result.preview;
    if (preview) {
      const processStatus = preview.processStatus || preview.status;
      const failedBuild = ['needs-fix', 'unavailable', 'failed'].includes(preview.buildStatus);
      job.status = ['running', 'stopping'].includes(processStatus) ? 'previewing' : processStatus === 'failed' || failedBuild || preview.buildStatus !== 'verified' ? 'failed' : 'completed';
      result.ok = processStatus !== 'failed' && preview.buildStatus === 'verified';
      job.error = preview.error || (failedBuild ? message(preview.failure?.message || preview.failure || 'Preview build failed.') : job.status === 'failed' ? 'Preview stopped without a verified build.' : '');
      if (Array.isArray(preview.artifacts)) result.artifacts = preview.artifacts;
      result.exitCode = preview.exitCode;
    } else {
      job.status = result.ok ? 'completed' : 'failed';
      job.error = result.ok ? '' : result.stderr || result.stdout || `CLI exited with code ${result.exitCode}`;
    }
  }
  async function refresh(job) {
    if (job.result?.preview && job.status === 'previewing') {
      // Terminal task records own their final summary and persistent artifact
      // paths; they do not depend on the core's bounded ended-preview cache.
      try {
        const preview = await statusReader(job.result.preview.id);
        update(job, { ...job.result, preview });
      } catch (error) {
        // An externally stopped preview may have aged out before our next poll.
        // Preserve its registered artifact but never claim its process is live.
        job.status = 'failed';
        job.error = `Preview status unavailable: ${message(error)}`;
        job.result = { ...job.result, ok: false, preview: { ...job.result.preview, status: 'unknown', processStatus: 'unknown', error: job.error } };
      }
    }
    return { id: job.id, jobId: job.id, source: job.source, sessionId: job.sessionId, status: job.status, args: job.args, cwd: job.cwd, result: job.result, error: job.error, createdAt: job.createdAt };
  }
  async function prune() {
    const values = await Promise.all([...jobs.values()].map(refresh));
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (!['running', 'previewing'].includes(job.status) && (now - job.createdAt > 86400000 || jobs.size > 30)) jobs.delete(id);
    }
    return values.filter(job => jobs.has(job.id));
  }
  return {
    async start({ args, cwd, source, sessionId, signal, runner }) {
      if (disposed) throw new Error('apitu task manager has been disposed.');
      cwd = await resolveCwd(cwd);
      await prune();
      if (disposed) throw new Error('apitu task manager has been disposed.');
      if ([...jobs.values()].some(job => {
        if (job.status !== 'running') return false;
        if (sessionId && job.sessionId && job.sessionId !== sessionId) return false;
        return true;
      })) throw new Error('已有 apitu 任务正在运行，请等待完成。');
      const id = randomUUID(), controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      const effectiveSignal = controller.signal;
      const job = { id, status: 'running', source, sessionId: sessionId || null, args, cwd, result: null, error: '', createdAt: Date.now() };
      jobs.set(id, job); controllers.add(controller);
      job.promise = Promise.resolve().then(() => {
        effectiveSignal.throwIfAborted();
        return runner({ args, cwd, signal: effectiveSignal, scope: { sessionId, taskId: id } });
      }).then(async result => {
        update(job, result);
        if (disposed && result.preview) { await stopper(result.preview.id); await refresh(job); }
        return { ...job.result, jobId: id };
      }).catch(error => { job.status = 'failed'; job.error = message(error); if (job.result) job.result = { ...job.result, ok: false }; throw error; }).finally(() => { controllers.delete(controller); signal?.removeEventListener('abort', cancel); });
      // API callers observe failures in the job record; tools await and retain
      // thrown execution errors instead of creating an unhandled rejection.
      void job.promise.catch(() => {});
      return job;
    },
    async list(sessionId) { return (await prune()).filter(job => job.sessionId === sessionId).reverse(); },
    async get(id, sessionId) { const job = jobs.get(id); return job && job.sessionId === sessionId ? refresh(job) : null; },
    async stop(id, sessionId) {
      const job = await this.get(id, sessionId);
      if (!job?.result?.preview) throw new Error('该任务没有实时预览。');
      const result = await stopper(job.result.preview.id);
      await refresh(jobs.get(id));
      return result;
    },
    async dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      const results = await Promise.allSettled([...jobs.values()].map(async job => {
        try { await job.promise; } catch { /* The failed job preserves its diagnostic. */ }
        if (job.result?.preview && job.status === 'previewing') {
          try { await stopper(job.result.preview.id); await refresh(job); }
          catch (error) {
            job.status = 'failed'; job.error = `Preview disposal failed: ${message(error)}`;
            job.result = { ...job.result, ok: false, preview: { ...job.result.preview, error: job.error } };
            throw error;
          }
        }
      }));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'apitu preview disposal failed.');
    },
  };
}
function taskManager(ctx) {
  if (!managers.has(ctx)) managers.set(ctx, createTaskManager());
  return managers.get(ctx);
}
function trustedSession(ctx, id) {
  if (typeof id !== 'string' || !id) throw new Error('请关联当前会话；缺少 sessionId。');
  const session = ctx.sessions?.get?.(id);
  if (!session || session.id !== id) throw new Error('当前会话不存在或未加载；不会回落到 Host 默认策略。');
  return session;
}
function sessionCwd(session) {
  const value = session?.header?.cwd || session?.requestHeader?.()?.cwd;
  return typeof value === 'string' && path.isAbsolute(value) ? value : null;
}

export function createTools(ctx, runner = runCore, manager = taskManager(ctx)) {
  return {
    name: 'apitu',
    description: 'Create interactive roadmap, architecture, workflow, sequence, dataflow and lifecycle diagrams from ideas, plans or repository evidence using the complete bundled apitu core. First action=guide, then action=read for the exact example/schema; author candidate JSON with normal file tools and action=run with args ["finalize",TYPE,INPUT_JSON,NEW_OUTPUT_HTML,"--json"]. Includes validate/render/compare/migrate/inspect/check/browser-check/visual-check/guide/brands/examples/doctor/demo. Roadmap provides the Chinese dual-map template with zoom/pan, clicks, filters and animated packets, without legacy viewer themes/search/exports; the original five types retain themes/search/trace/presentation/PNG/JPEG/WebP/SVG/WebM exports. CLI commands require danger-full-access; never bypass a policy refusal. Existing output files are not overwritten. Generation uses this conversation model, no extra account.',
    timeoutMs: 200000,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['guide', 'read', 'run', 'preview-status', 'stop-preview'], description: 'guide returns authoring entry points; read returns packaged references; run executes the CLI; preview-status/stop-preview manage a live preview.' },
        resource: { type: 'string', description: 'For read: bundled relative Markdown/JSON path, e.g. SKILL.md or schemas/workflow.schema.json.' },
        previewId: { type: 'string', description: 'For preview-status/stop-preview: id returned by run preview. Preview remains running until stopped or Host exits.' },
        offset: { type: 'integer', description: 'First line, 1-based.' },
        limit: { type: 'integer', description: 'Lines to return, 1–400; follow nextOffset when present.' },
        args: { type: 'array', items: { type: 'string' }, description: 'CLI argv, starting with a supported command; no shell syntax. Write commands require an explicit new output path.' },
        cwd: { type: 'string', description: 'Absolute local working directory; defaults only to the actual agent session cwd, never Host process cwd.' },
      }, required: ['action'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
    isConcurrencySafe: () => false,
    async execute(args, exec = {}) {
      if (args.action === 'guide') return { ok: true, version: VERSION, coreVersion: CORE_VERSION, skillRoot: SKILL_ROOT, guidance: GUIDANCE, commands: COMMANDS, authoring: await readResource('SKILL.md') };
      if (args.action === 'read') return readResource(args.resource, args.offset, args.limit);
      if (args.action === 'preview-status') {
        const preview = await previewStatus(args.previewId);
        return { ok: preview.processStatus !== 'failed' && preview.buildStatus === 'verified', preview, error: preview.error || preview.failure };
      }
      if (args.action === 'stop-preview') return stopPreview(args.previewId);
      if (args.action !== 'run') throw new Error('Unknown apitu action.');
      assertExecutionPolicy(ctx, exec);
      const session = exec.agent?.session;
      const cwd = args.cwd || session?.header?.cwd || session?.requestHeader?.()?.cwd;
      const job = await manager.start({ args: args.args, cwd, source: 'tool', sessionId: session?.id, signal: exec.signal, runner });
      return job.promise;
    },
  };
}

export async function openArtifact(target) {
  if (process.platform !== 'darwin') throw new Error('Native open currently supports macOS only. Open the returned HTML path directly.');
  if (!path.isAbsolute(target) || !/\.html$/i.test(target) || !(await lstat(target)).isFile()) throw new Error('Artifact is not a regular HTML file.');
  const head = (await readFile(target, 'utf8')).slice(0, 20000);
  if (!/<!doctype html|<html/i.test(head)) throw new Error('Artifact is not an HTML document.');
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', [target], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`open exited with code ${code}`)));
  });
}

export function createApi(ctx, { runner = runCore, opener = openArtifact, manager = taskManager(ctx) } = {}) {
  return {
    dispose: () => manager.dispose(),
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (request.method === 'GET') {
          const session = trustedSession(ctx, url.searchParams.get('sessionId'));
          const policy = ctx.sandboxPolicy.resolve({ session });
          const id = url.searchParams.get('jobId');
          if (id) {
            const value = await manager.get(id, session.id);
            if (!value) return json(404, { ok: false, error: '任务不存在或已过期。' });
            return json(200, { ok: value.result ? value.result.ok === true : value.status !== 'failed', ...value });
          }
          return json(200, { ok: true, version: VERSION, coreVersion: CORE_VERSION, skillRoot: SKILL_ROOT, guidance: GUIDANCE, commands: COMMANDS, scope: 'session', sessionId: session.id, cwd: sessionCwd(session), policy, jobs: await manager.list(session.id) });
        }
        if (request.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed.' });
        const body = await request.text();
        if (Buffer.byteLength(body) > 65536) return json(413, { ok: false, error: '请求超过 64 KiB。' });
        let input;
        try { input = JSON.parse(body); } catch { return json(400, { ok: false, error: '请求不是有效 JSON。' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(400, { ok: false, error: '请求必须是对象。' });
        const session = trustedSession(ctx, input.sessionId);
        if (input.action === 'run' || input.action === 'demo') {
          assertExecutionPolicy(ctx, { agent: { session } });
          const cwd = input.cwd || session.header?.cwd || session.requestHeader?.()?.cwd;
          const args = input.action === 'demo' ? ['demo', path.join(await resolveCwd(cwd), '.apitu', `demo-${Date.now()}-${randomUUID().slice(0, 8)}`)] : input.args;
          const job = await manager.start({ args, cwd, source: 'sidebar', sessionId: session.id, runner });
          return json(202, { ok: true, jobId: job.id });
        }
        if (input.action === 'stop-preview') return json(200, await manager.stop(input.jobId, session.id));
        if (input.action === 'open') {
          const job = await manager.get(input.jobId, session.id);
          const verifiedPreview = job?.result?.preview?.lastVerified && job.result.artifacts?.length;
          if (!job || !(job.status === 'completed' && job.result?.ok || verifiedPreview)) return json(409, { ok: false, error: '只能打开成功生成的 HTML 产物。' });
          const index = input.index ?? 0;
          if (!Number.isInteger(index) || index < 0 || !job.result?.artifacts?.[index]) return json(404, { ok: false, error: '该任务没有所选 HTML 产物。' });
          await opener(job.result.artifacts[index]);
          return json(200, { ok: true });
        }
        return json(400, { ok: false, error: '未知 action。' });
      } catch (error) { return json(400, { ok: false, error: message(error) }); }
    },
  };
}

export function apply(ctx) {
  const manager = taskManager(ctx);
  ctx.tools.register(createTools(ctx, runCore, manager));
  const api = createApi(ctx, { manager });
  ctx.connection.fetch.register({ path: API_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => api.fetch(request) });
  ctx.effect(() => () => Promise.resolve().then(async () => {
    try { await api.dispose(); } finally { await stopAllPreviews(); }
  }), 'apitu.lifecycle');
}
