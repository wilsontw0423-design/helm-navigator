// Proves the formatter does not change what Helm renders.
//
//   node scripts/verify-render.mjs <root-dir> <chart-path-relative-to-root> [helm template args...]
//
// Copies <root-dir> to a temp dir (the original is never modified), renders the chart with
// `helm template`, formats every Helm file in the copy, renders again, and compares the two
// outputs after parsing them as YAML (so only whitespace YAML ignores may differ).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseAllDocuments } from 'yaml';

const [root, chartRel, ...helmArgs] = process.argv.slice(2);
if (!root || !chartRel) {
  console.error('usage: verify-render.mjs <root-dir> <chart-rel-path> [helm args...]');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'helm-nav-verify-'));
fs.cpSync(root, tmp, { recursive: true });
const chart = path.join(tmp, chartRel);

const helm = (...args) => execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const render = () => helm('template', 'verify', chart, ...helmArgs);
const docs = (s) => parseAllDocuments(s, { version: '1.1' }).map((d) => d.toJS()).filter((d) => d != null);

try {
  const chartYaml = fs.readFileSync(path.join(chart, 'Chart.yaml'), 'utf8');
  if (/file:\/\//.test(chartYaml)) helm('dependency', 'build', chart);
} catch (e) {
  console.warn('dependency build failed (continuing):', e.stderr?.toString().trim());
}

const before = render();
const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
console.log(execFileSync('node', [cli, 'format', chart], { encoding: 'utf8' }).trim());
const after = render();

const textSame = before === after;
const yamlSame = isDeepStrictEqual(docs(before), docs(after));
console.log(`rendered bytes: before=${before.length} after=${after.length}`);
console.log(`text identical: ${textSame}`);
console.log(`YAML identical: ${yamlSame}`);
console.log(`temp copy: ${tmp}`);
if (!yamlSame) {
  fs.writeFileSync(path.join(tmp, 'before.yaml'), before);
  fs.writeFileSync(path.join(tmp, 'after.yaml'), after);
  console.error('MISMATCH — see before.yaml / after.yaml in the temp copy');
  process.exit(1);
}
