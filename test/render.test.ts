import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HelmIndex } from '../src/core/helmIndex';
import { NodeHost } from '../src/core/host';
import {
  helmTemplateArgs,
  isRenderedTemplate,
  NAMESPACE_NAME,
  RELEASE_NAME,
  parseHelmErrors,
  renderRoots,
  renderValuesFiles,
  selectManifests,
  sourcePathOf,
  sourcePrefix,
  sourceToFile,
  splitManifests,
} from '../src/core/render';

const FX = path.join(__dirname, 'fixtures');

function indexOf(chartYaml: string, environments?: Record<string, string[]>) {
  const idx = new HelmIndex(new NodeHost(), ['values.yaml'], undefined, environments);
  idx.graph.addChartFiles([chartYaml]);
  return idx;
}

describe('render planning', () => {
  const idx = indexOf(path.join(FX, 'umbrella/Chart.yaml'));
  const umbrella = idx.graph.get(path.join(FX, 'umbrella'))!;
  const child = idx.graph.get(path.join(FX, 'umbrella/charts/child'))!;
  const shared = idx.graph.get(path.join(FX, 'shared'))!;

  it('renders a subchart through its root, by alias', () => {
    expect(renderRoots(umbrella).map(sourcePrefix)).toEqual(['umbrella']);
    expect(renderRoots(child).map(sourcePrefix)).toEqual(['umbrella/charts/kid']);
    expect(renderRoots(shared).map(sourcePrefix)).toEqual(['umbrella/charts/shared']);
    const [r] = renderRoots(child);
    expect(r.root).toBe(umbrella);
    expect(sourcePathOf(r, child, path.join(child.dir, 'templates/deployment.yaml'))).toBe('umbrella/charts/kid/templates/deployment.yaml');
  });

  it('maps helm paths back to files', () => {
    expect(sourceToFile(umbrella, 'umbrella/templates/configmap.yaml')).toBe(path.join(umbrella.dir, 'templates/configmap.yaml'));
    expect(sourceToFile(umbrella, 'umbrella/charts/kid/templates/deployment.yaml')).toBe(path.join(child.dir, 'templates/deployment.yaml'));
    expect(sourceToFile(umbrella, 'umbrella/charts/shared/templates/svc.yaml')).toBe(path.join(shared.dir, 'templates/svc.yaml'));
    expect(sourceToFile(umbrella, 'other/templates/x.yaml')).toBeUndefined();
  });

  it('knows which files helm prints', () => {
    const t = (f: string) => isRenderedTemplate(umbrella, path.join(umbrella.dir, f));
    expect([t('templates/configmap.yaml'), t('templates/_helpers.tpl'), t('templates/NOTES.txt'), t('templates/sub/x.yaml'), t('values.yaml')]).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  it('passes the environment files with -f, not the chart values.yaml', () => {
    const envs = path.join(FX, 'envs');
    const e = indexOf(path.join(envs, 'Chart.yaml'), { prod: ['environments/values.yaml', 'environments/prod/values.yaml'] });
    const root = e.graph.get(envs)!;
    const rel = (fs: string[]) => fs.map((f) => path.relative(envs, f));
    expect(rel(renderValuesFiles(e, root, 'prod'))).toEqual(['environments/values.yaml', 'environments/prod/values.yaml']);
    expect(rel(renderValuesFiles(e, root, 'environments/uat/values.yaml'))).toEqual(['environments/uat/values.yaml']);
    expect(renderValuesFiles(e, root, null)).toEqual([]);
    expect(helmTemplateArgs(root, { valuesFiles: ['a.yaml', 'b.yaml'] })).toEqual(['template', 'release-name', envs, '-f', 'a.yaml', '-f', 'b.yaml']);
    expect(helmTemplateArgs(root, { valuesFiles: ['a.yaml'], releaseName: 'pinot', namespace: 'data-uat' })).toEqual([
      'template',
      'pinot',
      envs,
      '--namespace',
      'data-uat',
      '-f',
      'a.yaml',
    ]);
  });

  it('validates release and namespace names like helm / Kubernetes', () => {
    expect(['pinot', 'my-app.v2', 'a'].map((n) => RELEASE_NAME.test(n))).toEqual([true, true, true]);
    expect(['Pinot', '-a', 'a_b', 'x'.repeat(54)].map((n) => RELEASE_NAME.test(n))).toEqual([false, false, false, false]);
    expect(['data-uat', 'default'].map((n) => NAMESPACE_NAME.test(n))).toEqual([true, true]);
    expect(['Data', 'a.b', 'x'.repeat(64)].map((n) => NAMESPACE_NAME.test(n))).toEqual([false, false, false]);
  });
});

describe('helm output', () => {
  it('splits manifests on --- + # Source', () => {
    const out = '---\n# Source: c/templates/a.yaml\na: 1\n\n---\n# Source: c/templates/m.yaml\nx: 1\n---\n# Source: c/templates/m.yaml\ny: 2\n---\n# Source: c/charts/k/templates/d.yaml\nz: 3\n';
    const all = splitManifests(out);
    expect(all.map((m) => m.source)).toEqual(['c/templates/a.yaml', 'c/templates/m.yaml', 'c/templates/m.yaml', 'c/charts/k/templates/d.yaml']);
    expect(all[0].text).toBe('# Source: c/templates/a.yaml\na: 1');
    expect(selectManifests(all, { file: 'c/templates/m.yaml' }).map((m) => m.text.split('\n')[1])).toEqual(['x: 1', 'y: 2']);
    expect(selectManifests(all, { prefix: 'c/charts/k' }).map((m) => m.text.split('\n')[1])).toEqual(['z: 3']);
    expect(selectManifests(all, { prefix: 'c' })).toHaveLength(4);
  });

  it('parses helm v4 / v3 errors', () => {
    const tail = '\n\nUse --debug flag to render out invalid YAML\n';
    expect(parseHelmErrors('Error: u/templates/bad.yaml:1:10\n  executing "u/templates/bad.yaml" at <.Values.nope.deeper>:\n    nil pointer evaluating interface {}.deeper' + tail)).toEqual([
      { kind: 'template', source: 'u/templates/bad.yaml', line: 1, column: 10, message: 'executing "u/templates/bad.yaml" at <.Values.nope.deeper>: nil pointer evaluating interface {}.deeper' },
    ]);
    expect(parseHelmErrors('Error: template: u/templates/x.yaml:3:5: executing "u/templates/x.yaml" at <.Values.a>: boom\n')[0]).toMatchObject({ source: 'u/templates/x.yaml', line: 3, column: 5 });
    expect(parseHelmErrors('Error: execution error at (u/templates/f.yaml:2:3): need x' + tail)).toEqual([
      { kind: 'template', source: 'u/templates/f.yaml', line: 2, column: 3, message: 'need x' },
    ]);
    expect(parseHelmErrors('Error: parse error at (u/templates/b.yaml:1): missing value for if' + tail)).toEqual([
      { kind: 'parse', source: 'u/templates/b.yaml', line: 1, message: 'missing value for if' },
    ]);
    expect(parseHelmErrors('level=DEBUG msg="x"\nError: YAML parse error on u/templates/b.yaml: error converting YAML to JSON: yaml: line 2: mapping values are not allowed in this context' + tail)).toEqual([
      { kind: 'yaml', source: 'u/templates/b.yaml', line: 2, message: 'error converting YAML to JSON: yaml: mapping values are not allowed in this context' },
    ]);
    expect(parseHelmErrors("Error: an error occurred while checking for chart dependencies. You may need to run 'helm dependency build' to fetch missing dependencies: found in Chart.yaml, but missing in charts/ directory: shared\n")[0].kind).toBe('dependencies');
    expect(parseHelmErrors('')).toEqual([]);
  });
});

// Runs the real helm on a copy of the fixtures (skipped when helm is not installed).
const helm = (() => {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!helm)('helm template (integration)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-nav-render-'));
  fs.cpSync(FX, tmp, { recursive: true });
  const run = (cwd: string, args: string[]) => execFileSync('helm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('filters one subchart template out of the root render', () => {
    const dir = path.join(tmp, 'umbrella');
    run(dir, ['dependency', 'build', '.']);
    const idx = indexOf(path.join(dir, 'Chart.yaml'));
    const child = idx.graph.get(path.join(dir, 'charts/child'))!;
    const [r] = renderRoots(child);
    const out = run(r.root.dir, helmTemplateArgs(r.root, { valuesFiles: renderValuesFiles(idx, r.root, null) }));
    const file = path.join(child.dir, 'templates/deployment.yaml');
    const docs = selectManifests(splitManifests(out), { file: sourcePathOf(r, child, file) });
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toContain('image: "nginx:2.0"');
    expect(sourceToFile(r.root, docs[0].source)).toBe(file);
  });

  it('renders with the chosen environment', () => {
    const dir = path.join(tmp, 'envs');
    const idx = indexOf(path.join(dir, 'Chart.yaml'), { prod: ['environments/values.yaml', 'environments/prod/values.yaml'] });
    const root = idx.graph.get(dir)!;
    const replicas = (env: string) => /replicas: "(\d+)"/.exec(run(dir, helmTemplateArgs(root, { valuesFiles: renderValuesFiles(idx, root, env) })))?.[1];
    expect([replicas('prod'), replicas('environments/uat/values.yaml')]).toEqual(['3', '2']);
  });

  it('reports a template error with its position', () => {
    const dir = path.join(tmp, 'umbrella');
    fs.writeFileSync(path.join(dir, 'templates/bad.yaml'), 'a: 1\n{{ .Values.nope.deeper }}\n');
    let stderr = '';
    try {
      run(dir, ['template', 'r', dir]);
    } catch (e) {
      stderr = String((e as { stderr?: string }).stderr);
    }
    const [p] = parseHelmErrors(stderr);
    expect(p).toMatchObject({ kind: 'template', source: 'umbrella/templates/bad.yaml', line: 2 });
    const idx = indexOf(path.join(dir, 'Chart.yaml'));
    expect(sourceToFile(idx.graph.get(dir)!, p.source!)).toBe(path.join(dir, 'templates/bad.yaml'));
  });
});
