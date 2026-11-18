import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HelmIndex } from '../src/core/helmIndex';
import { NodeHost } from '../src/core/host';
import { analyzeTemplate } from '../src/core/templateAnalyzer';

const FX = path.join(__dirname, 'fixtures');
const umbrella = path.join(FX, 'umbrella');
const child = path.join(umbrella, 'charts/child');
const shared = path.join(FX, 'shared');

function makeIndex() {
  const idx = new HelmIndex(new NodeHost());
  idx.graph.addChartFiles([path.join(umbrella, 'Chart.yaml')]);
  return idx;
}
const rel = (f: string) => path.relative(FX, f);

describe('chart graph', () => {
  it('links subcharts by alias, charts/ dir and file:// repository', () => {
    const idx = makeIndex();
    const u = idx.graph.get(umbrella)!;
    expect(u.subcharts.map((s) => [s.alias, s.chart && rel(s.chart.dir)])).toEqual([
      ['kid', 'umbrella/charts/child'],
      ['shared', 'shared'],
    ]);
    expect(idx.graph.get(child)!.parents.map((p) => p.alias)).toEqual(['kid']);
    expect(idx.graph.chartForFile(path.join(child, 'templates/deployment.yaml'))!.name).toBe('child');
  });

  it('discovers the parent when only the child file is opened', () => {
    const idx = new HelmIndex(new NodeHost());
    const c = idx.graph.chartForFile(path.join(child, 'templates/deployment.yaml'))!;
    expect(c.parents.map((p) => p.parent.name)).toEqual(['umbrella']);
  });
});

describe('template analysis', () => {
  it('resolves .Values through with / range / variables / index / $', () => {
    const src = require('node:fs').readFileSync(path.join(child, 'templates/deployment.yaml'), 'utf8');
    const paths = analyzeTemplate(src).valuesRefs.map((r) => r.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining(['global.env', 'image', 'image.repository', 'image.tag', 'items', 'items.*.name', 'items.*.port', 'resources']),
    );
  });

  it('collects define and include names', () => {
    const a = analyzeTemplate('{{- define "a.b" -}}x{{- end }}{{ include "a.b" . }}{{ template "c" }}');
    expect(a.defines.map((d) => d.name)).toEqual(['a.b']);
    expect(a.includes.map((d) => d.name)).toEqual(['a.b', 'c']);
  });

  it('ignores .Values-looking text in comments and strings', () => {
    const a = analyzeTemplate('{{/* .Values.no */}}{{ printf ".Values.no %s" .Values.yes }}');
    expect(a.valuesRefs.map((r) => r.path.join('.'))).toEqual(['yes']);
  });

  it('does not treat (expr).field as a dot reference', () => {
    const a = analyzeTemplate('{{ (index .Values.list 0).name }}');
    expect(a.valuesRefs.map((r) => r.path.join('.'))).toEqual(['list.*']);
  });
});

describe('override chain', () => {
  it('child default → parent override via alias', () => {
    const idx = makeIndex();
    const chain = idx.overrideChain(idx.graph.get(child)!, ['image', 'tag']).filter((c) => c.entries.length);
    expect(chain.map((c) => [c.role, c.chart.name, c.path.join('.'), c.entries[0].preview])).toEqual([
      ['default', 'child', 'image.tag', '"1.0"'],
      ['override', 'umbrella', 'kid.image.tag', '"2.0"'],
    ]);
    expect(idx.effective(chain)!.chart.name).toBe('umbrella');
  });

  it('global values come from every ancestor', () => {
    const idx = makeIndex();
    const chain = idx.overrideChain(idx.graph.get(child)!, ['global', 'env']).filter((c) => c.entries.length);
    expect(chain.map((c) => [c.role, c.chart.name])).toEqual([
      ['default', 'child'],
      ['global', 'umbrella'],
    ]);
  });

  it('file:// subchart gets parent override', () => {
    const idx = makeIndex();
    const chain = idx.overrideChain(idx.graph.get(shared)!, ['replicas']).filter((c) => c.entries.length);
    expect(chain.map((c) => c.entries[0].preview)).toEqual(['1', '3']);
  });
});

describe('cross-chart navigation', () => {
  it('parent values key kid.image.tag → child default', () => {
    const idx = makeIndex();
    const locs = idx.relatedValueLocations(idx.graph.get(umbrella)!, ['kid', 'image', 'tag']);
    expect(locs.map((l) => rel(l.file))).toEqual(['umbrella/charts/child/values.yaml']);
  });

  it('child values key image.tag → parent override', () => {
    const idx = makeIndex();
    const locs = idx.relatedValueLocations(idx.graph.get(child)!, ['image', 'tag']);
    expect(locs.map((l) => rel(l.file))).toEqual(['umbrella/values.yaml']);
  });

  it('parent values key → child template references', () => {
    const idx = makeIndex();
    const refs = idx.templateRefsForKey(idx.graph.get(umbrella)!, ['kid', 'image', 'tag']);
    expect(new Set(refs.map((r) => rel(r.file)))).toEqual(
      new Set(['umbrella/charts/child/templates/deployment.yaml', 'umbrella/charts/child/templates/_helpers.tpl']),
    );
    // deployment: `.tag` inside `with .Values.image`, `index .Values "image" "tag"`, `with .Values.image`,
    // the `include "child.image" .Values.image` argument; _helpers.tpl: `.tag` in the define body
    expect(refs.length).toBe(5);
  });

  it('include in a subchart finds define in the parent', () => {
    const idx = makeIndex();
    const defs = idx.findDefines(idx.graph.get(shared)!, 'umbrella.fullname');
    expect(defs.map((d) => rel(d.file))).toEqual(['umbrella/templates/_helpers.tpl']);
    const incs = idx.findIncludes(idx.graph.get(umbrella)!, 'umbrella.fullname');
    expect(incs.map((d) => rel(d.file)).sort()).toEqual([
      'shared/templates/svc.yaml',
      'umbrella/charts/child/templates/deployment.yaml',
      'umbrella/templates/configmap.yaml',
    ]);
  });
});

describe('import-values / exports', () => {
  // Verified with `helm template` (Helm v4): team=from-parent, tier=backend, kidTag="2.0".
  it('string form imports exports.<name> at the parent root; parent values win', () => {
    const idx = makeIndex();
    const u = idx.graph.get(umbrella)!;
    const chain = idx.overrideChain(u, ['team']).filter((c) => c.entries.length);
    expect(chain.map((c) => [c.role, c.chart.name, c.path.join('.'), c.entries[0].preview])).toEqual([
      ['import', 'child', 'exports.data.team', 'from-child'],
      ['default', 'umbrella', 'team', 'from-parent'],
    ]);
    expect(idx.effective(chain)!.role).toBe('default');
    const tier = idx.overrideChain(u, ['tier']).filter((c) => c.entries.length);
    expect(idx.effective(tier)!.entries[0].preview).toBe('backend');
  });

  it('child/parent form maps a child path under a parent key, after parent overrides', () => {
    const idx = makeIndex();
    const chain = idx.overrideChain(idx.graph.get(umbrella)!, ['kidImage', 'tag']).filter((c) => c.entries.length);
    expect(chain.map((c) => [c.role, c.chart.name, c.path.join('.'), c.entries[0].preview])).toEqual([
      ['import', 'child', 'image.tag', '"1.0"'],
      ['import', 'umbrella', 'kid.image.tag', '"2.0"'],
    ]);
    expect(idx.effective(chain)!.entries[0].preview).toBe('"2.0"');
  });

  it('navigates between the imported parent key and the child source', () => {
    const idx = makeIndex();
    const down = idx.relatedValueLocations(idx.graph.get(umbrella)!, ['tier']);
    expect(down.map((l) => rel(l.file))).toEqual(['umbrella/charts/child/values.yaml']);
    const up = idx.relatedValueLocations(idx.graph.get(child)!, ['exports', 'data', 'team']);
    expect(up.map((l) => rel(l.file))).toEqual(['umbrella/values.yaml']);
  });
});

describe('define call context', () => {
  it('a define body runs with the context its callers pass', () => {
    const idx = makeIndex();
    const helpers = path.join(child, 'templates/_helpers.tpl');
    expect(idx.analysis(helpers)!.valuesRefs.map((r) => r.path.join('.'))).toEqual(['image.repository', 'image.tag']);
    const chain = idx.overrideChain(idx.graph.get(child)!, ['image', 'tag']);
    expect(idx.effective(chain)!.entries[0].preview).toBe('"2.0"');
    expect(idx.templateRefsExact(idx.graph.get(child)!, ['image', 'tag']).map((r) => rel(r.file)).sort()).toEqual([
      'umbrella/charts/child/templates/_helpers.tpl',
      'umbrella/charts/child/templates/deployment.yaml',
      'umbrella/charts/child/templates/deployment.yaml',
    ]);
  });

  it('merges call sites: root wins, equal-depth values become *, dict-only is unknown', async () => {
    const { mergeCallContexts } = await import('../src/core/templateAnalyzer');
    const v = (...p: string[]) => ({ kind: 'values' as const, path: p, ranges: p.map(() => null) });
    expect(mergeCallContexts([])).toEqual({ kind: 'root' });
    expect(mergeCallContexts([v('a'), { kind: 'root' }])).toEqual({ kind: 'root' });
    expect(mergeCallContexts([v('a', 'x'), v('b', 'x')]).kind === 'values' && (mergeCallContexts([v('a', 'x'), v('b', 'x')]) as { path: string[] }).path).toEqual(['*', 'x']);
    expect(mergeCallContexts([v('a'), v('a', 'b')])).toEqual({ kind: 'unknown' });
    expect(mergeCallContexts([{ kind: 'unknown' }])).toEqual({ kind: 'unknown' });
  });

  it('records the argument context of include calls', () => {
    const a = analyzeTemplate('{{ include "x" . }}{{ include "y" $ }}{{ with .Values.img }}{{ include "z" . }}{{ end }}{{ include "w" (dict "a" 1) }}');
    expect(a.includes.map((i) => [i.name, i.arg?.kind, i.arg?.kind === 'values' ? i.arg.path.join('.') : ''])).toEqual([
      ['x', 'root', ''],
      ['y', 'root', ''],
      ['z', 'values', 'img'],
      ['w', 'unknown', ''],
    ]);
  });

  it('completion inside a define uses the call context', async () => {
    const idx = makeIndex();
    const helpers = path.join(child, 'templates/_helpers.tpl');
    const src = require('node:fs').readFileSync(helpers, 'utf8') as string;
    const at = src.indexOf('{{ .tag }}') + '{{ .'.length;
    const { completeValues } = await import('../src/core/completion');
    const r = completeValues(idx, idx.graph.get(child)!, src, at, helpers);
    expect(r!.items.map((i) => i.label).sort()).toEqual(['repository', 'tag']);
  });
});
