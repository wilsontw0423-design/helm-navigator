import type { Chart } from './chartGraph';
import type { HelmIndex } from './helmIndex';
import { pathPrefix, type ValueEntry } from './valuesFile';

export interface Finding {
  file: string;
  start: number;
  end: number;
  severity: 'warning' | 'hint';
  code: 'undefined-value' | 'unused-value';
  message: string;
}

/** A value that is meant to be filled in by the user (`{}`, `[]`, `null`, `~`, empty). */
function isOpen(e: ValueEntry): boolean {
  return /^(\{\s*\}|\[\s*\]|null|Null|NULL|~|)$/.test(e.preview.trim());
}

/** Charts whose templates and values are not the user's to fix. */
function skipChart(chart: Chart): boolean {
  return !!chart.packagedFrom || chart.type === 'library';
}

/**
 * Template references to `.Values` keys that no values file sets (own defaults, imports, parent
 * overrides, globals, or the defaults of a subchart addressed by alias). Not reported: paths with
 * `*` (range elements / dynamic keys), refs in an action that uses `default` / `required` / ...,
 * and refs below a declared key whose value is open (`{}`, `[]`, `null`).
 */
export function templateFindings(index: HelmIndex, chart: Chart, file: string): Finding[] {
  if (skipChart(chart)) return [];
  const a = index.analysis(file);
  if (!a) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const ref of a.valuesRefs) {
    const p = ref.path;
    if (ref.guarded || p.includes('*')) continue;
    const key = `${ref.start}:${p.join('.')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const missing = firstMissing(index, chart, p);
    if (missing === undefined) continue;
    const seg = ref.segRanges[missing];
    out.push({
      file,
      start: seg?.start ?? ref.start,
      end: seg?.end ?? ref.end,
      severity: 'warning',
      code: 'undefined-value',
      message: `.Values.${p.join('.')} is not set in any values file of chart "${chart.name}", its parents or subcharts.`,
    });
  }
  return out;
}

/** Index of the first segment of `p` that is not declared, or undefined if `p` resolves (or cannot be checked). */
function firstMissing(index: HelmIndex, chart: Chart, p: string[]): number | undefined {
  // `.Values.<alias>.*` in a parent also sees the subchart's own defaults.
  const sub = chart.subcharts.find((s) => s.alias === p[0]);
  if (sub && !sub.chart) return undefined; // subchart not available (not fetched): cannot tell
  for (let n = p.length; n > 0; n--) {
    const q = p.slice(0, n);
    const entries = index.overrideChain(chart, q).flatMap((c) => c.entries);
    if (sub?.chart && n > 1) {
      for (const { entries: es } of index.overrideChain(sub.chart, q.slice(1))) entries.push(...es);
    }
    if (sub?.chart && n === 1) return n === p.length ? undefined : 1;
    if (entries.length === 0) continue;
    if (n === p.length) return undefined;
    return entries.some(isOpen) ? undefined : n;
  }
  return 0;
}

/**
 * Keys in a values file that no template in the chart tree reads. Reports the outermost unused key
 * only. Keys are considered used when a template reads them, anything below them, or an ancestor
 * (`toYaml .Values.resources`), when they are a dependency `condition`, `tags`, `global.*` read
 * anywhere in the tree, or `import-values` sources/targets.
 */
export function valuesFindings(index: HelmIndex, chart: Chart, file: string): Finding[] {
  if (skipChart(chart)) return [];
  const vf = index.valuesFile(file);
  if (!vf) return [];
  const conditions = chart.dependencies.flatMap((d) => (d.condition ?? '').split(',').map((c) => c.trim().split('.')).filter((c) => c[0]));
  const unknownAliases = new Set(chart.subcharts.filter((s) => !s.chart).map((s) => s.alias));
  const out: Finding[] = [];
  const flagged: string[][] = [];
  for (const e of vf.entries) {
    const p = e.path;
    if (flagged.some((f) => pathPrefix(f, p))) continue;
    if (p[0] === 'tags' || unknownAliases.has(p[0])) continue;
    if (conditions.some((c) => pathPrefix(p, c) || pathPrefix(c, p))) continue;
    if (isUsed(index, chart, p)) continue;
    flagged.push(p);
    out.push({
      file,
      start: e.keyStart,
      end: e.keyEnd,
      severity: 'hint',
      code: 'unused-value',
      message: `${p.filter((s) => s !== '[]').join('.')} is not read by any template in the chart tree.`,
    });
  }
  return out;
}

function isUsed(index: HelmIndex, chart: Chart, p: string[]): boolean {
  // A subchart alias key itself (`kid:`) is a container; the keys below it are checked one by one.
  if (p.length === 1 && chart.subcharts.some((s) => s.alias === p[0] && s.chart)) return true;
  if (index.templateRefsForKey(chart, p).length) return true;
  // `import-values` source: a container of the source path (`exports`) is checked key by key below;
  // the source itself is used if the parent reads what it receives (or receives it at its root).
  for (const { parent } of chart.parents) {
    for (const link of parent.subcharts) {
      if (link.chart === chart && link.dependency?.importValues.some((iv) => iv.child.length > p.length && pathPrefix(p, iv.child))) return true;
    }
  }
  for (const { parent, parentPath } of index.importedBy(chart, p)) {
    if (parentPath.length === 0 || index.templateRefsForKey(parent, parentPath).length) return true;
  }
  return false;
}
