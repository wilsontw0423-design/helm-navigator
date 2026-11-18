import type { Chart } from './chartGraph';
import type { HelmIndex } from './helmIndex';
import { scopeAt, type Ctx } from './templateAnalyzer';

export interface ValuesCompletion {
  label: string;
  kind: 'object' | 'key';
  /** One-line value preview, or a description for built-in objects. */
  detail: string;
  /** Full preview (YAML) and source file for values keys. */
  preview?: string;
  file?: string;
}

export interface CompletionResult {
  items: ValuesCompletion[];
  /** Offset where the partially typed segment starts (replace from here to the cursor). */
  replaceStart: number;
}

const BUILTINS: [string, string][] = [
  ['Values', 'Values passed into the template from values files and --set'],
  ['Release', 'Information about the release (Name, Namespace, Revision, ...)'],
  ['Chart', 'Contents of Chart.yaml'],
  ['Capabilities', 'Information about the Kubernetes cluster'],
  ['Template', 'Information about the current template (Name, BasePath)'],
  ['Files', 'Access to non-template files in the chart'],
  ['Subcharts', 'Scope of subcharts (Helm 3.15+)'],
];

/** Trailing `.a.b.` / `$.a.` / `$x.a.` expression before the cursor; `partial` is the segment being typed. */
const TRAILING_CHAIN = /(?:^|[^\w)\]$.])(\$\w*)?((?:\.[A-Za-z_]\w*)*)\.(\w*)$/;

/**
 * Completion for `.Values` keys inside a template action, honoring `with` / `range` / `$var` scope.
 * Returns undefined when the cursor is not right after a dot in a resolvable chain.
 */
export function completeValues(index: HelmIndex, chart: Chart, text: string, offset: number, file?: string): CompletionResult | undefined {
  const open = text.lastIndexOf('{{', offset);
  if (open < 0 || text.slice(open, offset).includes('}}')) return undefined;
  const inner = text.slice(open + 2, offset);
  if (/^-?\s*\/\*/.test(inner)) return undefined; // comment
  if ((inner.replace(/\\./g, '').match(/"/g)?.length ?? 0) % 2 === 1) return undefined; // inside a string literal
  const m = TRAILING_CHAIN.exec(inner);
  if (!m) return undefined;
  const [, varName, segText, partial] = m;
  const segs = segText ? segText.slice(1).split('.') : [];

  const scope = scopeAt(text, open, file ? index.defineContextFor(file) : undefined);
  let ctx: Ctx = varName === undefined ? scope.dot : scope.lookupVar(varName === '$' ? '$' : varName.slice(1));
  const replaceStart = offset - partial.length;

  if (ctx.kind === 'root') {
    if (segs.length === 0) return { replaceStart, items: BUILTINS.map(([label, detail]) => ({ label, kind: 'object', detail })) };
    if (segs[0] !== 'Values') return undefined;
    ctx = { kind: 'values', path: [], ranges: [] };
    segs.shift();
  }
  if (ctx.kind !== 'values') return undefined;
  const p = [...ctx.path, ...segs];
  const items = index.childKeys(chart, p).map(
    (k): ValuesCompletion => ({
      label: k.key,
      kind: k.hasChildren ? 'object' : 'key',
      detail: k.entry.preview.split('\n')[0],
      preview: k.entry.preview,
      file: k.file,
    }),
  );
  return { replaceStart, items };
}
