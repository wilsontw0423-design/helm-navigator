import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { templateFindings, valuesFindings } from '../src/core/diagnostics';
import { HelmIndex, VALUES_NAME } from '../src/core/helmIndex';
import { NodeHost } from '../src/core/host';
import { planRename } from '../src/core/rename';

const FX = path.join(__dirname, 'fixtures');
const envs = path.join(FX, 'envs');
const sub = path.join(envs, 'charts/sub');
// prod = shared + prod layer; uat = its own file only. Expected values verified with `helm template -f ...`.
const ENVIRONMENTS = {
  prod: ['environments/values.yaml', 'environments/prod/values.yaml'],
  uat: ['environments/uat/values.yaml'],
};

function makeIndex(environments: Record<string, string[]> = ENVIRONMENTS) {
  const idx = new HelmIndex(new NodeHost(), ['values.yaml'], undefined, environments);
  idx.graph.addChartFiles([path.join(envs, 'Chart.yaml')]);
  return idx;
}
const rel = (f: string) => path.relative(envs, f);
const effective = (idx: HelmIndex, dir: string, p: string[], env: string) =>
  idx.effective(idx.overrideChain(idx.graph.get(dir)!, p, env))?.entries[0].preview;

describe('environments', () => {
  it('lists environments with files in the chart or its ancestors', () => {
    const idx = makeIndex();
    expect(idx.environmentsFor(idx.graph.get(envs)!)).toEqual(['prod', 'uat']);
    expect(idx.environmentsFor(idx.graph.get(sub)!)).toEqual(['prod', 'uat']);
    // A configured environment without files is ignored; discovered files become environments of their own.
    const qa = makeIndex({ qa: ['environments/qa/values.yaml'] });
    expect(qa.environmentsFor(qa.graph.get(envs)!)).toEqual(['environments/prod/values.yaml', 'environments/uat/values.yaml', 'environments/values.yaml']);
  });

  it('effective value per environment, like helm template -f', () => {
    const idx = makeIndex();
    expect(['prod', 'uat'].map((e) => effective(idx, envs, ['replicas'], e))).toEqual(['3', '2']);
    expect(['prod', 'uat'].map((e) => effective(idx, envs, ['image', 'tag'], e))).toEqual(['"1.0"', '"1.1-rc"']);
    expect(['prod', 'uat'].map((e) => effective(idx, envs, ['prodOnly'], e))).toEqual(['true', undefined]);
    // subchart default overridden only by the prod layer of the parent
    expect(['prod', 'uat'].map((e) => effective(idx, sub, ['port'], e))).toEqual(['443', '80']);
  });

  it('environment files are values files; navigation spans every environment', () => {
    const idx = makeIndex();
    for (const f of ['environments/values.yaml', 'environments/prod/values.yaml', 'environments/uat/values.yaml']) {
      expect(idx.isValuesFile(path.join(envs, f))?.name).toBe('envs');
    }
    const files = idx.overrideChain(idx.graph.get(envs)!, ['replicas']).filter((c) => c.entries.length).map((c) => rel(c.file));
    expect(files).toEqual(['environments/values.yaml', 'environments/prod/values.yaml', 'environments/uat/values.yaml']);
    expect(idx.relatedValueLocations(idx.graph.get(sub)!, ['port']).map((l) => rel(l.file))).toEqual(['environments/prod/values.yaml']);
  });

  it('diagnostics: defined in any environment is defined; env-only keys are used', () => {
    const idx = makeIndex();
    const cm = path.join(envs, 'templates/cm.yaml');
    const text = fs.readFileSync(cm, 'utf8');
    expect(templateFindings(idx, idx.graph.get(envs)!, cm).map((f) => text.slice(f.start, f.end))).toEqual(['inNoEnvironment']);
    for (const f of ['environments/values.yaml', 'environments/prod/values.yaml', 'environments/uat/values.yaml']) {
      expect(valuesFindings(idx, idx.graph.get(envs)!, path.join(envs, f))).toEqual([]);
    }
    // Without the setting, the environment files are discovered: same result.
    const bare = new HelmIndex(new NodeHost());
    bare.graph.addChartFiles([path.join(envs, 'Chart.yaml')]);
    expect(templateFindings(bare, bare.graph.get(envs)!, cm).map((f) => text.slice(f.start, f.end))).toEqual(['inNoEnvironment']);
  });

  it('rename updates every environment file', () => {
    const idx = makeIndex();
    const plan = planRename(idx, idx.graph.get(envs)!, ['replicas'], 'replicaCount');
    expect(plan.edits.map((e) => rel(e.file)).sort()).toEqual([
      'environments/prod/values.yaml',
      'environments/uat/values.yaml',
      'environments/values.yaml',
      'templates/cm.yaml',
    ]);
  });

  it("the chart's own values.yaml is always the lowest layer", () => {
    const idx = new HelmIndex(new NodeHost(), ['environments/values.yaml']);
    idx.graph.addChartFiles([path.join(envs, 'Chart.yaml')]);
    expect(idx.valuesFilesOf(idx.graph.get(sub)!).map((f) => path.relative(sub, f))).toEqual(['values.yaml']);
    expect(idx.valuesFilesOf(idx.graph.get(envs)!).map(rel)).toEqual([
      'environments/values.yaml',
      'environments/prod/values.yaml',
      'environments/uat/values.yaml',
    ]);
  });

  it('discovers values files without any setting: each file is an environment on top of values.yaml', () => {
    const idx = new HelmIndex(new NodeHost());
    idx.graph.addChartFiles([path.join(envs, 'Chart.yaml')]);
    const c = idx.graph.get(envs)!;
    expect(idx.discoveredValuesFiles(c)).toEqual(['environments/prod/values.yaml', 'environments/uat/values.yaml', 'environments/values.yaml']);
    expect(idx.environmentsFor(c)).toEqual(['environments/prod/values.yaml', 'environments/uat/values.yaml', 'environments/values.yaml']);
    expect(effective(idx, envs, ['replicas'], 'environments/uat/values.yaml')).toBe('2');
    expect(idx.isValuesFile(path.join(envs, 'environments/uat/values.yaml'))?.name).toBe('envs');
    // template F12 lists every values file that sets the key
    expect(idx.overrideChain(c, ['image', 'tag']).filter((x) => x.entries.length).map((x) => rel(x.file))).toEqual([
      'environments/uat/values.yaml',
      'environments/values.yaml',
    ]);
    // nested charts and charts/ are not searched
    expect(idx.discoveredValuesFiles(idx.graph.get(sub)!)).toEqual(['values.yaml']);
  });

  it('values file names', () => {
    for (const n of ['values.yaml', 'values-prod.yaml', 'values_prod.yaml', 'values.prod.yml', 'prod-values.yaml', 'prod_values.yaml', 'Values.yaml']) {
      expect([n, VALUES_NAME.test(n)]).toEqual([n, true]);
    }
    for (const n of ['Chart.yaml', 'valuesfile.yaml', 'myvalues.yaml', 'values.schema.json', 'values.txt', 'deployment.yaml']) {
      expect([n, VALUES_NAME.test(n)]).toEqual([n, false]);
    }
  });
});
