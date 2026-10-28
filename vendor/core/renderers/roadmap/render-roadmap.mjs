import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStandaloneHtml } from '../shared/cli.mjs';
import { installRendererDiagnosticBoundary, throwDiagnosticError } from '../shared/diagnostics.mjs';
import { resolveOutputPath } from '../shared/output-path.mjs';
import { compileRoadmap } from './roadmap-compiler.mjs';

export { compileRoadmap, validateRoadmapSchema } from './roadmap-compiler.mjs';

function readInput(inputPath) {
  let input;
  try { input = fs.readFileSync(inputPath, 'utf8'); }
  catch (error) {
    throwDiagnosticError(`Roadmap input could not be read: ${error.message}`, [{ code: 'input/read', message: error.message, subject: { input: inputPath }, evidence: { systemCode: error.code }, supportedFixes: ['Provide a readable roadmap JSON file.'] }]);
  }
  try { return JSON.parse(input); }
  catch (error) {
    throwDiagnosticError(`Roadmap input JSON could not be parsed: ${error.message}`, [{ code: 'input/json-parse', message: error.message, subject: { input: inputPath }, supportedFixes: ['Repair JSON syntax.'] }]);
  }
}

export function renderRoadmap(inputPath, requestedOutput, { cwd = process.cwd(), qualityProfile = process.env.APITU_QUALITY_PROFILE || 'roadmap-v1', validateOnly = false, layoutJson = false, diagnosticsJson = false } = {}) {
  inputPath = path.resolve(cwd, inputPath);
  const diagram = readInput(inputPath);
  const compiled = compileRoadmap(diagram, { qualityProfile });
  if (validateOnly || layoutJson || diagnosticsJson) return compiled;
  const outputGuard = { requestedOutput, authoredOutput: diagram.meta.output, defaultOutput: 'roadmap.html', inputPaths: [inputPath], cwd };
  const { outputPath: outPath } = resolveOutputPath(outputGuard);
  writeStandaloneHtml({ outPath, html: compiled.html, outputGuard });
  return { ...compiled, outPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installRendererDiagnosticBoundary();
  const args = process.argv.slice(2);
  const flags = args.filter(arg => arg.startsWith('--'));
  const positional = args.filter(arg => !arg.startsWith('--'));
  const modes = ['--validate-only', '--layout-json', '--diagnostics-json'];
  const unknown = flags.filter(flag => !modes.includes(flag));
  if (unknown.length || positional.length > 2 || new Set(flags).size !== flags.length || flags.length > 1) {
    throwDiagnosticError('Roadmap renderer expects INPUT [OUTPUT] and one optional --validate-only, --layout-json or --diagnostics-json.', [{ code: 'cli/arguments', message: 'Unsupported, duplicate, or conflicting renderer arguments.', subject: { args }, supportedFixes: ['Use INPUT [OUTPUT] with at most one supported inspection flag.'] }]);
  }
  const input = positional[0] || fileURLToPath(new URL('../../examples/apitu-plugin.roadmap.json', import.meta.url));
  const compiled = renderRoadmap(input, positional[1], { validateOnly: flags.includes('--validate-only'), layoutJson: flags.includes('--layout-json'), diagnosticsJson: flags.includes('--diagnostics-json') });
  if (flags.includes('--layout-json')) process.stdout.write(`${JSON.stringify(compiled.layout, null, 2)}\n`);
  else if (flags.length) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, source: 'renderer', diagramType: 'roadmap', qualityProfile: 'roadmap-v1', diagnostics: compiled.diagnostics })}\n`);
}
