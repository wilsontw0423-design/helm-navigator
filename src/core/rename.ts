import type { Chart } from './chartGraph';
import type { FileRange, HelmIndex } from './helmIndex';
import { pathEquals, pathPrefix } from './valuesFile';

export interface TextEditRange extends FileRange {
  newText: string;
}

export interface RenamePlan {
  /** Chart that owns the key (the subchart when renaming `<alias>.x` from a parent). */
  chart: Chart;
  path: string[];
  edits: TextEditRange[];
  /** Places that reference the key but are not edited (Chart.yaml strings). */
  warnings: string[];
}

/** Template-safe key name: reachable as `.Values.a.b` (no `-` or `.`). */
export const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Renames the last segment of `.Values.<p>` as seen by `chart`:
 *  - the key in the owning chart's values files,
 *  - each ancestor's `<alias>.<p>` override (and every `global.<p>` in the tree for globals),
 *  - every template reference whose path goes through the key, in the owning chart and in
 *    ancestors (`.Values.<alias>.<p>`), including `index .Values "a" "b"` string arguments.
 * References whose segment comes from a `with` / `range` context or a dynamic key have nothing to edit.
 * Not updated: dependency `condition` / `import-values` strings in Chart.yaml.
 */
export function planRename(index: HelmIndex, chartIn: Chart, pIn: string[], newName: string): RenamePlan {
  // From a parent's `<alias>.x.y`, rename the subchart's own `x.y` (and through it every override).
  let chart = chartIn;
  let p = pIn;
  for (;;) {
    const sub = p.length > 1 ? chart.subcharts.find((s) => s.alias === p[0] && s.chart) : undefined;
    if (!sub) break;
    chart = sub.chart!;
    p = p.slice(1);
  }
  const edits: TextEditRange[] = [];
  const warnings: string[] = [];
  const keyEdits = (c: Chart, cp: string[]) => {
    for (const file of index.valuesFilesOf(c)) {
      for (const e of index.valuesFile(file)?.entries ?? []) {
        if (pathEquals(e.path, cp) && e.path[cp.length - 1] === cp[cp.length - 1]) edits.push({ file, start: e.keyStart, end: e.keyEnd, newText: newName });
      }
    }
  };
  const refEdits = (c: Chart, cp: string[]) => {
    const at = cp.length - 1;
    for (const file of index.templateFiles(c)) {
      for (const ref of index.analysis(file)?.valuesRefs ?? []) {
        if (!pathPrefix(cp, ref.path) || ref.path[at] !== cp[at]) continue;
        const r = ref.segRanges[at];
        if (r) edits.push({ file, start: r.start, end: r.end, newText: newName });
      }
    }
  };

  if (p[0] === 'global') {
    for (const c of index.graph.component(chart)) {
      if (c.packagedFrom) continue;
      keyEdits(c, p);
      refEdits(c, p);
    }
  } else {
    keyEdits(chart, p);
    refEdits(chart, p);
    const seen = new Set<Chart>([chart]);
    const climb = (c: Chart, cp: string[]) => {
      for (const link of c.parents) {
        if (seen.has(link.parent)) continue;
        seen.add(link.parent);
        const pp = [link.alias, ...cp];
        keyEdits(link.parent, pp);
        refEdits(link.parent, pp);
        climb(link.parent, pp);
      }
    };
    climb(chart, p);
    // Chart.yaml of each direct parent: import-values and condition strings.
    for (const link of chart.parents) {
      for (const dep of link.parent.dependencies) {
        if ((dep.alias ?? dep.name) !== link.alias) continue;
        for (const iv of dep.importValues) {
          if (iv.child.length < p.length && pathPrefix(iv.child, p)) {
            // The renamed key is below the imported path: the parent receives it under the new name.
            const pp = [...iv.parent, ...p.slice(iv.child.length)];
            keyEdits(link.parent, pp);
            refEdits(link.parent, pp);
          } else if (pathPrefix(p, iv.child)) {
            warnings.push(`import-values in ${dep.declaredIn} (${dep.name}) reads "${iv.child.join('.')}"; update it by hand.`);
          }
        }
        for (const cond of (dep.condition ?? '').split(',').map((c) => c.trim().split('.'))) {
          if (cond[0] === link.alias && pathPrefix(p, cond.slice(1))) warnings.push(`condition "${dep.condition}" in ${dep.declaredIn} uses this key; update it by hand.`);
        }
      }
    }
  }
  return { chart, path: p, edits: dedupe(edits), warnings: [...new Set(warnings)] };
}

function dedupe(xs: TextEditRange[]): TextEditRange[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.file}:${x.start}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
