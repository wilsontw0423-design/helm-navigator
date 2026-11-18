import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PackagedChartCache } from '../src/core/archive';
import { templateFindings, valuesFindings } from '../src/core/diagnostics';
import { HelmIndex } from '../src/core/helmIndex';
import { NodeHost } from '../src/core/host';

const FX = path.join(__dirname, 'fixtures');
const umbrella = path.join(FX, 'umbrella');
const child = path.join(umbrella, 'charts/child');
const shared = path.join(FX, 'shared');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'helm-nav-diag-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeIndex() {
  const idx = new HelmIndex(new NodeHost());
  idx.graph.addChartFiles([path.join(umbrella, 'Chart.yaml')]);
  return idx;
}
const text = (file: string, f: { start: number; end: number }) => fs.readFileSync(file, 'utf8').slice(f.start, f.end);

describe('diagnostics: undefined values', () => {
  it('warns on keys no values file sets, at the first missing segment', () => {
    const idx = makeIndex();
    const file = path.join(shared, 'templates/svc.yaml');
    const fs_ = templateFindings(idx, idx.graph.get(shared)!, file);
    expect(fs_.map((f) => [f.severity, text(file, f), f.message])).toEqual([
      ['warning', 'missingKey', '.Values.missingKey is not set in any values file of chart "shared", its parents or subcharts.'],
      ['warning', 'missingKey', expect.stringContaining('missingKey')],
      ['warning', 'deeper', expect.stringContaining('.Values.replicas.deeper')],
    ]);
  });

  it('no warnings in the child (parent overrides, globals, range elements, index)', () => {
    const idx = makeIndex();
    const file = path.join(child, 'templates/deployment.yaml');
    expect(templateFindings(idx, idx.graph.get(child)!, file)).toEqual([]);
  });

  it('parent template sees imported values and subchart defaults by alias', () => {
    const idx = makeIndex();
    const u = idx.graph.get(umbrella)!;
    const file = path.join(umbrella, 'templates/configmap.yaml');
    expect(templateFindings(idx, u, file)).toEqual([]);
    const tpl = path.join(tmp, 'parent.yaml');
    fs.writeFileSync(tpl, '{{ .Values.kid.image.repository }}{{ .Values.kid.nope }}');
    expect(templateFindings(idx, u, tpl).map((f) => text(tpl, f))).toEqual(['nope']);
  });

  it('skips packaged (read-only) charts', () => {
    const idx = new HelmIndex(new NodeHost(), ['values.yaml'], new PackagedChartCache(path.join(tmp, 'cache')));
    idx.graph.addChartFiles([path.join(FX, 'packaged/Chart.yaml')]);
    const packed = idx.graph.get(path.join(FX, 'packaged'))!.subcharts[0].chart!;
    const tpl = path.join(packed.dir, 'templates/svc.yaml');
    expect(templateFindings(idx, packed, tpl)).toEqual([]);
    expect(valuesFindings(idx, packed, path.join(packed.dir, 'values.yaml'))).toEqual([]);
  });
});

describe('diagnostics: unused values', () => {
  it('hints the outermost unused key only', () => {
    const idx = makeIndex();
    const file = path.join(shared, 'values.yaml');
    const fs_ = valuesFindings(idx, idx.graph.get(shared)!, file);
    expect(fs_.map((f) => [f.severity, text(file, f)])).toEqual([
      ['hint', 'unusedKey'],
      ['hint', 'unusedMap'],
    ]);
  });

  it('keys read in subcharts, imports, ancestors-of-refs and globals count as used', () => {
    const idx = makeIndex();
    expect(valuesFindings(idx, idx.graph.get(umbrella)!, path.join(umbrella, 'values.yaml'))).toEqual([]);
    // child: exports.data.* is read by the parent through import-values; resources is read via toYaml
    expect(valuesFindings(idx, idx.graph.get(child)!, path.join(child, 'values.yaml'))).toEqual([]);
  });
});
