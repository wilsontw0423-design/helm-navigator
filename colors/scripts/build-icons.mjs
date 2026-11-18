// Builds icons/: the three Helm SVG icons and "Helm Navigator Icons", a copy of VS Code's Seti
// file icon theme (MIT) with Helm entries added. Run after changing scripts/icons.mjs or to pick
// up a newer Seti: node scripts/build-icons.mjs [path/to/theme-seti]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS, svg } from './icons.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'icons');
const setiDir = process.argv[2] ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/theme-seti';

fs.mkdirSync(out, { recursive: true });
for (const [name, icon] of Object.entries(ICONS)) {
  fs.writeFileSync(path.join(out, `${name}.svg`), svg(icon.body(icon.dark)));
  fs.writeFileSync(path.join(out, `${name}-light.svg`), svg(icon.body(icon.light)));
}

const theme = JSON.parse(fs.readFileSync(path.join(setiDir, 'icons/vs-seti-icon-theme.json'), 'utf8'));
fs.copyFileSync(path.join(setiDir, 'icons/seti.woff'), path.join(out, 'seti.woff'));
fs.copyFileSync(path.join(setiDir, 'ThirdPartyNotices.txt'), path.join(out, 'SETI-NOTICES.txt'));

for (const name of Object.keys(ICONS)) {
  theme.iconDefinitions[`_${name}`] = { iconPath: `./${name}.svg` };
  theme.iconDefinitions[`_${name}_light`] = { iconPath: `./${name}-light.svg` };
}
// Keys with a "dir/" prefix only match files directly inside a directory of that name.
const entries = (s) => ({
  languageIds: { 'helm-template': `_helm-template${s}`, 'helm-values': `_helm-values${s}` },
  fileExtensions: {
    'templates/yaml': `_helm-template${s}`,
    'templates/yml': `_helm-template${s}`,
    'templates/tpl': `_helm-helpers${s}`,
  },
  fileNames: { 'templates/notes.txt': `_helm-template${s}`, 'values.yaml': `_helm-values${s}`, 'values.yml': `_helm-values${s}` },
});
for (const [target, s] of [[theme, ''], [(theme.light ??= {}), '_light']]) {
  for (const [k, v] of Object.entries(entries(s))) target[k] = { ...(target[k] ?? {}), ...v };
}
delete theme.information_for_contributors;
fs.writeFileSync(path.join(out, 'helm-navigator-icon-theme.json'), JSON.stringify(theme, null, 1) + '\n');
console.log(`icons/ written (Seti ${theme.version})`);
