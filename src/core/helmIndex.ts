import * as path from 'node:path';
import type { PackagedChartCache } from './archive';
import { ChartGraph, type Chart, type SubchartLink } from './chartGraph';
import { norm, type Host } from './host';
import { analyzeTemplate, mergeCallContexts, type Ctx, type DefineContext, type NameRef, type TemplateAnalysis, type ValuesRef } from './templateAnalyzer';
import { findEntries, parseValues, pathEquals, pathPrefix, type ValueEntry, type ValuesFile } from './valuesFile';

/** `import`: copied from a subchart through `import-values` (lower precedence than the chart's own values). */
export type ChainRole = 'import' | 'default' | 'override' | 'global';

/** One layer of Helm value coalescing for a given path, lowest precedence first. */
export interface ChainItem {
  chart: Chart;
  role: ChainRole;
  /** Path as written in this chart's values file. */
  path: string[];
  /** Alias route from this chart down to the chart that reads the value, e.g. ["kid"]. */
  via: string[];
  file: string;
  entries: ValueEntry[];
}

export interface FileRange {
  file: string;
  start: number;
  end: number;
}

export interface TemplateValuesRef extends FileRange {
  chart: Chart;
  ref: ValuesRef;
}

const TEMPLATE_EXT = /\.(ya?ml|tpl|txt)$/;
/** Values-like file names: `values.yaml`, `values-prod.yaml`, `values_uat.yaml`, `prod-values.yaml`, `prod.values.yaml`. */
export const VALUES_NAME = /^(values([-_.][^/\\]*)?|[^/\\]*[-_.]values)\.ya?ml$/i;
/** Directories never searched for values files: chart content, and test fixtures (`ci/`, helm-unittest) that are not deploy values. */
const SKIP_DIRS = new Set(['templates', 'charts', 'node_modules', '.git', 'crds', 'files', 'ci', 'tests', 'unittests']);
const DISCOVERY_DEPTH = 6;

export class HelmIndex {
  readonly graph: ChartGraph;
  private valuesCache = new Map<string, { v: string; data: ValuesFile }>();
  /** Analyses assuming every `define` body runs with the root context (used to find call sites). */
  private rawCache = new Map<string, { v: string; data: TemplateAnalysis }>();
  /** Final analyses of files containing `define`, keyed by the call contexts they were computed with. */
  private tplCache = new Map<string, { v: string; sig: string; data: TemplateAnalysis }>();
  private defineCtxCache = new Map<Chart, { gen: number; map: Map<string, Ctx> }>();
  /**
   * Bumped by `touch()` whenever any template may have changed. Call contexts of named templates
   * depend on every template in the tree, so they are recomputed only after a touch.
   */
  private generation = 0;
  /** Values files found inside each chart directory, relative to it (see `discoveredValuesFiles`). */
  private discovered = new Map<string, string[]>();

  /**
   * `valuesFileNames`: relative to each chart dir, increasing precedence.
   * `packages`: cache used to unpack `charts/*.tgz` subcharts (omit to only record their path).
   */
  constructor(
    readonly host: Host,
    public valuesFileNames: string[] = ['values.yaml'],
    packages?: PackagedChartCache,
    /** Environment name → values files (relative to each chart dir, increasing precedence) layered on top. */
    public environments: Record<string, string[]> = {},
  ) {
    this.graph = new ChartGraph(host, packages);
  }

  // ---------------------------------------------------------------- caches

  valuesFile(file: string): ValuesFile | undefined {
    const v = this.host.version(file);
    const hit = this.valuesCache.get(file);
    if (hit && hit.v === v) return hit.data;
    const text = this.host.readFile(file);
    if (text === undefined) return undefined;
    const data = parseValues(file, text);
    this.valuesCache.set(file, { v, data });
    return data;
  }

  /** Signals that template files may have changed (call contexts of `define`s are recomputed). */
  touch(): void {
    this.generation++;
  }

  /** Signals that values files may have been created, deleted or renamed. */
  touchValuesFiles(): void {
    this.discovered.clear();
  }

  /**
   * Values-like files inside the chart directory (`VALUES_NAME`), relative to it, excluding
   * `templates/`, `charts/` and nested charts: e.g. `environments/prod/values.yaml`,
   * `enviroments/values_prod.yaml`, `ci/test-values.yaml`. Each one becomes an environment
   * (`helm -f <file>` on top of `values.yaml`) unless `environments` already lists it.
   */
  discoveredValuesFiles(chart: Chart): string[] {
    if (chart.packagedFrom) return [];
    const hit = this.discovered.get(chart.dir);
    if (hit) return hit;
    const out: string[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
      for (const e of this.host.listDir(dir)) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        const p = path.join(dir, e.name);
        if (e.isDir) {
          if (depth >= DISCOVERY_DEPTH || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          if (this.host.exists(path.join(p, 'Chart.yaml'))) continue; // a chart of its own
          walk(p, r, depth + 1);
        } else if (VALUES_NAME.test(e.name)) out.push(r);
      }
    };
    walk(chart.dir, '', 0);
    out.sort();
    this.discovered.set(chart.dir, out);
    return out;
  }

  /** Environment name → files relative to the chart: `environments` first, then one per discovered file. */
  private environmentMap(chart: Chart): Record<string, string[]> {
    const map: Record<string, string[]> = { ...this.environments };
    const covered = new Set(['values.yaml', ...this.valuesFileNames, ...Object.values(this.environments).flat()]);
    for (const f of this.discoveredValuesFiles(chart)) if (!covered.has(f)) map[f] = [f];
    return map;
  }

  private rawAnalysis(file: string): TemplateAnalysis | undefined {
    const v = this.host.version(file);
    const hit = this.rawCache.get(file);
    if (hit && hit.v === v) return hit.data;
    const text = this.host.readFile(file);
    if (text === undefined) return undefined;
    const data = analyzeTemplate(text);
    if (hit) this.generation++; // content changed: call contexts may have changed too
    this.rawCache.set(file, { v, data });
    return data;
  }

  /**
   * Analysis of a template file. `define` bodies run with the context their callers pass
   * (`include "x" .Values.image` → `.tag` is `.Values.image.tag`), merged over all call sites in the tree.
   */
  analysis(file: string): TemplateAnalysis | undefined {
    const raw = this.rawAnalysis(file);
    if (!raw || raw.defines.length === 0) return raw;
    const chart = this.graph.chartForFile(file);
    if (!chart) return raw;
    const ctxMap = this.defineContexts(chart);
    const sig = raw.defines.map((d) => `${d.name}=${JSON.stringify(ctxMap.get(d.name) ?? null)}`).join('\n');
    if (raw.defines.every((d) => (ctxMap.get(d.name)?.kind ?? 'root') === 'root')) return raw;
    const v = this.host.version(file);
    const hit = this.tplCache.get(file);
    if (hit && hit.v === v && hit.sig === sig) return hit.data;
    const text = this.host.readFile(file);
    if (text === undefined) return raw;
    const data = analyzeTemplate(text, (name) => ctxMap.get(name));
    this.tplCache.set(file, { v, sig, data });
    return data;
  }

  /** Context passed to each named template, merged over its `include` / `template` calls in the chart tree. */
  defineContexts(chart: Chart): Map<string, Ctx> {
    const hit = this.defineCtxCache.get(chart);
    if (hit && hit.gen === this.generation) return hit.map;
    const args = new Map<string, Ctx[]>();
    for (const c of this.graph.component(chart)) {
      for (const file of this.templateFiles(c)) {
        for (const inc of this.rawAnalysis(file)?.includes ?? []) {
          if (!inc.arg) continue;
          const list = args.get(inc.name) ?? [];
          list.push(inc.arg);
          args.set(inc.name, list);
        }
      }
    }
    const map = new Map<string, Ctx>();
    for (const [name, list] of args) map.set(name, mergeCallContexts(list));
    // rawAnalysis may have bumped the generation while reading changed files; store the current one.
    for (const c of this.graph.component(chart)) this.defineCtxCache.set(c, { gen: this.generation, map });
    return map;
  }

  /** Lookup for the scope of a cursor inside `file` (completion). */
  defineContextFor(file: string): DefineContext | undefined {
    const chart = this.graph.chartForFile(file);
    if (!chart) return undefined;
    const map = this.defineContexts(chart);
    return (name) => map.get(name);
  }

  /**
   * Values files of `chart`, lowest precedence first: the chart's own `values.yaml` (Helm always
   * loads it), then `valuesFileNames`, then the files of environment `env`. Without `env`: the files
   * of every environment (for navigation, references, rename and diagnostics across environments);
   * `null`: no environment at all (what `helm template` loads without `-f`, plus `valuesFileNames`).
   */
  valuesFilesOf(chart: Chart, env?: string | null): string[] {
    // A packaged chart only ships its own values.yaml; user-specific names (values-prod.yaml) do not apply.
    const envs = this.environmentMap(chart);
    const extra = env === null ? [] : env !== undefined ? (envs[env] ?? []) : Object.values(envs).flat();
    const names = chart.packagedFrom ? ['values.yaml'] : ['values.yaml', ...this.valuesFileNames, ...extra];
    const files = [...new Set(names.map((n) => path.join(chart.dir, n)))];
    return files.filter((f) => this.host.exists(f));
  }

  /**
   * Environments that apply to `chart`: those with at least one existing file in `chart` or one of
   * its ancestors — configured ones first, then discovered files (named by their relative path).
   */
  environmentsFor(chart: Chart): string[] {
    const tree = [chart];
    for (let i = 0; i < tree.length; i++) for (const l of tree[i].parents) if (!tree.includes(l.parent)) tree.push(l.parent);
    const out: string[] = [];
    for (const c of tree) {
      if (c.packagedFrom) continue;
      for (const [env, files] of Object.entries(this.environmentMap(c))) {
        if (!out.includes(env) && files.some((n) => this.host.exists(path.join(c.dir, n)))) out.push(env);
      }
    }
    const configured = Object.keys(this.environments);
    return [...out.filter((e) => configured.includes(e)), ...out.filter((e) => !configured.includes(e))];
  }

  isValuesFile(file: string): Chart | undefined {
    const chart = this.graph.chartForFile(file);
    if (!chart) return undefined;
    return this.valuesFilesOf(chart).some((f) => norm(f) === norm(file)) ? chart : undefined;
  }

  templateFiles(chart: Chart): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of this.host.listDir(dir)) {
        const p = path.join(dir, e.name);
        if (e.isDir) walk(p);
        else if (TEMPLATE_EXT.test(e.name)) out.push(p);
      }
    };
    walk(path.join(chart.dir, 'templates'));
    return out;
  }

  // ------------------------------------------------------- value coalescing

  private entriesIn(chart: Chart, p: string[], env?: string): { file: string; entries: ValueEntry[] }[] {
    return this.valuesFilesOf(chart, env).map((file) => ({ file, entries: findEntries(this.valuesFile(file), p) }));
  }

  /**
   * `import-values` sources for `.Values.<p>` of `chart`: the subchart and the path in its values
   * (`child` path + the rest of `p` below the import's `parent` path).
   */
  importsFor(chart: Chart, p: string[]): { link: SubchartLink; childPath: string[] }[] {
    const out: { link: SubchartLink; childPath: string[] }[] = [];
    for (const link of chart.subcharts) {
      for (const iv of link.dependency?.importValues ?? []) {
        if (!link.chart || !pathPrefix(iv.parent, p)) continue;
        out.push({ link, childPath: [...iv.child, ...p.slice(iv.parent.length)] });
      }
    }
    return out;
  }

  /** The reverse of `importsFor`: parent paths that receive the child's `<p>` through `import-values`. */
  importedBy(child: Chart, p: string[]): { parent: Chart; parentPath: string[] }[] {
    const out: { parent: Chart; parentPath: string[] }[] = [];
    for (const { parent } of child.parents) {
      for (const link of parent.subcharts) {
        if (link.chart !== child) continue;
        for (const iv of link.dependency?.importValues ?? []) {
          if (pathPrefix(iv.child, p)) out.push({ parent, parentPath: [...iv.parent, ...p.slice(iv.child.length)] });
        }
      }
    }
    return out;
  }

  /**
   * Every place that can set `.Values.<path>` as seen by `chart`: values imported from subcharts
   * (`import-values`), the chart's own defaults, then each ancestor's `<alias>.<path>` overrides,
   * and for `global.*`, each ancestor's `global.*`. Lowest precedence first.
   * `env`: use that environment's values files; omitted = every environment's files (the order across
   * environments is then not a precedence order, so do not call `effective` on it).
   */
  overrideChain(chart: Chart, p: string[], env?: string): ChainItem[] {
    const out: ChainItem[] = [];
    const isGlobal = p[0] === 'global';
    const push = (c: Chart, role: ChainRole, cp: string[], via: string[]) => {
      for (const { file, entries } of this.entriesIn(c, cp, env)) out.push({ chart: c, role, path: cp, via, file, entries });
    };
    // Helm: "Imported values from a child to a parent chart have a lower priority than the parents values."
    // The child is read after the parent's `<alias>.*` overrides were coalesced into it.
    for (const { link, childPath } of this.importsFor(chart, p)) {
      push(link.chart!, 'import', childPath, []);
      push(chart, 'import', [link.alias, ...childPath], []);
    }
    push(chart, 'default', p, []);
    const seen = new Set<Chart>([chart]);
    const climb = (c: Chart, cp: string[], via: string[]) => {
      for (const link of c.parents) {
        if (seen.has(link.parent)) continue;
        seen.add(link.parent);
        const pp = [link.alias, ...cp];
        const pv = [link.alias, ...via];
        push(link.parent, 'override', pp, pv);
        if (isGlobal) push(link.parent, 'global', p, pv);
        climb(link.parent, pp, pv);
      }
    };
    climb(chart, p, []);
    return out;
  }

  /**
   * Keys directly under `.Values.<p>` as seen by `chart`, from every layer of the override chain
   * (so keys only a parent sets are included). Each key carries its highest-precedence entry.
   */
  childKeys(chart: Chart, p: string[]): { key: string; entry: ValueEntry; file: string; hasChildren: boolean }[] {
    type Key = { key: string; entry: ValueEntry; file: string; hasChildren: boolean };
    const out = new Map<string, Key>();
    const set = (k: Key) => out.set(k.key, { ...k, hasChildren: k.hasChildren || !!out.get(k.key)?.hasChildren });
    // `import-values` targets deeper than `p` (e.g. `parent: kidImage` while completing the root).
    for (const link of chart.subcharts) {
      for (const iv of link.dependency?.importValues ?? []) {
        if (!link.chart || iv.parent.length <= p.length || !pathPrefix(p, iv.parent)) continue;
        for (const { file, entries } of this.entriesIn(link.chart, iv.child)) {
          for (const entry of entries) set({ key: iv.parent[p.length], entry, file, hasChildren: true });
        }
      }
    }
    for (const layer of this.overrideChain(chart, p)) {
      const vf = this.valuesFile(layer.file);
      if (!vf) continue;
      const depth = layer.path.length;
      for (const e of vf.entries) {
        if (e.path.length !== depth + 1 || !pathPrefix(layer.path, e.path)) continue;
        const key = e.path[depth];
        if (key === '[]') continue;
        set({ key, entry: e, file: layer.file, hasChildren: vf.entries.some((x) => x.path.length > e.path.length && pathPrefix(e.path, x.path)) });
      }
    }
    return [...out.values()];
  }

  /** The chain item that wins (highest precedence with a value), if any. */
  effective(chain: ChainItem[]): ChainItem | undefined {
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].entries.length) return chain[i];
    return undefined;
  }

  /**
   * "Go to definition" from a key in a values file: the subchart default it overrides
   * (when the first segment is a subchart alias) and the ancestors that override it.
   */
  relatedValueLocations(chart: Chart, p: string[]): FileRange[] {
    const out: FileRange[] = [];
    // Downward: <alias>.<rest> → subchart defaults for <rest>.
    const down = (c: Chart, cp: string[]) => {
      if (cp.length === 0) return;
      for (const s of c.subcharts) {
        if (s.alias !== cp[0] || !s.chart) continue;
        const rest = cp.slice(1);
        if (rest.length === 0) {
          for (const f of this.valuesFilesOf(s.chart)) out.push({ file: f, start: 0, end: 0 });
        } else {
          for (const { file, entries } of this.entriesIn(s.chart, rest)) for (const e of entries) out.push({ file, start: e.keyStart, end: e.keyEnd });
        }
        if (rest.length) down(s.chart, rest);
      }
    };
    down(chart, p);
    // Upward: who overrides this key.
    for (const item of this.overrideChain(chart, p)) {
      if (item.chart === chart) continue;
      for (const e of item.entries) out.push({ file: item.file, start: e.keyStart, end: e.keyEnd });
    }
    // import-values: from the receiving parent key to the subchart source, and back.
    for (const { link, childPath } of this.importsFor(chart, p)) {
      for (const { file, entries } of this.entriesIn(link.chart!, childPath)) for (const e of entries) out.push({ file, start: e.keyStart, end: e.keyEnd });
    }
    for (const { parent, parentPath } of this.importedBy(chart, p)) {
      for (const { file, entries } of this.entriesIn(parent, parentPath)) for (const e of entries) out.push({ file, start: e.keyStart, end: e.keyEnd });
    }
    // Globals are shared by the whole tree.
    if (p[0] === 'global') {
      for (const c of this.graph.component(chart)) {
        if (c === chart) continue;
        for (const { file, entries } of this.entriesIn(c, p)) for (const e of entries) out.push({ file, start: e.keyStart, end: e.keyEnd });
      }
    }
    return dedupe(out);
  }

  // -------------------------------------------------------- template refs

  /** Template references in `chart` matching `pred`. */
  private refsIn(chart: Chart, pred: (refPath: string[]) => boolean): TemplateValuesRef[] {
    const out: TemplateValuesRef[] = [];
    for (const file of this.templateFiles(chart)) {
      const a = this.analysis(file);
      if (!a) continue;
      for (const ref of a.valuesRefs) if (pred(ref.path)) out.push({ chart, ref, file, start: ref.start, end: ref.end });
    }
    return out;
  }

  /** Template references that read `.Values.<p>` in `chart` (exact match, wildcard aware). */
  templateRefsExact(chart: Chart, p: string[]): TemplateValuesRef[] {
    const charts = p[0] === 'global' ? this.graph.component(chart) : [chart];
    return charts.flatMap((c) => this.refsIn(c, (rp) => pathEquals(rp, p)));
  }

  /**
   * Template references related to a values key: reads of the key itself, of anything under it,
   * or of an ancestor of it (e.g. `toYaml .Values.resources`). Follows subchart aliases downward.
   */
  templateRefsForKey(chart: Chart, p: string[]): TemplateValuesRef[] {
    const related = (rp: string[]) => rp.length > 0 && (pathPrefix(p, rp) || pathPrefix(rp, p));
    const out: TemplateValuesRef[] = [];
    if (p[0] === 'global') {
      for (const c of this.graph.component(chart)) out.push(...this.refsIn(c, related));
      return out;
    }
    out.push(...this.refsIn(chart, related));
    const down = (c: Chart, cp: string[]) => {
      if (cp.length < 2) return;
      for (const s of c.subcharts) {
        if (s.alias !== cp[0] || !s.chart) continue;
        const rest = cp.slice(1);
        out.push(...this.refsIn(s.chart, (rp) => rp.length > 0 && (pathPrefix(rest, rp) || pathPrefix(rp, rest))));
        down(s.chart, rest);
      }
    };
    down(chart, p);
    return out;
  }

  // ------------------------------------------------------- named templates

  /** `define` / `block` locations for `name` anywhere in the chart tree (names are global in Helm). */
  findDefines(chart: Chart, name: string): FileRange[] {
    return this.collectNames(chart, name, 'defines');
  }

  findIncludes(chart: Chart, name: string): FileRange[] {
    return this.collectNames(chart, name, 'includes');
  }

  private collectNames(chart: Chart, name: string, kind: 'defines' | 'includes'): FileRange[] {
    const out: FileRange[] = [];
    for (const c of this.graph.component(chart)) {
      for (const file of this.templateFiles(c)) {
        const a = this.analysis(file);
        if (!a) continue;
        for (const r of a[kind] as NameRef[]) if (r.name === name) out.push({ file, start: r.start, end: r.end });
      }
    }
    return out;
  }
}

function dedupe(xs: FileRange[]): FileRange[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.file}:${x.start}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
