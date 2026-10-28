import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileRoadmap, ROADMAP_TEMPLATE, validateRoadmapSchema } from '../vendor/core/renderers/roadmap/roadmap-compiler.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const input = path.join(root, 'vendor/core/examples/apitu-plugin.roadmap.json');
const renderer = path.join(root, 'vendor/core/renderers/roadmap/render-roadmap.mjs');
const fixture = () => JSON.parse(fs.readFileSync(input, 'utf8'));
const sha = text => createHash('sha256').update(text).digest('hex');
const script = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];
function tmp(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'apitu-roadmap-test-'));
  t.after(() => {
    assert.equal(path.resolve(folder), folder);
    assert.ok(folder.startsWith(path.join(os.tmpdir(), 'apitu-roadmap-test-')));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}
const invoke = (args, extra = {}) => spawnSync(process.execPath, [renderer, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, APITU_NO_CLOBBER: '1', APITU_DIAGNOSTIC_FORMAT: 'json' }, ...extra });
const expectDiagnostic = (fn, code) => assert.throws(fn, error => error.apituDiagnostics?.some(item => item.code === code));

// These two baseline hashes were independently captured from the installed
// api-sheji template on 2026-10-08; tests do not need that skill at runtime.
test('bundled stylesheet and interaction script preserve exact api-sheji bytes', () => {
  const template = fs.readFileSync(ROADMAP_TEMPLATE, 'utf8');
  assert.equal(sha(template.match(/<style>[\s\S]*?<\/style>/)[0]), 'b9c45ea1d285716f8b2e67efa6543e3fcb4f1be3d0d123aab048e49535d1c8ac');
  assert.equal(sha(template.match(/<script>[\s\S]*?<\/script>/)[0]), '4a86f111ce1b299bbf4b8fa06a61476f6484c603a272cc52ca7ed4280286f4d9');
  const html = compileRoadmap(fixture()).html;
  assert.equal(html.match(/<style>[\s\S]*?<\/style>/)[0], template.match(/<style>[\s\S]*?<\/style>/)[0]);
  const normalized = html.match(/<script>[\s\S]*?<\/script>/)[0].replace(/const FLOW = .*?;/, 'const FLOW = __APITU_FLOW__;').replace(/const API = .*?;/, 'const API = __APITU_API__;');
  assert.equal(sha(normalized), '4a86f111ce1b299bbf4b8fa06a61476f6484c603a272cc52ca7ed4280286f4d9');
  assert.ok(!/<(?:script|img|iframe|link)\b[^>]*(?:src|href)=["']https?:\/\//i.test(html));
  assert.ok(!/@import|url\(["']?https?:\/\//i.test(html.match(/<style>[\s\S]*?<\/style>/)[0]));
});

test('example has full sections, derived numbering, independent maps and route semantics', () => {
  const data = fixture();
  const { html, layout } = compileRoadmap(data);
  assert.equal(layout.qualityProfile, 'roadmap-v1');
  assert.equal(layout.nodes.length, 16);
  assert.equal(layout.edges.length, 14);
  for (const section of ['flow', 'api', 'rules', 'consume', 'pages', 'bounds']) assert.match(html, new RegExp(`id="${section}"`));
  assert.match(html, /route manual jade/);
  assert.match(html, /class="route gap"/);
  const api = html.match(/<svg[^>]*id="api-map"[\s\S]*?<\/svg>/)[0];
  assert.ok(!/route (?:manual|gap)/.test(api));
  assert.match(api, /class="route gold"/);
  assert.match(api, /class="route jade"/);
  assert.match(api, /class="route coral"/);
  for (const [map, prefix] of [['flow', 'F'], ['api', 'A']]) {
    const nodes = layout.nodes.filter(node => node.map === map);
    nodes.forEach((node, index) => {
      assert.equal(node.badge, `${prefix}${index + 1}`);
      assert.match(html, new RegExp(`data-node-id="${node.id}"`));
      assert.match(html, new RegExp(`<text class="num" x="-20" y="4">${node.badge}</text>`));
      assert.match(html, new RegExp(`<span><b>${node.badge}</b> `));
      assert.ok(node.bounds.x >= 16 && node.bounds.x + node.width <= 1164);
      assert.ok(node.bounds.y >= 16 && node.bounds.y + node.height <= layout.viewBoxes[map][3] - 16);
    });
  }
  for (const edge of layout.edges) {
    assert.ok(layout.nodes.some(node => node.id === edge.from));
    assert.ok(layout.nodes.some(node => node.id === edge.to));
    assert.match(html, new RegExp(`data-edge-id="${edge.id}"`));
  }
});

test('automatic coordinates and obstacle avoidance need no authored geometry', () => {
  const data = fixture();
  for (const map of ['flow', 'api']) {
    assert.ok(data[map].stations.every(station => station.x === undefined && station.y === undefined));
    assert.ok(data[map].routes.every(route => route.curve === undefined));
  }
  const first = compileRoadmap(data), second = compileRoadmap(data);
  assert.equal(first.html, second.html);
  assert.deepEqual(first.layout, second.layout);
  assert.notEqual(first.layout.edges.find(edge => edge.id === 'api:r2').path, 'M 73 60 C 450.334 60, 450.334 60, 827.667 60');
});

test('automatic layout supports all 24 numbered stations with short labels', () => {
  const data = fixture();
  for (const name of ['flow', 'api']) {
    data[name].stations = Array.from({ length: 24 }, (_, index) => ({ id: `node${index + 1}`, label: `站点 ${index + 1}`, subtitle: '短副标题', description: '节点详情', kind: 'auto' }));
    data[name].routes = Array.from({ length: 23 }, (_, index) => ({ from: `node${index + 1}`, to: `node${index + 2}`, kind: 'auto', color: 'gold' }));
  }
  const { layout, html } = compileRoadmap(data);
  assert.equal(layout.nodes.length, 48);
  assert.equal(layout.edges.length, 46);
  assert.match(html, /<text class="num" x="-20" y="4">F24<\/text>/);
  assert.match(html, /<text class="num" x="-20" y="4">A24<\/text>/);
});

test('wide Latin and mixed-language text selects safe automatic columns rather than rejecting input', () => {
  const data = fixture();
  for (const name of ['flow', 'api']) {
    data[name].stations = Array.from({ length: 4 }, (_, index) => ({ id: `wide${index + 1}`, label: `${'W'.repeat(20)}混合 M${index}`, subtitle: 'W'.repeat(64), description: '长 Latin 副标题保持完整', kind: 'auto' }));
    data[name].routes = Array.from({ length: 3 }, (_, index) => ({ from: `wide${index + 1}`, to: `wide${index + 2}`, kind: 'auto', color: 'gold', label: `${'W'.repeat(12)}混合` }));
  }
  const { layout } = compileRoadmap(data);
  assert.equal(layout.nodes.length, 8);
  for (const node of layout.nodes) {
    assert.equal(node.x, 73);
    assert.ok(node.width >= 721);
    assert.ok(node.bounds.x + node.width <= 1164);
  }
  for (const edge of layout.edges) assert.ok(edge.labelBounds.width >= 150);
});

test('structural schema refuses unknown fields, malformed arrays, duplicates and references', () => {
  const cases = [
    [data => { data.meta.unknown = 'no'; }, 'schema/additionalProperties'],
    [data => { data.flow.stations[0].id = data.flow.stations[1].id; }, 'schema/duplicate-id'],
    [data => { data.api.routes[0].to = 'missing'; }, 'schema/reference'],
    [data => { data.api.routes[0].from = data.api.routes[0].to; }, 'schema/self-route'],
    [data => { data.flow.routes.push(data.flow.routes[0]); }, 'schema/duplicate-route'],
    [data => { data.api.routes[0].kind = 'manual'; }, 'schema/const'],
    [data => { data.api.routes[0].kind = 'gap'; }, 'schema/const'],
    [data => { data.flow.routes[0].color = 'gold'; }, 'schema/manual-color'],
    [data => { data.meta.checked_at = '2026-02-30'; }, 'schema/date'],
    [data => { data.meta.title = ' '; }, 'schema/minLength'],
    [data => { data.flow.stations[0].label = '字'.repeat(41); }, 'schema/maxLength'],
    [data => { data.flow.stations[0].x = 100; }, 'schema/coordinate-pair'],
    [data => { data.api.routes[0].api_group = 'all'; }, 'schema/reserved-id'],
    [data => { data.flow.routes[0].curve = ['alert(1)', 20, 40, 60]; }, 'schema/type'],
    [data => { data.flow.routes[0].curve = [20, 20, Infinity, 60]; }, 'schema/type'],
    [data => { data.flow.routes[0].curve = [20, 20, 40]; }, 'schema/minItems'],
    [data => { data.flow.stations[0].x = NaN; data.flow.stations[0].y = 40; }, 'schema/type'],
    [data => { data.flow.stations[0].api_group = 'query'; }, 'schema/map-field'],
  ];
  for (const [mutate, code] of cases) { const data = fixture(); mutate(data); expectDiagnostic(() => validateRoadmapSchema(data), code); }
});

test('layout refuses clipped titles/subtitles, overlapping stations and labels, out-of-map curves', () => {
  const cases = [
    [data => { data.flow.stations[0].x = 1090; data.flow.stations[0].y = 100; data.flow.stations[0].label = '标题不得被静默裁剪'; }, 'roadmap/station-outside'],
    [data => { data.flow.stations[0].x = 1090; data.flow.stations[0].y = 100; data.flow.stations[0].subtitle = '副标题也不得被静默裁剪'; }, 'roadmap/station-outside'],
    [data => { data.flow.stations[0].x = 850; data.flow.stations[0].y = 100; data.flow.stations[0].label = 'W'.repeat(40); }, 'roadmap/station-outside'],
    [data => { data.flow.stations[1].x = 73; data.flow.stations[1].y = 60; }, 'roadmap/station-overlap'],
    [data => { data.flow.routes[0].label_position = [73, 60]; }, 'roadmap/label-collision'],
    [data => { data.flow.routes[0].curve = [100, 900, 200, 900]; }, 'roadmap/curve-outside'],
    [data => { data.api.routes[1].curve = [325, 60, 576, 60]; }, 'roadmap/route-station-collision'],
  ];
  for (const [mutate, code] of cases) { const data = fixture(); mutate(data); expectDiagnostic(() => compileRoadmap(data), code); }
});

test('station dictionaries cannot inject HTML, close scripts or recursively replace placeholders', () => {
  const data = fixture();
  data.meta.title = '__APITU_FLOW__';
  data.flow.stations[0].label = '<img src=x onerror=evil()>';
  data.flow.stations[0].description = '</script><img src=x onerror=evil()> & " \' __APITU_API__ \u2028';
  const html = compileRoadmap(data).html;
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(!html.includes('<img'));
  assert.match(html, /<title>__APITU_FLOW__功能与 API 路线图<\/title>/);
  const dictionaryPart = script(html).split('    const flowHint')[0];
  const dictionaries = vm.runInNewContext(dictionaryPart + '\n({FLOW, API})');
  assert.equal(dictionaries.FLOW.request.title, 'F1 &lt;img src=x onerror=evil()&gt;');
  assert.ok(dictionaries.FLOW.request.body.includes('&lt;/script&gt;&lt;img'));
  assert.ok(dictionaries.FLOW.request.body.includes('__APITU_API__'));
  assert.ok(!dictionaries.FLOW.request.body.includes('<img'));
});

test('original station handlers expose escaped detail in hints', () => {
  const data = fixture();
  data.flow.stations[0].description = '<img onerror=evil()> detail';
  const html = compileRoadmap(data).html;
  const hints = { 'flow-hint': { innerHTML: '' }, 'api-hint': { innerHTML: '' } };
  const clickable = {};
  const maps = {};
  for (const name of ['flow', 'api']) {
    const station = { dataset: { key: data[name].stations[0].id }, classList: { remove() {}, add() {} }, addEventListener(event, callback) { clickable[name] = callback; } };
    const layer = { setAttribute() {} };
    const viewport = { addEventListener() {} };
    maps[`${name}-map`] = { id: `${name}-map`, querySelectorAll(selector) { return selector === '.station' ? [station] : []; }, querySelector() { return layer; }, closest() { return viewport; } };
  }
  const document = { getElementById(id) { return maps[id] || hints[id]; }, querySelector() { return { textContent: '', addEventListener() {} }; }, querySelectorAll() { return []; } };
  vm.runInNewContext(script(html), { document });
  clickable.flow(); clickable.api();
  assert.match(hints['flow-hint'].innerHTML, /^<b>F1 会话请求<\/b> · &lt;img onerror=evil\(\)&gt; detail$/);
  assert.match(hints['api-hint'].innerHTML, /^<b>A1 绑定会话<\/b> · /);
});

test('renderer inspection modes return truthful JSON without publishing HTML', t => {
  const folder = tmp(t), output = path.join(folder, 'must-not-exist.html');
  for (const flag of ['--layout-json', '--validate-only', '--diagnostics-json']) {
    const result = invoke([input, output, flag]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.qualityProfile, 'roadmap-v1');
    if (flag === '--layout-json') assert.equal(json.nodes.length, 16);
    assert.ok(!fs.existsSync(output));
  }
  const bad = invoke([input, output, '--bogus']);
  assert.equal(bad.status, 1);
  assert.ok(JSON.parse(bad.stderr).diagnostics.some(item => item.code === 'cli/arguments'));
});

test('renderer schema failures carry structured diagnostics and leave no artifact', t => {
  const folder = tmp(t), badInput = path.join(folder, 'invalid.json'), output = path.join(folder, 'absent.html');
  const data = fixture(); data.api.routes[0].kind = 'gap';
  fs.writeFileSync(badInput, JSON.stringify(data));
  const result = invoke([badInput, output]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stderr);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(item => item.code === 'schema/const'));
  assert.ok(!fs.existsSync(output));
});

test('standalone publication shares atomic no-overwrite and input-alias protections', t => {
  const folder = tmp(t), output = path.join(folder, 'roadmap.html');
  const first = invoke([input, output]);
  assert.equal(first.status, 0, first.stderr);
  const bytes = fs.readFileSync(output);
  assert.match(bytes.toString(), /name="apitu-diagram-type" content="roadmap"/);
  const second = invoke([input, output]);
  assert.equal(second.status, 1);
  assert.deepEqual(fs.readFileSync(output), bytes);
  const alias = path.join(folder, 'input.html');
  const authored = JSON.stringify(fixture()); fs.writeFileSync(alias, authored);
  const refusal = invoke([alias, alias]);
  assert.equal(refusal.status, 1);
  assert.equal(fs.readFileSync(alias, 'utf8'), authored);
  assert.ok(JSON.parse(refusal.stderr).diagnostics.some(item => item.code.startsWith('output/')));
});
