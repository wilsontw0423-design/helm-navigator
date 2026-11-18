import * as path from 'node:path';
import { formatTemplate } from './templateFormat';
import { formatYaml } from './yamlFormat';

export type HelmFileKind = 'yaml' | 'templateYaml' | 'tpl' | 'notes' | 'helmignore' | 'schemaJson';

export interface FormatOptions {
  yaml: boolean;
  normalizeActions: boolean;
  tplIndentControlActions: boolean;
  templateIndentControlActions: boolean;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  yaml: true,
  normalizeActions: true,
  tplIndentControlActions: true,
  templateIndentControlActions: false,
};

/** Classifies a file inside a chart. Returns undefined for files this formatter does not own. */
export function classify(file: string): HelmFileKind | undefined {
  const base = path.basename(file);
  const parts = file.split(/[\\/]/);
  const inTemplates = parts.includes('templates');
  if (base === '.helmignore') return 'helmignore';
  if (base === 'values.schema.json') return 'schemaJson';
  if (base.endsWith('.tpl')) return 'tpl';
  if (inTemplates && base === 'NOTES.txt') return 'notes';
  if (inTemplates && /\.ya?ml$/.test(base)) return 'templateYaml';
  // Only chart metadata and values files; other YAML next to a chart (CI files, raw manifests) is not ours.
  if (/^(Chart\.yaml|Chart\.lock|requirements\.(yaml|lock)|values.*\.ya?ml|.*-values\.ya?ml)$/.test(base)) return 'yaml';
  if (/\.ya?ml$/.test(base) && parts[parts.length - 2] === 'ci') return 'yaml'; // ci/*-values.yaml test values
  return undefined;
}

/** Returns the formatted text, or undefined when the file should be left untouched. */
export function formatHelmFile(kind: HelmFileKind, text: string, opts: FormatOptions = DEFAULT_FORMAT_OPTIONS): string | undefined {
  switch (kind) {
    case 'yaml':
      return opts.yaml ? formatYaml(text) : undefined;
    case 'templateYaml':
      return formatTemplate(text, {
        normalizeActions: opts.normalizeActions,
        indentControlActions: opts.templateIndentControlActions,
        yaml: true,
        collapseBlankLines: true,
      });
    case 'tpl':
      return formatTemplate(text, {
        normalizeActions: opts.normalizeActions,
        indentControlActions: opts.tplIndentControlActions,
        yaml: true,
        collapseBlankLines: true,
      });
    case 'notes':
      return formatTemplate(text, { normalizeActions: opts.normalizeActions, indentControlActions: false, yaml: false, collapseBlankLines: false });
    case 'helmignore':
      return formatIgnore(text);
    case 'schemaJson':
      try {
        return JSON.stringify(JSON.parse(text), null, 2) + '\n';
      } catch {
        return undefined;
      }
  }
}

function formatIgnore(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => (/\\[ \t]+$/.test(l) ? l : l.replace(/[ \t]+$/, ''))); // keep escaped trailing spaces
  const out: string[] = [];
  for (const l of lines) {
    if (l === '' && out[out.length - 1] === '') continue;
    out.push(l);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}
