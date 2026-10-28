// Transient per-runCore lifecycle channel. No browser factory, engine override or global pool.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalFuturePath } from '../renderers/shared/output-path.mjs';
const protocol = 'apitu-cli-owner-v1';
let cliOwner = null;
const requests = new Map();
let listening = false;
function request(kind, scope) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { requests.delete(requestId); reject(new Error(`CLI ownership ${kind} timed out`)); }, 10000);
    requests.set(requestId, { resolve, reject, timer });
    process.send({ protocol, kind, requestId, scope }, error => {
      if (!error || !requests.has(requestId)) return;
      requests.delete(requestId); clearTimeout(timer); reject(error);
    });
  });
}
const sameScope = (a, b) => a?.sessionId === b?.sessionId && a?.taskId === b?.taskId;
export async function installCliBrowserOwnership(scope) {
  if (typeof process.send !== 'function') return; // Standalone CLI/library retains its own real browser group.
  if (!listening) {
    listening = true;
    process.on('message', message => {
      if (message?.protocol !== protocol || message.kind !== 'ack') return;
      const pending = requests.get(message.requestId);
      if (!pending) return;
      requests.delete(message.requestId); clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.owner); else pending.reject(new Error(message.error || 'CLI ownership rejected'));
    });
    process.channel?.unref();
  }
  if (cliOwner) { if (!sameScope(scope, cliOwner.scope)) throw new Error('CLI owner scope cannot be rebound'); return; }
  const owner = await request('hello', scope);
  if (owner?.groupId !== process.pid || !sameScope(owner.scope, scope) || typeof owner.tmpDir !== 'string' || owner.tmpDir !== os.tmpdir()) throw new Error('CLI owner acknowledgement identity mismatch');
  cliOwner = { scope: Object.freeze({ ...scope }), groupId: owner.groupId, tmpDir: owner.tmpDir, receiptSequence: 0, active: false };
}
export function claimCliBrowser(scope) {
  if (!cliOwner) return null;
  if (!sameScope(scope, cliOwner.scope)) throw new Error('Browser does not belong to this CLI batch');
  if (cliOwner.active) throw new Error('This CLI batch already owns a browser; parallel jobs require independent CLI groups');
  cliOwner.active = true;
  return Object.freeze({ scope: cliOwner.scope, groupId: cliOwner.groupId });
}
export async function settleCliBrowser(owner) {
  if (!cliOwner || !sameScope(owner?.scope, cliOwner.scope) || owner.groupId !== cliOwner.groupId) throw new Error('Unknown CLI browser owner');
  await request('release-children', cliOwner.scope);
}
export function observeCliBrowser(owner) { return request('checkpoint', owner.scope); }
export function finishCliBrowser(owner) {
  if (cliOwner && sameScope(owner?.scope, cliOwner.scope) && owner.groupId === cliOwner.groupId) cliOwner.active = false;
}
// Managed CLI receipts never enter the user output namespace. The Host reads these
// private, write-once records only after CLI/group settlement, then removes its
// bound container before it commits any terminal receipt. No new IPC messages.
export function stageCliReceipt(file, value) {
  if (!cliOwner) return false;
  const sequence = ++cliOwner.receiptSequence;
  const envelope = { scope: cliOwner.scope, file: canonicalFuturePath(file), sequence, json: `${JSON.stringify(value, null, 2)}\n` };
  syncFs.writeFileSync(path.join(cliOwner.tmpDir, `apitu-receipt-${sequence}-${randomUUID()}.json`), JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
  return true;
}
function commitReceipts(records) {
  const created = [];
  try {
    // Preflight the entire set; open(wx) below also closes the concurrent-create race.
    for (const record of records) {
      try { syncFs.lstatSync(record.file); throw new Error(`Receipt output already exists: ${record.file}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const record of records) {
      let descriptor;
      try {
        descriptor = syncFs.openSync(record.file, 'wx', 0o600);
        const stat = syncFs.fstatSync(descriptor);
        created.push({ file: record.file, dev: stat.dev, ino: stat.ino });
        syncFs.writeFileSync(descriptor, record.json);
        syncFs.fsyncSync(descriptor);
      } finally { if (descriptor !== undefined) syncFs.closeSync(descriptor); }
    }
  } catch (error) {
    const failures = [error];
    for (const entry of created.reverse()) {
      try {
        const stat = syncFs.lstatSync(entry.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error(`Receipt rollback binding changed: ${entry.file}`);
        syncFs.unlinkSync(entry.file);
      } catch (cleanupError) { failures.push(cleanupError); }
    }
    throw new AggregateError(failures, `Host receipt publication failed: ${failures.map(item => item.message).join('; ')}`, { cause: error });
  }
}
function processes() {
  return new Promise((resolve, reject) => execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
    if (error) return reject(error);
    try {
      const rows = stdout.trim().split('\n').filter(Boolean).map(line => {
        const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!fields) throw new Error('Invalid process ownership snapshot');
        return { pid: +fields[1], ppid: +fields[2], pgid: +fields[3], birth: fields[4] };
      });
      resolve(new Map(rows.map(row => [row.pid, row])));
    } catch (error) { reject(error); }
  }));
}
const groupAlive = pid => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
export class OwnedProcessTree {
  #pid; #parentPid; #birth; #seen = new Map(); #settling = null;
  constructor(child) { this.#pid = child.pid; this.#parentPid = process.pid; }
  async checkpoint() {
    const rows = await processes(), root = rows.get(this.#pid);
    if (root && (root.pgid !== this.#pid || (this.#birth && root.birth !== this.#birth) || (!this.#birth && root.ppid !== this.#parentPid))) throw new Error('Owned process group identity changed');
    if (root) this.#birth ||= root.birth;
    const owned = new Set([...(root ? [root.pid] : []), ...[...this.#seen.values()].filter(item => rows.get(item.pid)?.birth === item.birth).map(item => item.pid)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values()) if (!owned.has(row.pid) && (row.pgid === this.#pid || owned.has(row.ppid))) { owned.add(row.pid); changed = true; }
    }
    for (const pid of owned) if (pid !== this.#pid) this.#seen.set(pid, rows.get(pid));
    return rows;
  }
  async drain(includeLeader = true) {
    if (this.#settling) { await this.#settling; if (!includeLeader) return; }
    this.#settling = (async () => {
      for (const name of ['SIGTERM', 'SIGKILL']) {
        let rows = await this.checkpoint();
        const targets = [...this.#seen.values()];
        if (includeLeader && rows.has(this.#pid)) targets.push(rows.get(this.#pid));
        for (const record of targets) {
          rows = await this.checkpoint();
          const actual = rows.get(record.pid);
          if (!actual || actual.birth !== record.birth) continue;
          try { process.kill(record.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        for (let turn = 0; turn < 20; turn++) {
          rows = await this.checkpoint();
          const knownLive = [...this.#seen.values()].some(record => rows.get(record.pid)?.birth === record.birth);
          const leaderLive = includeLeader && rows.has(this.#pid);
          if (!knownLive && !leaderLive && (!includeLeader || !groupAlive(this.#pid))) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      throw Object.assign(new Error(`Owned processes did not settle (group ${this.#pid})`), { code: 'BROWSER_CLEANUP_TIMEOUT', pid: this.#pid });
    })();
    try { await this.#settling; } finally { this.#settling = null; }
  }
}
export class OwnedCliJob {
  #scope; #container; #child; #pid; #tree; #inflight = new Set(); #errors = []; #closed = false; #closePromise = null; #receiptTargets;
  static async create(scope, receiptTargets = []) {
    const instance = new OwnedCliJob();
    instance.#scope = Object.freeze({ ...scope });
    instance.#receiptTargets = new Set(receiptTargets.map(file => canonicalFuturePath(file)));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apitu-cli-'));
    const canonical = await fs.realpath(directory), stat = await fs.lstat(canonical);
    instance.#container = Object.freeze({ path: canonical, dev: stat.dev, ino: stat.ino });
    return instance;
  }
  get tmpDir() { return this.#container.path; }
  bind(child) {
    if (this.#child) throw new Error('CLI ownership cannot be rebound');
    this.#child = child;
    this.#pid = child.pid;
    this.#tree = new OwnedProcessTree(child);
    child.on('message', message => {
      if (message?.protocol !== protocol || !['hello', 'checkpoint', 'release-children'].includes(message.kind)) return;
      const work = this.#message(message).catch(error => this.#errors.push(error)).finally(() => this.#inflight.delete(work));
      this.#inflight.add(work);
    });
  }
  async #containerMatches() {
    const stat = await fs.lstat(this.#container.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.#container.dev || stat.ino !== this.#container.ino || await fs.realpath(this.#container.path) !== this.#container.path) throw new Error(`CLI temporary container binding changed: ${this.#container.path}`);
  }
  async #message(message) {
    try {
      if (this.#closed || !sameScope(message.scope, this.#scope) || typeof message.requestId !== 'string') throw new Error('CLI ownership request does not belong to this job');
      await this.#containerMatches();
      const rows = await this.#tree.checkpoint(), root = rows.get(this.#pid);
      if (!root || root.ppid !== process.pid) throw new Error('CLI owner is not the actual spawned child');
      if (message.kind === 'release-children') await this.#tree.drain(false);
      this.#ack(message, true, { scope: this.#scope, groupId: this.#pid, tmpDir: this.#container.path });
    } catch (error) { this.#ack(message, false, undefined, error.message); throw error; }
  }
  #ack(message, ok, owner, error) {
    if (this.#child.connected) this.#child.send({ protocol, kind: 'ack', requestId: message.requestId, ok, owner, error }, failure => { if (failure && this.#child.connected) this.#errors.push(failure); });
  }
  async #readReceipts() {
    const latest = new Map();
    const names = (await fs.readdir(this.#container.path)).filter(name => /^apitu-receipt-\d+-[a-f0-9-]+\.json$/.test(name));
    if (names.length > 256) throw new Error('Too many staged CLI receipts');
    for (const name of names) {
      const file = path.join(this.#container.path, name);
      const descriptor = syncFs.openSync(file, syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW);
      let envelope;
      try {
        const stat = syncFs.fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error('Unsafe staged CLI receipt');
        envelope = JSON.parse(syncFs.readFileSync(descriptor, 'utf8'));
      } finally { syncFs.closeSync(descriptor); }
      if (typeof envelope.file !== 'string') throw new Error('Invalid staged receipt path');
      envelope.file = canonicalFuturePath(envelope.file);
      if (!sameScope(envelope.scope, this.#scope) || !this.#receiptTargets.has(envelope.file) || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 || typeof envelope.json !== 'string') throw new Error('Staged receipt does not belong to this CLI job/output');
      if (!latest.has(envelope.file) || latest.get(envelope.file).sequence < envelope.sequence) latest.set(envelope.file, envelope);
    }
    if (latest.size !== this.#receiptTargets.size) throw new Error('Expected terminal CLI receipts were not staged');
    for (const record of latest.values()) {
      const value = JSON.parse(record.json);
      if (value.ok !== true || value.status !== 'pass') throw new Error('CLI receipt is not terminal pass; Host will not commit it');
    }
    return [...latest.values()];
  }
  close({ commitReceipts: publish = false } = {}) { return this.#closePromise ||= this.#finishClose(publish); }
  async #finishClose(publish) {
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
    if (this.#pid) await this.#tree.drain(true);
    await this.#containerMatches();
    const receipts = publish && this.#receiptTargets.size ? await this.#readReceipts() : [];
    await this.#containerMatches();
    await fs.rm(this.#container.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    this.#closed = true;
    if (this.#errors.length) throw new AggregateError(this.#errors, 'CLI ownership request/cleanup failed', { cause: this.#errors[0] });
    if (publish) commitReceipts(receipts);
  }
}
