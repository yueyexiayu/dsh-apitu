import fs from 'node:fs';
import { throwDiagnosticError } from '../shared/diagnostics.mjs';
import { validateAuthoredOutputPath } from '../shared/output-path.mjs';

// The bundled JSON schema is the single structural contract. This bounded,
// dependency-free evaluator implements only the keywords used by that schema.
const schema = JSON.parse(fs.readFileSync(new URL('../../schemas/roadmap.schema.json', import.meta.url), 'utf8'));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

export function validateRoadmapSchema(data) {
  const diagnostics = [];
  function problem(path, keyword, message, expected) {
    diagnostics.push({
      code: `schema/${keyword}`, severity: 'error',
      message: `${path || '/'} ${message}`,
      subject: { diagramType: 'roadmap', path: path || '/' },
      evidence: { keyword, expected },
      supportedFixes: ['Use the bundled roadmap schema; remove unsupported fields and repair the named value.'],
    });
  }
  function walk(rule, value, at) {
    if (rule.$ref) {
      const target = rule.$ref.split('/').slice(1).reduce((node, key) => node[key], schema);
      if (!target) throw new Error(`Unsupported bundled roadmap schema reference ${rule.$ref}`);
      walk(target, value, at);
    }
    for (const item of rule.allOf || []) walk(item, value, at);
    if (own(rule, 'const') && value !== rule.const) problem(at, 'const', `must equal ${JSON.stringify(rule.const)}`, rule.const);
    if (rule.enum && !rule.enum.includes(value)) problem(at, 'enum', `must be one of ${JSON.stringify(rule.enum)}`, rule.enum);
    if (rule.type) {
      const valid = rule.type === 'object' ? object(value)
        : rule.type === 'array' ? Array.isArray(value)
        : rule.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === rule.type;
      if (!valid) { problem(at, 'type', `must be ${rule.type}${rule.type === 'number' ? ' and finite' : ''}`, rule.type); return; }
    }
    if (typeof value === 'string') {
      const length = Array.from(value).length;
      if (rule.minLength !== undefined && (length < rule.minLength || !value.trim())) problem(at, 'minLength', 'must not be empty or whitespace-only', rule.minLength);
      if (rule.maxLength !== undefined && length > rule.maxLength) problem(at, 'maxLength', `must contain at most ${rule.maxLength} characters`, rule.maxLength);
      if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value)) problem(at, 'pattern', `must match ${rule.pattern}`, rule.pattern);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) problem(at, 'text', 'must not contain control characters', 'printable text');
    }
    if (typeof value === 'number') {
      if (rule.minimum !== undefined && value < rule.minimum) problem(at, 'minimum', `must be >= ${rule.minimum}`, rule.minimum);
      if (rule.maximum !== undefined && value > rule.maximum) problem(at, 'maximum', `must be <= ${rule.maximum}`, rule.maximum);
    }
    if (Array.isArray(value)) {
      if (rule.minItems !== undefined && value.length < rule.minItems) problem(at, 'minItems', `must have at least ${rule.minItems} items`, rule.minItems);
      if (rule.maxItems !== undefined && value.length > rule.maxItems) problem(at, 'maxItems', `must have at most ${rule.maxItems} items`, rule.maxItems);
      if (rule.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) problem(at, 'uniqueItems', 'must contain unique items', true);
      if (rule.items) value.forEach((item, index) => walk(rule.items, item, `${at}/${index}`));
    }
    if (object(value)) {
      for (const key of rule.required || []) if (!own(value, key)) problem(at, 'required', `requires property ${key}`, key);
      if (rule.additionalProperties === false) for (const key of Object.keys(value)) {
        if (!own(rule.properties || {}, key)) problem(`${at}/${pointer(key)}`, 'additionalProperties', 'is not a supported property', key);
      }
      for (const [key, child] of Object.entries(rule.properties || {})) if (own(value, key)) walk(child, value[key], `${at}/${pointer(key)}`);
    }
  }
  walk(schema, data, '');
  if (diagnostics.length) throwDiagnosticError('roadmap schema validation failed:\n' + diagnostics.map(item => `- ${item.message}`).join('\n'), diagnostics);
  if (data.meta.output !== undefined) validateAuthoredOutputPath(data.meta.output);
  const date = new Date(`${data.meta.checked_at}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== data.meta.checked_at) {
    problem('/meta/checked_at', 'date', 'must be a real calendar date', 'YYYY-MM-DD');
  }
  for (const map of ['flow', 'api']) {
    const ids = new Set();
    data[map].stations.forEach((station, index) => {
      if (ids.has(station.id)) problem(`/${map}/stations/${index}/id`, 'duplicate-id', 'must be unique within its map', station.id);
      ids.add(station.id);
      if ((station.x === undefined) !== (station.y === undefined)) problem(`/${map}/stations/${index}`, 'coordinate-pair', 'must supply both x and y, or omit both for automatic layout', 'x and y together');
      if (map === 'flow' && station.api_group !== undefined) problem(`/${map}/stations/${index}/api_group`, 'map-field', 'is only supported in the API map', 'api');
      if (station.api_group === 'all') problem(`/${map}/stations/${index}/api_group`, 'reserved-id', 'must not use the reserved all filter key', 'a distinct group id');
    });
    const routes = new Set();
    data[map].routes.forEach((route, index) => {
      for (const end of ['from', 'to']) if (!ids.has(route[end])) problem(`/${map}/routes/${index}/${end}`, 'reference', 'must reference a station in this map', route[end]);
      if (route.from === route.to) problem(`/${map}/routes/${index}`, 'self-route', 'must connect two distinct stations', 'distinct endpoints');
      const signature = `${route.from}:${route.to}:${route.kind}:${route.api_group || ''}`;
      if (routes.has(signature)) problem(`/${map}/routes/${index}`, 'duplicate-route', 'duplicates an existing route', signature);
      routes.add(signature);
      if (map === 'flow' && route.api_group !== undefined) problem(`/${map}/routes/${index}/api_group`, 'map-field', 'is only supported in the API map', 'api');
      if (route.api_group === 'all') problem(`/${map}/routes/${index}/api_group`, 'reserved-id', 'must not use the reserved all filter key', 'a distinct group id');
      if (map === 'flow' && route.kind === 'manual' && route.color !== 'jade') problem(`/${map}/routes/${index}/color`, 'manual-color', 'manual routes must be jade', 'jade');
      if (route.label_position !== undefined && route.label === undefined) problem(`/${map}/routes/${index}/label_position`, 'label-required', 'requires a route label', 'label');
    });
  }
  if (diagnostics.length) throwDiagnosticError('roadmap contract validation failed:\n' + diagnostics.map(item => `- ${item.message}`).join('\n'), diagnostics);
  return true;
}
