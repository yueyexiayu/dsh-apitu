import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SKILL_ROOT, readResource, runCore, previewStatus, stopAllPreviews } from '../lib/core.js';
import { checkRoadmapHtml } from '../vendor/core/scripts/roadmap-check.mjs';
import { validRoadmapEvidence } from '../vendor/core/bin/roadmap-browser-check.mjs';

const cli = path.join(SKILL_ROOT, 'bin/apitu.mjs');
const example = path.join(SKILL_ROOT, 'examples/apitu-plugin.roadmap.json');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apitu-roadmap-integration-test-')));
const document = JSON.parse(fs.readFileSync(example, 'utf8'));
const node = process.execPath;
function run(args) {
  const result = spawnSync(node, [cli, ...args], { cwd: scratch, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function success(args) {
  const result = run(args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function json(args) { return JSON.parse(success(args)); }
function input(name, value) {
  const target = path.join(scratch, name);
  fs.writeFileSync(target, JSON.stringify(value));
  return target;
}
after(async () => { await stopAllPreviews(); console.log(`APITU_ROADMAP_ARTIFACTS=${scratch}`); });

test('roadmap guide, packaged references, doctor and CLI capability routing are truthful', async () => {
  const guide = json(['guide', '功能梳理 API 说明 F1/A1', '--json']);
  assert.equal(guide.type, 'roadmap');
  assert.equal(guide.acceptanceProfile, 'roadmap-v1');
  assert.ok(json(['guide', '--json']).recipes.some(r => r.type === 'roadmap'));
  for (const resource of ['references/roadmap.md','schemas/roadmap.schema.json','examples/apitu-plugin.roadmap.json']) {
    assert.equal((await readResource(resource)).ok, true);
  }
  assert.match(success(['doctor']), /\[ok\] roadmap renderer, schema, and example/);
  assert.match(success(['--help']), /roadmap/);
  const rejected = run(['compare', 'roadmap', example, example, path.join(scratch, 'unsupported.html'), '--json']);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /compare.*architecture|architecture.*compare/i);
});

test('Host examples regenerates six types in a fresh isolated copy, leaving bundled files untouched', async () => {
  const before = fs.readdirSync(path.join(SKILL_ROOT, 'examples'), { recursive: true }).filter(name => fs.statSync(path.join(SKILL_ROOT, 'examples', name)).isFile()).map(name => [name, fs.readFileSync(path.join(SKILL_ROOT, 'examples', name)).toString('base64')]);
  const result = await runCore({ args: ['examples'], cwd: scratch, node: process.execPath });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.artifacts.length, 6);
  const roadmap = result.artifacts.find(file => path.basename(file) === 'apitu-plugin.roadmap.html');
  assert.ok(roadmap);
  assert.equal(checkRoadmapHtml(fs.readFileSync(roadmap, 'utf8')).ok, true);
  assert.deepEqual(fs.readdirSync(path.join(SKILL_ROOT, 'examples'), { recursive: true }).filter(name => fs.statSync(path.join(SKILL_ROOT, 'examples', name)).isFile()).map(name => [name, fs.readFileSync(path.join(SKILL_ROOT, 'examples', name)).toString('base64')]), before);
});

test('roadmap validation freezes candidate and selects own acceptance profile', () => {
  const receipt = json(['validate', 'roadmap', example, '--quality', 'standard', '--json']);
  assert.equal(receipt.composition.profile, 'roadmap-v1');
  assert.equal(receipt.candidate.sha256, createHash('sha256').update(fs.readFileSync(example)).digest('hex'));
  assert.equal(receipt.nextAction.arguments[receipt.nextAction.arguments.indexOf('--quality') + 1], 'roadmap-v1');
  const layout = json(['validate', 'roadmap', example, '--layout-json']);
  assert.equal(layout.diagramType, 'roadmap');
  assert.equal(layout.qualityProfile, 'roadmap-v1');
  assert.equal(layout.nodes.length, document.flow.stations.length + document.api.stations.length);
  assert.match(success(['inspect', 'roadmap', example]), /roadmap/);
});

let finalized;
test('real isolated Chrome finalize verifies own geometry/interaction gates without legacy PASS', () => {
  const output = path.join(scratch, 'finalized.html');
  const result = json(['finalize', 'roadmap', example, output, '--json']);
  assert.deepEqual(result.gates, { validate:'pass', deliver:'pass', check:'pass', 'browser-check':'pass' });
  assert.equal(result.quality, 'roadmap-v1');
  assert.equal(result.visualReview, 'not-requested');
  finalized = output;
  const receipt = JSON.parse(fs.readFileSync(path.join(scratch, 'finalized.browser-check.json'), 'utf8'));
  assert.equal(validRoadmapEvidence(receipt), true);
  assert.equal(receipt.provenance, 'current');
  for (const name of ['containment','readability','viewerChrome','themeStates']) assert.equal(receipt[name].status, 'not-applicable');
  assert.equal(receipt.captures.status, 'not-requested');
  for (const viewport of receipt.roadmap.viewports) {
    assert.equal(viewport.interactionDispatch, 'dom-events');
    assert.ok(viewport.checks.every(c => c.ok));
    for (const map of ['flow','api']) {
      const zoom = viewport.checks.find(c => c.name === `${map}-zoom-readable-labels`);
      assert.ok(zoom.details.zoomedMinTextPx >= 12);
      assert.equal(zoom.details.zoomPercent, 500);
      assert.ok(viewport.checks.find(c => c.name === `${map}-station-text-clearance`).ok);
      assert.ok(viewport.checks.find(c => c.name === `${map}-route-label-geometry`).ok);
    }
  }
  const insufficient = structuredClone(receipt);
  insufficient.roadmap.viewports[0].checks = [{ name:'fake', ok:true }];
  assert.equal(validRoadmapEvidence(insufficient), false);
});

test('legal all-static flow routes and empty subtitles finalize without invented packet movement', () => {
  const data = structuredClone(document);
  for (const station of [...data.flow.stations, ...data.api.stations]) station.subtitle = '';
  for (const route of data.flow.routes) { route.kind = 'manual'; route.color = 'jade'; }
  const fixture = input('static-flow.json', data);
  const output = path.join(scratch, 'static-flow.html');
  assert.equal(json(['finalize','roadmap',fixture,output,'--json']).ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(scratch, 'static-flow.browser-check.json'), 'utf8'));
  for (const viewport of receipt.roadmap.viewports) {
    const packets = viewport.checks.find(c => c.name === 'flow-packets');
    assert.equal(packets.ok, true);
    assert.deepEqual(packets.details, { expected:0, count:0, movement:'not-applicable' });
  }
});

test('legacy visual captures explicitly fail for roadmap instead of claiming theme/export coverage', () => {
  const result = run(['visual-check', finalized, '--json']);
  assert.notEqual(result.status, 0);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, false);
  assert.ok(receipt.diagnostics.some(d => d.code === 'roadmap/unsupported-visual-check'));
  assert.notEqual(receipt.themeStates.status, 'pass');
});

test('static checker rejects mutated style, unsafe dictionary, invalid routes and station overflow', () => {
  const html = fs.readFileSync(finalized, 'utf8');
  assert.equal(checkRoadmapHtml(html).ok, true);
  for (const [index, mutated] of [
    html.replace('<style>', '<style>body { color: red; }'),
    html.replace('const FLOW = ', 'const FLOW = (() => { throw Error("unsafe"); })(); const UNUSED = '),
    html.replace('</body>', '<script type="text/javascript">alert("extra")</script></body>'),
    html.replace('<body ', '<body onerror="alert(1)" '),
    html.replace('data-edge-to="flow:', 'data-edge-to="wrong:'),
    html.replace(/transform="translate\([\d.]+,[\d.]+\)"/, 'transform="translate(99999,60)"'),
  ].entries()) {
    assert.notEqual(mutated, html, `Mutation ${index} must actually modify the fixture`);
    assert.equal(checkRoadmapHtml(mutated).ok, false, `Mutation ${index} must fail`);
  }
});

test('hint dictionaries reject active HTML and malformed values with structured failures', () => {
  const html = fs.readFileSync(finalized, 'utf8');
  const mutate = (map, change) => html.replace(new RegExp(`const ${map} = (.*?);`), (_, source) => `const ${map} = ${JSON.stringify(change(JSON.parse(source)))};`);
  const mutations = [];
  for (const map of ['FLOW', 'API']) {
    for (const field of ['title', 'body']) {
      mutations.push(mutate(map, dict => {
        const entry = dict[Object.keys(dict)[0]];
        entry[field] = `${field === 'title' ? entry.title : ''}<img src=x onerror=alert(1)>`;
        return dict;
      }));
      mutations.push(mutate(map, dict => {
        dict[Object.keys(dict)[0]][field] += '>'; return dict;
      }));
    }
    for (const value of [7, {}, [], null, 'not a dictionary']) mutations.push(mutate(map, () => value));
    for (const value of [7, {}, [], null, {title:null,body:'text'}, {title:7,body:'text'}, {title:'F1 text',body:{}}, {title:'F1 text',body:null}]) {
      mutations.push(mutate(map, dict => { dict[Object.keys(dict)[0]] = value; return dict; }));
    }
  }
  mutations.push(html.replace(/data-key="[^"]+"/, 'data-key="constructor"'));
  mutations.forEach((mutated, index) => {
    assert.notEqual(mutated, html, `Dictionary mutation ${index} must modify the fixture`);
    let receipt;
    assert.doesNotThrow(() => { receipt = checkRoadmapHtml(mutated); }, `Dictionary mutation ${index} must fail without throwing`);
    assert.equal(receipt.ok, false, `Dictionary mutation ${index} must fail`);
    assert.equal(receipt.composition.status, 'fail');
    assert.ok(receipt.composition.issues.length > 0);
  });
  for (const [index, mutated] of [mutations[0], mutate('FLOW', () => 7), mutations.at(-1)].entries()) {
    const file = path.join(scratch, `unsafe-dictionary-${index}.html`);
    fs.writeFileSync(file, mutated);
    const result = run(['check',file,'--json']);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
  const safe = mutate('FLOW', dict => {
    const entry = dict[Object.keys(dict)[0]];
    entry.title += ' &lt;img onerror=&quot;alert(1)&quot;&gt;';
    entry.body = '&lt;script&gt; javascript: onerror= &lt;/script&gt;';
    return dict;
  });
  assert.equal(checkRoadmapHtml(safe).ok, true, 'Already escaped dictionary prose must remain legal text');
});

test('escaped active-looking prose remains safe text and passes static validation', () => {
  const data = structuredClone(document);
  data.meta.description = '说明 <img onerror="alert(1)" src="https://example.invalid/a"> 与 javascript: 均为纯文本';
  data.flow.stations[0].description = '不要执行 <script type="text/javascript">alert(1)</script>，只是文档字面量 onerror=';
  const fixture = input('safe-prose.json', data);
  const output = path.join(scratch, 'safe-prose.html');
  success(['render','roadmap',fixture,output]);
  assert.equal(checkRoadmapHtml(fs.readFileSync(output,'utf8')).ok, true);
});

test('strict provenance and Host no-overwrite constraints still reject stale roadmap artifacts', async () => {
  const before = fs.readFileSync(finalized);
  await assert.rejects(runCore({ args:['render','roadmap',example,finalized], cwd:scratch, node }), /overwrite/);
  assert.deepEqual(fs.readFileSync(finalized), before);
  const stale = path.join(scratch, 'stale.html');
  fs.writeFileSync(stale, Buffer.concat([before, Buffer.from('\n<!-- mutation -->')]));
  const result = run(['browser-check',stale,'--require-provenance','--json']);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test('roadmap preview reports verified current builds and retains last verified evidence on failure', { timeout:90000 }, async () => {
  const fixture = input('preview.json', document);
  const output = path.join(scratch, 'preview.html');
  const result = await runCore({ args:['preview','roadmap',fixture,output,'--no-open'], cwd:scratch, node });
  const id = result.preview.id;
  async function until(predicate) {
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      const state = await previewStatus(id);
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve,100));
    }
    throw Error('Roadmap preview never reached expected state.');
  }
  try {
    const verified = await until(state => state.buildStatus === 'verified');
    assert.deepEqual(verified.artifacts, [output]);
    assert.ok(verified.lastVerified.sha256);
    const html = fs.readFileSync(output, 'utf8');
    assert.equal(checkRoadmapHtml(html).ok, true);
    fs.writeFileSync(fixture, '{ broken');
    const failed = await until(state => state.buildStatus === 'needs-fix');
    assert.ok(failed.failure);
    assert.equal(failed.lastVerified.sha256, verified.lastVerified.sha256);
    assert.deepEqual(failed.artifacts, [output]);
  } finally { await stopAllPreviews(); }
});
