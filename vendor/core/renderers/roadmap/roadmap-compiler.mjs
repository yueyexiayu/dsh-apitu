import fs from 'node:fs';
import { esc, textUnits } from '../shared/utils.mjs';
import { throwDiagnosticProblems } from '../shared/diagnostics.mjs';
import { validateRoadmapSchema } from './schema.mjs';

export { validateRoadmapSchema } from './schema.mjs';
export const ROADMAP_TEMPLATE = new URL('../../assets/roadmap-template.html', import.meta.url);
export const ROADMAP_VIEWBOXES = Object.freeze({ flow: [0, 0, 1180, 620], api: [0, 0, 1180, 560] });
const COLORS = { source: '#d6b15a', pipeline: '#7ed0b6', hub: '#f0d48a', consume: '#d06545', extra: '#6aa7c8', secondary: '#3f8f78' };
const RADII = { source: 8, pipeline: 8, hub: 10, consume: 7, extra: 8, secondary: 6 };
const LABEL_COLORS = { gold: '#f0d48a', jade: '#7ed0b6', coral: '#d06545', gap: '#9a8674' };
const overlap = (a, b, gap = 4) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
const contained = (box, height) => box.x >= 16 && box.y >= 16 && box.x + box.width <= 1164 && box.y + box.height <= height - 16;
const cleanNumber = value => Number(value.toFixed(3));
// Conservative widths account for wide Latin glyphs as well as full-width
// text. A flat ASCII average would silently clip labels such as forty Ws.
function textWidth(text, fontSize) {
  return Array.from(text).reduce((width, character) => {
    const units = textUnits(character);
    if (!units) return width;
    const factor = character.codePointAt(0) > 127 ? Math.max(1.1, units * 0.55)
      : /[MW@%&]/.test(character) ? 1.05 : /[A-Zmw]/.test(character) ? 0.9 : 0.65;
    return width + fontSize * factor;
  }, 0);
}
const nodeWidth = (station, badge) => 49 + Math.max(textWidth(`${badge} ${station.label}`, 12), textWidth(station.subtitle, 10));
const scriptJSON = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function curvePoint(route, t) {
  const u = 1 - t;
  return {
    x: u ** 3 * route.start.x + 3 * u ** 2 * t * route.curve[0] + 3 * u * t ** 2 * route.curve[2] + t ** 3 * route.end.x,
    y: u ** 3 * route.start.y + 3 * u ** 2 * t * route.curve[1] + 3 * u * t ** 2 * route.curve[3] + t ** 3 * route.end.y,
  };
}

function segmentHitsBox(a, b, box, margin = 3) {
  const min = [box.x - margin, box.y - margin];
  const max = [box.x + box.width + margin, box.y + box.height + margin];
  let low = 0, high = 1;
  for (const [index, key] of ['x', 'y'].entries()) {
    const delta = b[key] - a[key];
    if (Math.abs(delta) < 1e-9) { if (a[key] < min[index] || a[key] > max[index]) return false; continue; }
    const first = (min[index] - a[key]) / delta, second = (max[index] - a[key]) / delta;
    low = Math.max(low, Math.min(first, second)); high = Math.min(high, Math.max(first, second));
    if (low > high) return false;
  }
  return true;
}
const routeHitsBox = (route, box) => route.samples.some((point, index) => index && segmentHitsBox(route.samples[index - 1], point, box));

function compileMap(mapName, input) {
  const height = ROADMAP_VIEWBOXES[mapName][3];
  const prefix = mapName === 'flow' ? 'F' : 'A';
  const problems = [], details = [];
  function fail(code, message, at) {
    problems.push(message);
    details.push({ code: `roadmap/${code}`, severity: 'error', message, subject: { diagramType: 'roadmap', map: mapName, path: `/${mapName}/${at}` }, supportedFixes: ['Omit x/y for automatic placement, shorten labels, or adjust the named geometry to leave clear space.'] });
  }
  const maxWidth = Math.max(...input.stations.map((station, index) => nodeWidth(station, `${prefix}${index + 1}`)));
  const columns = Math.max(1, Math.min(3, Math.floor((1100 + 32) / (maxWidth + 32))));
  const rows = Math.ceil(input.stations.length / columns);
  const pitchY = rows === 1 ? 0 : (height - 120) / (rows - 1);
  if (pitchY && pitchY < 60 && input.stations.some(station => station.x === undefined)) fail('layout-capacity', `${mapName}: labels require ${rows} rows with less than 60px spacing; reduce station count or shorten labels.`, 'stations');
  const pitchX = (1100 + 32) / columns;
  const stations = input.stations.map((authored, index) => {
    const row = Math.floor(index / columns);
    const col = row % 2 ? columns - 1 - index % columns : index % columns;
    const badge = `${prefix}${index + 1}`;
    const x = authored.x ?? cleanNumber(40 + col * pitchX + 33);
    const y = authored.y ?? cleanNumber(rows === 1 ? height / 2 : 60 + row * pitchY);
    const bounds = { x: x - 33, y: y - 21, width: nodeWidth(authored, badge), height: 42 };
    const station = { ...authored, x, y, badge, bounds, role: authored.role || (authored.kind === 'manual' ? 'extra' : 'pipeline') };
    if (!contained(bounds, height)) fail('station-outside', `${mapName} ${badge} (${authored.id}): station title/subtitle or badge lies outside the map.`, `stations/${index}`);
    return station;
  });
  for (let i = 0; i < stations.length; i++) for (let j = i + 1; j < stations.length; j++) {
    if (overlap(stations[i].bounds, stations[j].bounds, 10)) fail('station-overlap', `${mapName} ${stations[i].badge}/${stations[j].badge}: station labels overlap.`, `stations/${j}`);
  }
  const byId = new Map(stations.map(station => [station.id, station]));
  const routes = input.routes.map((authored, index) => {
    const start = byId.get(authored.from), end = byId.get(authored.to);
    const middleX = (start.x + end.x) / 2;
    const defaultCurve = [middleX, start.y, middleX, end.y];
    const candidates = authored.curve ? [authored.curve] : [defaultCurve, ...[-80, 80, -140, 140, -220, 220].map(offset => [(2 * start.x + end.x) / 3, start.y + offset, (start.x + 2 * end.x) / 3, end.y + offset]), ...[-120, 120, -240, 240, -400, 400].map(offset => [start.x + offset, (2 * start.y + end.y) / 3, end.x + offset, (start.y + 2 * end.y) / 3])];
    const curveInside = curve => curve.every((value, component) => value >= 16 && value <= (component % 2 ? height - 16 : 1164));
    const unrelated = stations.filter(station => station.id !== authored.from && station.id !== authored.to);
    const route = { ...authored, id: `${mapName}:r${index + 1}`, start, end, curve: authored.curve || defaultCurve };
    for (const candidate of candidates) {
      if (!curveInside(candidate)) continue;
      const probe = { ...route, curve: candidate };
      probe.samples = Array.from({ length: 81 }, (_, step) => curvePoint(probe, step / 80));
      if (unrelated.some(station => routeHitsBox(probe, station.bounds))) continue;
      route.curve = candidate;
      break;
    }
    if (!curveInside(route.curve)) fail('curve-outside', `${mapName} route ${index + 1}: cubic control points must stay inside the map.`, `routes/${index}/curve`);
    route.curve = route.curve.map(cleanNumber);
    route.path = `M ${start.x} ${start.y} C ${route.curve[0]} ${route.curve[1]}, ${route.curve[2]} ${route.curve[3]}, ${end.x} ${end.y}`;
    route.samples = Array.from({ length: 81 }, (_, step) => curvePoint(route, step / 80));
    for (const station of stations) {
      if (station.id !== authored.from && station.id !== authored.to && routeHitsBox(route, station.bounds)) fail('route-station-collision', `${mapName} route ${index + 1}: route crosses unrelated ${station.badge} (${station.id}) text or node.`, `routes/${index}`);
    }
    return route;
  });
  const labelBounds = [];
  for (const [index, route] of routes.entries()) {
    if (!route.label) continue;
    const width = Math.max(12, textWidth(route.label, 11));
    const middle = curvePoint(route, 0.5);
    const candidates = route.label_position ? [route.label_position] : [
      ...[-20, -40, 28, 48, -64, 72].map(offset => [middle.x, middle.y + offset]),
      ...[width / 2 + 20, -(width / 2 + 20), width + 40, -(width + 40)].flatMap(offset => [0, -20, 28].map(yOffset => [middle.x + offset, middle.y + yOffset])),
    ];
    for (const [x, y] of candidates) {
      const bounds = { x: x - width / 2, y: y - 12, width, height: 16 };
      if (!contained(bounds, height) || stations.some(station => overlap(station.bounds, bounds)) || labelBounds.some(other => overlap(other, bounds)) || routes.some(other => routeHitsBox(other, bounds))) continue;
      route.labelPosition = [cleanNumber(x), cleanNumber(y)];
      route.labelBounds = bounds;
      labelBounds.push(bounds);
      break;
    }
    if (!route.labelPosition) fail('label-collision', `${mapName} route ${index + 1}: label overlaps a station/route/label or lies outside the map.`, `routes/${index}/label_position`);
  }
  if (problems.length) throwDiagnosticProblems('roadmap layout validation failed', problems, { diagnostics: details });
  return { name: mapName, title: input.title, stations, routes };
}

function renderMap(map) {
  const name = map.name;
  const flow = name === 'flow';
  const groups = [...new Set(map.routes.map(route => route.api_group).filter(Boolean))];
  const actions = flow
    ? '<button type="button" class="active" data-line="all">全部路线</button><button type="button" data-kind="auto">只看自动（流动）</button><button type="button" data-kind="manual">只看手动（静止）</button><button type="button" data-kind="gap">只看卡住点</button>'
    : '<button type="button" class="active" data-api="all">全部接口</button>' + groups.map(group => `<button type="button" data-api="${esc(group)}">${esc(group)}</button>`).join('');
  const paths = map.routes.map(route => {
    const classes = flow ? `route ${route.kind}${route.kind === 'gap' ? '' : ` ${route.color}`}` : `route ${route.color}`;
    const filter = flow ? `data-kind="${route.kind}" data-line="${route.kind}"` : `data-api="${esc(route.api_group || 'all')}"`;
    return `<path class="${classes}" ${filter} data-edge-id="${route.id}" data-edge-from="${name}:${esc(route.from)}" data-edge-to="${name}:${esc(route.to)}" d="${route.path}" />`;
  }).join('\n');
  const labels = map.routes.filter(route => route.label).map(route => `<text x="${route.labelPosition[0]}" y="${route.labelPosition[1]}" text-anchor="middle" fill="${LABEL_COLORS[route.kind === 'gap' ? 'gap' : route.color]}" font-size="11" font-family="PingFang SC, sans-serif">${esc(route.label)}</text>`).join('\n');
  const stations = map.stations.map(station => `<g class="station" data-key="${esc(station.id)}" data-node-id="${name}:${esc(station.id)}"${flow ? '' : ` data-api="${esc(station.api_group || 'all')}"`} transform="translate(${station.x},${station.y})">
<circle class="num-bg" cx="-20" cy="0" r="11" /><text class="num" x="-20" y="4">${station.badge}</text><circle class="node" r="${RADII[station.role]}" fill="${COLORS[station.role]}" /><text x="16" y="-6">${station.badge} ${esc(station.label)}</text><text class="sub" x="16" y="12">${esc(station.subtitle)}</text></g>`).join('\n');
  return `<section id="${name}"><div class="map-card"><div class="map-head"><div><div class="eyebrow">${flow ? 'FUNCTION MAP' : 'API MAP'}</div><h2>${esc(map.title)}</h2></div><div class="map-actions">${actions}<button type="button" data-reset-zoom="${name}-map">复位缩放</button></div></div>
<div class="map-viewport" data-zoom-for="${name}-map"><div class="zoom-readout" data-zoom-label="${name}-map">100%</div><svg class="map" id="${name}-map" xmlns="http://www.w3.org/2000/svg" viewBox="${ROADMAP_VIEWBOXES[name].join(' ')}" role="img" aria-label="${flow ? '功能' : 'API'}路线图"><title>${esc(map.title)}</title><g class="zoom-layer">${paths}<g pointer-events="none">${labels}</g>${stations}</g></svg></div>
<div class="hint" id="${name}-hint">交流时直接说编号，例如「F4」「A6」。滚轮放大，拖动平移，双击复位。点节点看详情。</div><div class="index-list">${map.stations.map(station => `<span><b>${station.badge}</b> ${esc(station.label)}</span>`).join('')}</div></div></section>`;
}

function entryTable(title, entries) {
  return `<div class="panel"><h3>${title}</h3>${entries.length ? `<table><thead><tr><th>项目</th><th>代码口径与状态</th></tr></thead><tbody>${entries.map(entry => `<tr><td>${esc(entry.title)}${entry.command ? `<br/><code>${esc(entry.command)}</code>` : ''}</td><td>${esc(entry.description)}</td></tr>`).join('')}</tbody></table>` : '<p>输入未提供此项事实。</p>'}</div>`;
}

export function compileRoadmap(data, { qualityProfile = 'roadmap-v1' } = {}) {
  if (!['roadmap-v1', 'standard', 'showcase', 'default', undefined].includes(qualityProfile)) throwDiagnosticProblems('roadmap quality profile failed', [`Unsupported roadmap quality profile ${JSON.stringify(qualityProfile)}.`], { code: 'roadmap/quality-profile' });
  validateRoadmapSchema(data);
  const maps = ['flow', 'api'].map(name => compileMap(name, data[name]));
  const meta = data.meta;
  const runtime = meta.runtime_flags.map(flag => `<span class="chip">${esc(flag)}</span>`).join('');
  const body = `<header class="hero"><div><div class="eyebrow">${esc(meta.eyebrow)}</div><h1>${esc(meta.title)}<br/>功能与 API 路线图</h1><p class="lede">${esc(meta.description)}</p><div class="meta"><span class="chip">核对 ${esc(meta.checked_at)}</span>${runtime}</div></div><div class="panel"><h3>怎么读功能图</h3><p><span class="legend-dot auto"></span>流动 = 已接通的自动步骤</p><p><span class="legend-dot manual"></span>静止实线 = 独立手动入口</p><p><span class="legend-dot gap"></span>静止虚线 = 未接通</p></div></header>
<nav class="toc"><a href="#flow">功能路线</a><a href="#api">API 路线</a><a href="#rules">硬规则与门禁</a><a href="#consume">消费场景 / 生命周期</a><a href="#pages">页面 / 命令</a><a href="#bounds">边界</a></nav>
${maps.map(renderMap).join('\n')}
<section id="rules">${entryTable('硬规则与门禁', data.rules)}</section><section class="grid-2" id="consume">${entryTable('消费场景', data.consumption)}${entryTable('生命周期', data.lifecycle)}</section><section id="pages">${entryTable('页面 / 命令', data.pages_commands)}</section><section id="bounds"><div class="panel"><h3>排查顺序与已知边界</h3><ul>${data.boundaries.map(boundary => `<li>${esc(boundary)}</li>`).join('')}</ul></div></section><footer>按 ${esc(meta.checked_at)} 核对源码；运行态口径：${meta.runtime_flags.map(esc).join('；')}。本文件不固定列出库存数量。</footer>`;
  const dictionary = map => Object.fromEntries(map.stations.map(station => [station.id, { title: esc(`${station.badge} ${station.label}`), body: esc(station.description) }]));
  const replacements = { __APITU_TITLE__: esc(`${meta.title}功能与 API 路线图`), __APITU_BODY__: body, __APITU_FLOW__: scriptJSON(dictionary(maps[0])), __APITU_API__: scriptJSON(dictionary(maps[1])) };
  // One-pass replacement prevents authored text resembling a placeholder from
  // acquiring executable meaning or replacing a later dictionary slot.
  const html = fs.readFileSync(ROADMAP_TEMPLATE, 'utf8').replace(/__APITU_(?:TITLE|BODY|FLOW|API)__/g, marker => replacements[marker]);
  const layout = {
    schemaVersion: 1, diagramType: 'roadmap', qualityProfile: 'roadmap-v1', ok: true,
    viewBoxes: ROADMAP_VIEWBOXES,
    nodes: maps.flatMap(map => map.stations.map(station => ({ id: `${map.name}:${station.id}`, map: map.name, badge: station.badge, label: station.label, x: station.x, y: station.y, width: station.bounds.width, height: station.bounds.height, bounds: station.bounds, kind: station.kind }))),
    edges: maps.flatMap(map => map.routes.map(route => ({ id: route.id, map: map.name, from: `${map.name}:${route.from}`, to: `${map.name}:${route.to}`, kind: route.kind, color: route.color, path: route.path, ...(route.label ? { label: route.label, labelPosition: route.labelPosition, labelBounds: route.labelBounds } : {}) }))),
    diagnostics: [],
  };
  return { ok: true, html, layout, receipt: layout, diagnostics: [], qualityProfile: 'roadmap-v1' };
}
