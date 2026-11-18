import * as path from 'node:path';
import { parse } from 'yaml';
import type { PackagedChartCache } from './archive';
import { norm, type Host } from './host';

export interface Dependency {
  name: string;
  alias?: string;
  version?: string;
  repository?: string;
  condition?: string;
  /**
   * `import-values`, normalized: copy the child's `child` path (relative to its values root) to the
   * parent's `parent` path. The string form `- data` becomes `{ child: ['exports','data'], parent: [] }`.
   */
  importValues: ImportValue[];
  /** Index in the dependencies list (Chart.yaml or requirements.yaml). */
  index: number;
  /** File that declares it (Chart.yaml for apiVersion v2, requirements.yaml for v1). */
  declaredIn: string;
}

export interface ImportValue {
  child: string[];
  parent: string[];
}

export interface SubchartLink {
  /** Key under which the parent passes values to the subchart (`alias` or `name`). */
  alias: string;
  name: string;
  dependency?: Dependency;
  chart?: Chart;
  /** `charts/<name>-<version>.tgz` when the subchart comes from a packaged archive. */
  packagedPath?: string;
}

export interface ParentLink {
  parent: Chart;
  alias: string;
}

export interface Chart {
  dir: string;
  chartFile: string;
  name: string;
  version?: string;
  apiVersion?: string;
  /** `application` (default) or `library`. */
  type?: string;
  dependencies: Dependency[];
  subcharts: SubchartLink[];
  parents: ParentLink[];
  /** Set when this chart was unpacked from `charts/*.tgz` (its files are a read-only cache). */
  packagedFrom?: string;
}

/**
 * Graph of charts connected through `dependencies` (Chart.yaml / requirements.yaml), `file://`
 * repositories, and the `charts/` directory.
 */
export class ChartGraph {
  private charts = new Map<string, Chart>();
  /** `charts/x.tgz` → directory of the unpacked chart. */
  private unpacked = new Map<string, string>();
  private dirty = true;

  /** `packages`: when given, `charts/*.tgz` archives are unpacked and indexed read-only. */
  constructor(
    private host: Host,
    readonly packages?: PackagedChartCache,
  ) {}

  get all(): Chart[] {
    this.ensureLinked();
    return [...this.charts.values()];
  }

  clear(): void {
    this.charts.clear();
    this.unpacked.clear();
    this.dirty = true;
  }

  /** Adds charts from a list of Chart.yaml paths (e.g. from a workspace search). */
  addChartFiles(chartFiles: string[]): void {
    for (const f of chartFiles) this.loadChart(path.dirname(f));
  }

  invalidate(dir: string): void {
    this.charts.delete(norm(dir));
    this.dirty = true;
    this.loadChart(dir);
  }

  get(dir: string): Chart | undefined {
    this.ensureLinked();
    return this.charts.get(norm(dir));
  }

  /** The chart owning `file` (nearest ancestor directory containing Chart.yaml). */
  chartForFile(file: string): Chart | undefined {
    let dir = path.dirname(norm(file));
    for (;;) {
      if (this.charts.has(dir)) {
        this.ensureLinked();
        return this.charts.get(dir);
      }
      if (this.host.exists(path.join(dir, 'Chart.yaml'))) {
        const c = this.loadChart(dir);
        // A chart living under `<parent>/charts/` has an implicit parent.
        const up = path.dirname(dir);
        if (path.basename(up) === 'charts') this.loadChart(path.dirname(up));
        this.ensureLinked();
        return c && this.charts.get(dir);
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }

  /** All charts reachable through parent/subchart links, including `chart` itself. */
  component(chart: Chart): Chart[] {
    this.ensureLinked();
    const seen = new Set<Chart>();
    const stack = [chart];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      for (const s of c.subcharts) if (s.chart) stack.push(s.chart);
      for (const p of c.parents) stack.push(p.parent);
    }
    return [...seen];
  }

  private loadChart(dirIn: string): Chart | undefined {
    const dir = norm(dirIn);
    const existing = this.charts.get(dir);
    if (existing) return existing;
    const chartFile = path.join(dir, 'Chart.yaml');
    const text = this.host.readFile(chartFile);
    if (text === undefined) return undefined;
    let meta: Record<string, unknown> = {};
    try {
      meta = (parse(text) as Record<string, unknown>) ?? {};
    } catch {
      /* keep empty */
    }
    const chart: Chart = {
      dir,
      chartFile,
      name: typeof meta.name === 'string' ? meta.name : path.basename(dir),
      version: meta.version != null ? String(meta.version) : undefined,
      apiVersion: typeof meta.apiVersion === 'string' ? meta.apiVersion : undefined,
      type: typeof meta.type === 'string' ? meta.type : undefined,
      dependencies: readDeps(meta.dependencies, chartFile),
      subcharts: [],
      parents: [],
    };
    if (chart.dependencies.length === 0) {
      const req = path.join(dir, 'requirements.yaml');
      const reqText = this.host.readFile(req);
      if (reqText !== undefined) {
        try {
          chart.dependencies = readDeps((parse(reqText) as Record<string, unknown>)?.dependencies, req);
        } catch {
          /* ignore */
        }
      }
    }
    this.charts.set(dir, chart);
    this.dirty = true;

    for (const d of this.host.listDir(path.join(dir, 'charts'))) {
      const p = path.join(dir, 'charts', d.name);
      if (d.isDir) this.loadChart(p);
      else if (d.name.endsWith('.tgz') && this.packages) {
        const tgz = norm(p);
        const unpackedDir = this.packages.unpack(tgz);
        if (!unpackedDir) continue;
        this.unpacked.set(tgz, norm(unpackedDir));
        const c = this.loadChart(unpackedDir);
        if (c) c.packagedFrom = tgz;
      }
    }
    for (const dep of chart.dependencies) {
      if (dep.repository?.startsWith('file://')) this.loadChart(path.resolve(dir, dep.repository.slice('file://'.length)));
    }
    return chart;
  }

  private ensureLinked(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const c of this.charts.values()) {
      c.subcharts = [];
      c.parents = [];
    }
    for (const c of this.charts.values()) {
      const chartsDir = path.join(c.dir, 'charts');
      const entries = this.host.listDir(chartsDir);
      const vendored = entries
        .filter((e) => e.isDir)
        .map((e) => this.charts.get(norm(path.join(chartsDir, e.name))))
        .filter((x): x is Chart => !!x);
      const tgz = entries.filter((e) => !e.isDir && e.name.endsWith('.tgz')).map((e) => e.name);
      const packed = tgz
        .map((t) => {
          const file = norm(path.join(chartsDir, t));
          const dir = this.unpacked.get(file);
          return { file, chart: dir ? this.charts.get(dir) : undefined };
        })
        .filter((p): p is { file: string; chart: Chart } => !!p.chart);
      const used = new Set<Chart>();

      for (const dep of c.dependencies) {
        const alias = dep.alias ?? dep.name;
        let target: Chart | undefined;
        if (dep.repository?.startsWith('file://')) {
          target = this.charts.get(norm(path.resolve(c.dir, dep.repository.slice('file://'.length))));
        }
        target ??= vendored.find((v) => v.name === dep.name);
        target ??= packed.find((p) => p.chart.name === dep.name)?.chart;
        const link: SubchartLink = { alias, name: dep.name, dependency: dep, chart: target };
        if (target?.packagedFrom) link.packagedPath = target.packagedFrom;
        if (!target) {
          const pkg = tgz.find((t) => t.startsWith(dep.name + '-') && /^\d/.test(t.slice(dep.name.length + 1)));
          if (pkg) link.packagedPath = path.join(chartsDir, pkg);
        }
        c.subcharts.push(link);
        if (target) {
          used.add(target);
          target.parents.push({ parent: c, alias });
        }
      }
      // Charts in charts/ (directories or archives) that are not declared as dependencies are still subcharts.
      for (const v of [...vendored, ...packed.map((p) => p.chart)]) {
        if (used.has(v)) continue;
        used.add(v);
        c.subcharts.push({ alias: v.name, name: v.name, chart: v, packagedPath: v.packagedFrom });
        v.parents.push({ parent: c, alias: v.name });
      }
    }
  }
}

function readDeps(raw: unknown, declaredIn: string): Dependency[] {
  if (!Array.isArray(raw)) return [];
  const out: Dependency[] = [];
  raw.forEach((d, index) => {
    if (!d || typeof d !== 'object' || typeof (d as { name?: unknown }).name !== 'string') return;
    const o = d as Record<string, unknown>;
    out.push({
      name: o.name as string,
      alias: typeof o.alias === 'string' ? o.alias : undefined,
      version: o.version != null ? String(o.version) : undefined,
      repository: typeof o.repository === 'string' ? o.repository : undefined,
      condition: typeof o.condition === 'string' ? o.condition : undefined,
      importValues: readImportValues(o['import-values']),
      index,
      declaredIn,
    });
  });
  return out;
}

/** Same normalization as Helm's processImportValues (`"exports." + name` for the string form, `.` = root). */
function readImportValues(raw: unknown): ImportValue[] {
  if (!Array.isArray(raw)) return [];
  const dotted = (s: string) => (s === '.' || s === '' ? [] : s.replace(/^\./, '').split('.'));
  const out: ImportValue[] = [];
  for (const r of raw) {
    if (typeof r === 'string') out.push({ child: ['exports', ...dotted(r)], parent: [] });
    else if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      if (typeof o.child === 'string' && typeof o.parent === 'string') out.push({ child: dotted(o.child), parent: dotted(o.parent) });
    }
  }
  return out;
}
