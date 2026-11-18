import * as path from 'node:path';
import type { Chart } from './chartGraph';
import type { HelmIndex } from './helmIndex';
import { norm } from './host';

/**
 * `helm template` support. Helm only renders whole charts from their top-level parent (a subchart's
 * values depend on its parents), so every render runs on a root chart and the output is filtered by
 * the `# Source:` header of each manifest. `--show-only` is not used: it fails with "could not find
 * template" both for unknown paths and for templates whose output is empty in the chosen values.
 */

/** A top-level chart that renders `chart`, and the `charts/<alias>` path from the root down to it. */
export interface RenderRoot {
  root: Chart;
  /** Aliases from the root to the chart (empty when the chart is the root). */
  aliases: string[];
}

/** Every top-level chart that includes `chart` (through `dependencies` or `charts/`), with the alias path. */
export function renderRoots(chart: Chart, seen: Set<Chart> = new Set()): RenderRoot[] {
  if (seen.has(chart)) return [];
  seen.add(chart);
  if (!chart.parents.length) return [{ root: chart, aliases: [] }];
  const out: RenderRoot[] = [];
  for (const link of chart.parents) {
    for (const r of renderRoots(link.parent, new Set(seen))) out.push({ root: r.root, aliases: [...r.aliases, link.alias] });
  }
  return out;
}

/** The `# Source:` path prefix of `chart`'s files when rendered from `r.root`, e.g. `umbrella/charts/kid`. */
export function sourcePrefix(r: RenderRoot): string {
  return [r.root.name, ...r.aliases.flatMap((a) => ['charts', a])].join('/');
}

/** The `# Source:` path of `file` (inside `chart`) when rendered from `r.root`. */
export function sourcePathOf(r: RenderRoot, chart: Chart, file: string): string {
  return `${sourcePrefix(r)}/${path.relative(chart.dir, file).split(path.sep).join('/')}`;
}

/** Maps a `# Source:` / error path back to a file, following subchart aliases from `root`. */
export function sourceToFile(root: Chart, source: string): string | undefined {
  const parts = source.split('/');
  if (parts[0] !== root.name) return undefined;
  let chart = root;
  let i = 1;
  while (parts[i] === 'charts' && i + 1 < parts.length) {
    const link = chart.subcharts.find((s) => s.alias === parts[i + 1]);
    if (!link?.chart) break;
    chart = link.chart;
    i += 2;
  }
  return path.join(chart.dir, ...parts.slice(i));
}

/**
 * Whether helm writes `file` to the output: files under `templates/` except partials (`_*`) and
 * `NOTES.txt` (`helm template` never prints it).
 */
export function isRenderedTemplate(chart: Chart, file: string): boolean {
  const rel = path.relative(path.join(chart.dir, 'templates'), file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const base = path.basename(file);
  return !base.startsWith('_') && base !== 'NOTES.txt';
}

/**
 * Values files passed with `-f` for `env` (`null`: none): the root's environment files on top of its
 * own `values.yaml`, which helm loads by itself.
 */
export function renderValuesFiles(index: HelmIndex, root: Chart, env: string | null): string[] {
  const own = norm(path.join(root.dir, 'values.yaml'));
  return index.valuesFilesOf(root, env).filter((f) => norm(f) !== own);
}

/** helm's own default release name for `helm template` without a name. */
export const DEFAULT_RELEASE_NAME = 'release-name';

/** Release names helm accepts (DNS-1123 subdomain, at most 53 characters). */
export const RELEASE_NAME = /^(?=.{1,53}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
/** Kubernetes namespace names (DNS-1123 label, at most 63 characters). */
export const NAMESPACE_NAME = /^(?=.{1,63}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export interface RenderOptions {
  releaseName?: string;
  /** `--namespace`; without it helm uses the kubeconfig context's namespace, or `default`. */
  namespace?: string;
  valuesFiles: string[];
  debug?: boolean;
}

/** Arguments for `helm`, to run with the root chart directory as working directory. */
export function helmTemplateArgs(root: Chart, o: RenderOptions): string[] {
  const args = ['template', o.releaseName || DEFAULT_RELEASE_NAME, root.dir];
  if (o.namespace) args.push('--namespace', o.namespace);
  for (const f of o.valuesFiles) args.push('-f', f);
  if (o.debug) args.push('--debug');
  return args;
}

export interface Manifest {
  /** `# Source:` path, e.g. `umbrella/charts/kid/templates/deployment.yaml`. */
  source: string;
  /** The manifest including its `# Source:` line, without the `---` separator. */
  text: string;
}

/** Splits `helm template` output into manifests at each `---` followed by a `# Source:` line. */
export function splitManifests(stdout: string): Manifest[] {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  const out: Manifest[] = [];
  let cur: { source: string; lines: string[] } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i] === '---' ? /^# Source: (.+)$/.exec(lines[i + 1] ?? '') : null;
    if (m) {
      if (cur) out.push({ source: cur.source, text: trimEnd(cur.lines) });
      cur = { source: m[1].trim(), lines: [] };
      continue;
    }
    cur?.lines.push(lines[i]);
  }
  if (cur) out.push({ source: cur.source, text: trimEnd(cur.lines) });
  return out;
}

function trimEnd(lines: string[]): string {
  let n = lines.length;
  while (n && !lines[n - 1].trim()) n--;
  return lines.slice(0, n).join('\n');
}

/** Manifests of one template (`source` is a file path) or of a chart and its subcharts (`source` is a prefix). */
export function selectManifests(all: Manifest[], target: { file: string } | { prefix: string }): Manifest[] {
  if ('file' in target) return all.filter((m) => m.source === target.file);
  return all.filter((m) => m.source.startsWith(target.prefix + '/'));
}

export interface HelmProblem {
  /** Path as helm prints it (`<root>/templates/x.yaml`), when known. */
  source?: string;
  /** 1-based line in the template source; for `yaml` problems the line is in the rendered output. */
  line?: number;
  /** 0-based column (Go `text/template` byte offset in the line). */
  column?: number;
  kind: 'template' | 'parse' | 'yaml' | 'dependencies' | 'other';
  message: string;
}

/** Interprets helm's stderr (v3 and v4 formats). */
export function parseHelmErrors(stderr: string): HelmProblem[] {
  const lines = stderr
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^level=(DEBUG|INFO)\b/.test(l));
  const text = lines.join('\n').replace(/\n*Use --debug flag to render out invalid YAML\s*$/, '').trim();
  const body = text.replace(/^Error: /, '');
  if (!body) return [];

  const deps = /missing in charts\/ directory: (.+)$/m.exec(body);
  if (deps) return [{ kind: 'dependencies', message: body }];

  const yaml = /^YAML parse error on ([^:]+): (.*)$/m.exec(body);
  if (yaml) {
    const line = /\bline (\d+): /.exec(yaml[2]);
    return [{ kind: 'yaml', source: yaml[1], line: line ? Number(line[1]) : undefined, message: yaml[2].replace(/\bline \d+: /, '').trim() }];
  }

  const failed = /execution error at \(([^):]+):(\d+):(\d+)\): ([\s\S]*)$/m.exec(body);
  if (failed) return [{ kind: 'template', source: failed[1], line: Number(failed[2]), column: Number(failed[3]), message: failed[4].trim() }];

  const parse = /parse error at \(([^):]+):(\d+)\): (.*)$/m.exec(body);
  if (parse) return [{ kind: 'parse', source: parse[1], line: Number(parse[2]), message: parse[3] }];

  // v4: "path:L:C\n  executing ... at <x>:\n    reason"; v3: "template: path:L:C: executing ... at <x>: reason"
  const exec = /^(?:template: )?([^\s:]+\/templates\/[^\s:]+):(\d+):(\d+)(?::\s*|\n)([\s\S]*)$/.exec(body);
  if (exec) {
    const message = exec[4]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    return [{ kind: 'template', source: exec[1], line: Number(exec[2]), column: Number(exec[3]), message }];
  }
  return [{ kind: 'other', message: body }];
}
