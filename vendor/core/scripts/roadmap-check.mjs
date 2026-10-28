import fs from 'node:fs';
import { textUnits } from '../renderers/shared/utils.mjs';
import { createHash } from 'node:crypto';

export const ROADMAP_PROFILE = 'roadmap-v1';
export function isRoadmapHtml(html) {
  return /<meta\s+name="apitu-diagram-type"\s+content="roadmap"\s*\/?\s*>/.test(String(html));
}
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const dictionaryPrefix = script => script.slice(0, script.indexOf('const flowHint'));
export function checkRoadmapHtml(html, file = '') {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  const styleTags = [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)];
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const styles = styleTags.filter(m => !m[1].trim()).map(m => m[2]);
  const scripts = scriptTags.filter(m => !m[1].trim()).map(m => m[2]);
  const template = fs.readFileSync(new URL('../assets/roadmap-template.html', import.meta.url), 'utf8');
  const originalStyle = template.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  const originalScript = template.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  check('roadmap/type-profile', isRoadmapHtml(html) && /name="apitu-quality-profile" content="roadmap-v1"/.test(html));
  check('roadmap/template-style', styleTags.length === 1 && styles.length === 1 && styles[0] === originalStyle);
  check('roadmap/template-script', scriptTags.length === 1 && scripts.length === 1 && scripts[0].includes('const flowHint') && scripts[0].slice(scripts[0].indexOf('const flowHint')) === originalScript?.slice(originalScript.indexOf('const flowHint')));
  const markup = html.replace(/<!--([\s\S]*?)-->/g, '').replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, '');
  const tags = [...markup.matchAll(/<([a-z][\w:.-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)];
  const safeMarkup = tags.every(([, tagName, attributes]) => {
    if (/^(?:iframe|object|embed|img|link|script)$/i.test(tagName)) return false;
    const fields = [...attributes.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)];
    return fields.every(([, name, doubleValue, singleValue, bareValue]) => {
      if (/^on/i.test(name)) return false;
      const value = doubleValue ?? singleValue ?? bareValue ?? '';
      return !/^(?:href|xlink:href|src|action|formaction)$/i.test(name) || /^#[A-Za-z][\w:-]*$/.test(value);
    });
  });
  check('roadmap/self-contained', safeMarkup && !/@import|url\(\s*["']?https?:/i.test(styles.join('')));
  let dictionaries;
  try {
    const prefix = dictionaryPrefix(scripts[0] || '').match(/^\s*const FLOW = ([\s\S]*?);\s*const API = ([\s\S]*?);\s*$/);
    if (!prefix) throw new Error('Expected exactly two JSON dictionary declarations.');
    const parsed = { flow: JSON.parse(prefix[1]), api: JSON.parse(prefix[2]) };
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    for (const [map, dict] of Object.entries(parsed)) {
      if (!record(dict)) throw new Error(`${map} dictionary must be a JSON object.`);
      for (const [key, entry] of Object.entries(dict)) {
        // The unchanged template assigns both fields to innerHTML. Only escaped
        // text may enter that sink; angle brackets are never legal raw markup.
        if (!record(entry) || Object.keys(entry).length !== 2 || !['title', 'body'].every(field => Object.hasOwn(entry, field) && typeof entry[field] === 'string' && !/[<>]/.test(entry[field]))) {
          throw new Error(`${map} dictionary entry ${key} must contain only escaped string title/body fields.`);
        }
      }
    }
    dictionaries = parsed;
    check('roadmap/dictionaries', true);
  } catch (error) { check('roadmap/dictionaries', false, error.message); }
  const maps = [...html.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)];
  check('roadmap/dual-maps', maps.length === 2);
  for (const [map, height, prefix] of [['flow',620,'F'],['api',560,'A']]) {
    const matches = maps.filter(m => attrs(m[1]).id === `${map}-map`);
    const source = matches[0]?.[2] || '';
    check(`roadmap/${map}-dimensions`, matches.length === 1 && attrs(matches[0][1]).viewBox === `0 0 1180 ${height}` && /class="zoom-layer"/.test(source));
    const stations = [...source.matchAll(/<g\b([^>]*\bclass="station"[^>]*)>([\s\S]*?)<\/g>/g)];
    const keys = stations.map(m => attrs(m[1])['data-key']);
    const dict = dictionaries?.[map];
    check(`roadmap/${map}-stations`, stations.length >= 2 && new Set(keys).size === keys.length && dict && Object.keys(dict).length === keys.length && keys.every(k => Object.hasOwn(dict,k)));
    const ids = new Set(stations.map(m => attrs(m[1])['data-node-id']));
    check(`roadmap/${map}-numbering`, stations.every((m,i) => new RegExp(`class="num"[^>]*>${prefix}${i+1}<`).test(m[2]) && dict && Object.hasOwn(dict, keys[i]) && dict[keys[i]].title.startsWith(`${prefix}${i+1} `)));
    const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    const boxes = stations.map(m => {
      const position = attrs(m[1]).transform?.match(/^translate\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)$/);
      const texts = [...m[2].matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(t => decode(t[1]));
      return { id: attrs(m[1])['data-node-id'], x: Number(position?.[1]), y: Number(position?.[2]), width: 49 + Math.max(textUnits(texts[1] || '') * 6.6, textUnits(texts[2] || '') * 5.6) };
    });
    check(`roadmap/${map}-station-geometry`, boxes.length >= 2 && boxes.every(b => Number.isFinite(b.x) && Number.isFinite(b.y) && b.x - 33 >= 16 && b.y - 21 >= 16 && b.x - 33 + b.width <= 1164 && b.y + 21 <= height - 16));
    check(`roadmap/${map}-station-clearance`, boxes.every((a,i) => boxes.every((b,j) => j <= i || a.x - 33 + a.width + 10 <= b.x - 33 || b.x - 33 + b.width + 10 <= a.x - 33 || a.y + 31 <= b.y - 21 || b.y + 31 <= a.y - 21)));
    const routes = [...source.matchAll(/<path\b([^>]*\bclass="route[^>]*)\/?\s*>/g)].map(m => attrs(m[1]));
    check(`roadmap/${map}-routes`, routes.length > 0 && new Set(routes.map(r => r['data-edge-id'])).size === routes.length && routes.every(r => ids.has(r['data-edge-from']) && ids.has(r['data-edge-to']) && r.d && !/NaN|Infinity/.test(r.d) && (map === 'api' ? typeof r['data-api'] === 'string' : ['auto','manual','gap'].includes(r['data-kind']))));
    check(`roadmap/${map}-route-geometry`, routes.every(route => {
      const n = '-?\\d+(?:\\.\\d+)?';
      const match = route.d?.match(new RegExp(`^M (${n}) (${n}) C (${n}) (${n}), (${n}) (${n}), (${n}) (${n})$`));
      if (!match) return false;
      const values = match.slice(1).map(Number);
      const from = boxes.find(b => b.id === route['data-edge-from']), to = boxes.find(b => b.id === route['data-edge-to']);
      return from && to && values.every((v,i) => Number.isFinite(v) && v >= 16 && v <= (i % 2 ? height - 16 : 1164)) && values[0] === from.x && values[1] === from.y && values[6] === to.x && values[7] === to.y;
    }));
    check(`roadmap/${map}-route-styles`, routes.every(r => map === 'api' ? /^route (gold|jade|coral)$/.test(r.class) : r['data-kind'] === 'gap' ? r.class === 'route gap' : r['data-kind'] === 'manual' ? /\bmanual\b/.test(r.class) && /\bjade\b/.test(r.class) : /\bauto\b/.test(r.class)));
  }
  check('roadmap/full-sections', ['flow','api','rules','consume','bounds'].every(id => new RegExp(`id="${id}"`).test(html)) && /<footer>/.test(html) && /\d{4}-\d{2}-\d{2}/.test(html));
  const errors = checks.filter(c => !c.ok).length;
  return { schemaVersion:1, ok:errors===0, diagramType:'roadmap', file, artifact:{path:file,sha256:createHash('sha256').update(html).digest('hex'),bytes:Buffer.byteLength(html)}, checks, composition:{schemaVersion:1,profile:ROADMAP_PROFILE,status:errors?'fail':'pass',summary:{errors,warnings:0},issues:checks.filter(c=>!c.ok).map(c=>({code:c.name,severity:'error',message:c.detail||c.name}))} };
}
