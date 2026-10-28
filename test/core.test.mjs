import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { findChrome } from '../vendor/core/bin/visual-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor/core');
const cli = path.join(root, 'bin/apitu.mjs');
// Each run owns a fresh directory. Keep all artifacts for GUI/manual review;
// never remove artifacts belonging to this run or to another agent/user.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apitu-core-test-')));
const chrome = findChrome();
const fixtures = {
  architecture: 'web-app.architecture.json',
  workflow: 'agent-tool-call.workflow.json',
  sequence: 'cache-miss-request.sequence.json',
  dataflow: 'product-analytics.dataflow.json',
  lifecycle: 'agent-run.lifecycle.json',
};
const example = name => path.join(root, 'examples', name);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = path.join(prefix, entry.name);
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? inventory(file, relative) : [[relative, hash(file)]];
    });
}
const vendorBefore = inventory(root);
function run(args, options = {}) {
  const result = spawnSync(process.execPath, [options.cli || cli, ...args], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      ...(chrome ? { APITU_CHROME: chrome } : {}),
      ...options.env,
    },
  });
  assert.equal(result.error, undefined, `Process failed: ${result.error?.message}`);
  assert.equal(result.signal, null, `Process terminated by ${result.signal}`);
  return result;
}
function succeeds(args, options) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result;
}
function json(args, options) {
  return JSON.parse(succeeds(args, options).stdout);
}
function assertHtml(file) {
  assert.ok(fs.statSync(file).size > 10_000, 'A complete portable viewer must be emitted');
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<svg\b/i);
  assert.match(html, /export-menu/);
}

after(() => {
  assert.deepEqual(inventory(root), vendorBefore, 'Regression suite must not mutate the vendored runtime');
  console.log(`APITU_CORE_ARTIFACTS=${scratch}`);
  console.log(`APITU_GUI_HTML=${path.join(scratch, 'finalized.html')}`);
});

test('complete staged runtime passes doctor and publishes all five CLI types', () => {
  for (const resource of ['bin/apitu.mjs', 'SKILL.md', 'assets/template.html', ...Object.keys(fixtures).map(type => `schemas/${type}.schema.json`), ...Object.values(fixtures).map(file => `examples/${file}`)]) {
    assert.ok(fs.statSync(path.join(root, resource)).isFile(), `Missing runtime resource: ${resource}`);
  }
  assert.match(succeeds(['doctor']).stdout, /apitu is ready\./);
  const help = succeeds(['--help']).stdout;
  for (const type of Object.keys(fixtures)) assert.ok(help.includes(type));
  for (const command of ['compare', 'finalize', 'browser-check', 'visual-check', 'migrate', 'preview']) {
    assert.ok(help.includes(command));
  }
});

for (const [type, fixture] of Object.entries(fixtures)) {
  test(`${type}: validate, render, inspect, deliver and provenance check`, () => {
    const input = example(fixture);
    const validated = json(['validate', type, input, '--json']);
    assert.equal(validated.ok, true);
    const rendered = path.join(scratch, `${type}.rendered.html`);
    succeeds(['render', type, input, rendered]);
    assertHtml(rendered);
    assert.equal(json(['check', rendered, '--json']).ok, true);
    if (type === 'architecture') {
      assert.ok(succeeds(['inspect', type, input]).stdout.length > 0);
    } else {
      // The bundled help accepts a type position, but inspect only implements architecture.
      const inspected = run(['inspect', type, input]);
      assert.equal(inspected.status, 2);
      assert.match(inspected.stderr, /supported for architecture and roadmap diagrams only/);
    }
    const output = path.join(scratch, `${type}.html`);
    const receipt = json(['deliver', type, input, output, '--json']);
    assert.equal(receipt.ok, true);
    assertHtml(output);
    assert.equal(json(['check', output, '--json', '--require-provenance']).ok, true);
    const proof = JSON.parse(fs.readFileSync(output.replace(/\.html$/, '.delivery.json'), 'utf8'));
    assert.equal(proof.artifact.sha256, hash(output));
  });
}

test('architecture comparison emits complete authored delta and receipt', () => {
  const output = path.join(scratch, 'architecture-delta.html');
  const receiptPath = path.join(scratch, 'architecture-delta.receipt.json');
  const receipt = json(['compare', 'architecture', example('checkout-platform.base.architecture.json'),
    example('checkout-platform.head.architecture.json'), output, '--receipt', receiptPath, '--json']);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.command, 'compare');
  assert.equal(receipt.completeness, 'complete');
  assert.ok(receipt.changes.components.length > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), receipt);
  assertHtml(output);
});

test('guide supports structured recommendations and Chinese output; brands search is offline', () => {
  const guide = json(['guide', 'Show an API request with Redis cache miss', '--json']);
  assert.equal(guide.ok, true);
  assert.equal(guide.recommendation.type, 'sequence');
  assert.match(succeeds(['guide', '展示 Kafka topic 消费者组和死信队列']).stdout, /推荐/);
  const brands = json(['brands', 'redis', '--json']);
  assert.match(JSON.stringify(brands), /redis/i);
});

test('examples renders all five examples in an isolated copied installation', () => {
  // The examples command writes into its own installation; never run it on vendor.
  const copied = path.join(scratch, 'examples-installation');
  fs.cpSync(root, copied, { recursive: true, errorOnExist: true, force: false });
  succeeds(['examples'], { cli: path.join(copied, 'bin/apitu.mjs') });
  for (const file of ['web-app-rendered.html', 'workflow-agent-tool-call-rendered.html',
    'sequence-cache-miss-request.html', 'dataflow-product-analytics.html', 'lifecycle-agent-run.html']) {
    assertHtml(path.join(copied, 'examples', file));
  }
});

test('malformed JSON, schema failures, unknown types and unknown commands fail visibly', () => {
  const broken = path.join(scratch, 'broken.json');
  fs.writeFileSync(broken, '{ definitely not json');
  const invalid = path.join(scratch, 'invalid.json');
  fs.writeFileSync(invalid, JSON.stringify({ schema_version: 1, diagram_type: 'architecture' }));
  for (const input of [broken, invalid]) {
    const result = run(['validate', 'architecture', input, '--json']);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
  const unknownType = run(['validate', 'unknown', example(fixtures.architecture), '--json']);
  assert.notEqual(unknownType.status, 0);
  assert.equal(JSON.parse(unknownType.stdout).ok, false);
  const unknownCommand = run(['not-an-apitu-command']);
  assert.notEqual(unknownCommand.status, 0);
  assert.match(unknownCommand.stderr + unknownCommand.stdout, /unknown|usage/i);
});

test('missing Chrome is an explicit non-success rather than a fabricated browser pass', () => {
  const file = path.join(scratch, 'no-browser.html');
  succeeds(['deliver', 'architecture', example(fixtures.architecture), file, '--json']);
  const result = run(['browser-check', file, '--json'], { env: { APITU_CHROME: path.join(scratch, 'missing-chrome') } });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.browserUnavailable, true);
  assert.equal(receipt.chrome.status, 'unavailable');
  assert.match(receipt.error, /APITU_CHROME/);
  assert.match(receipt.containment.reason, /not executed/);
  assert.deepEqual(receipt.containment.viewports, []);
});

test('real Chrome finalize and browser/visual checks retain verified GUI artifact', {
  skip: chrome ? false : 'Chrome/Chromium unavailable: real-browser coverage NOT verified',
}, () => {
  const output = path.join(scratch, 'finalized.html');
  const receipt = json(['finalize', 'architecture', example(fixtures.architecture), output, '--quality', 'showcase', '--json']);
  assert.deepEqual(receipt.gates, { validate: 'pass', deliver: 'pass', check: 'pass', 'browser-check': 'pass' });
  assert.equal(receipt.visualReview, 'not-requested');
  assertHtml(output);
  const browser = json(['browser-check', output, '--json', '--require-provenance']);
  assert.equal(browser.status, 'pass');
  assert.equal(browser.containment.viewports.length, 4);
  assert.equal(browser.themeStates.viewports.length, 6);
  const visual = json(['visual-check', output, '--json', '--require-provenance']);
  assert.equal(visual.status, 'pass');
  assert.ok(visual.captures.screenshots.length >= 4);
  // Automated evidence is not a substitute for the lead's actual visual review.
  assert.equal(json(['check', output, '--json', '--require-provenance']).ok, true);
  fs.writeFileSync(path.join(scratch, 'regression-evidence.json'), JSON.stringify({ receipt, browser, visual }, null, 2));
});
