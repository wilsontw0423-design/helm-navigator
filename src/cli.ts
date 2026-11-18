/**
 * helm-navigator CLI — same formatter as the editor extension, for the shell and CI.
 *
 *   node dist/cli.js format <path...>   rewrite files in place
 *   node dist/cli.js check  <path...>   exit 1 if any file would change
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classify, formatHelmFile } from './core/format';

const [cmd, ...targets] = process.argv.slice(2);
if ((cmd !== 'format' && cmd !== 'check') || targets.length === 0) {
  console.error('usage: helm-navigator <format|check> <file-or-chart-dir...>');
  process.exit(2);
}

const files: string[] = [];
const walk = (p: string) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) if (e !== 'node_modules' && e !== '.git') walk(path.join(p, e));
  } else if (classify(p)) files.push(p);
};
targets.forEach(walk);

let changed = 0;
for (const f of files) {
  const kind = classify(f)!;
  const text = fs.readFileSync(f, 'utf8');
  const out = formatHelmFile(kind, text);
  if (out === undefined) {
    console.log(`skip     ${f} (${kind}: guard refused or unparseable)`);
    continue;
  }
  if (out === text) continue;
  changed++;
  if (cmd === 'format') {
    fs.writeFileSync(f, out);
    console.log(`format   ${f}`);
  } else {
    console.log(`would    ${f}`);
  }
}
console.log(`${files.length} files, ${changed} ${cmd === 'format' ? 'formatted' : 'need formatting'}`);
if (cmd === 'check' && changed) process.exit(1);
