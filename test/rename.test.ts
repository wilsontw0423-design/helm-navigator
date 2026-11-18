import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HelmIndex } from '../src/core/helmIndex';
import { NodeHost } from '../src/core/host';
import { planRename, type TextEditRange } from '../src/core/rename';

const FX = path.join(__dirname, 'fixtures');
const umbrella = path.join(FX, 'umbrella');
const child = path.join(umbrella, 'charts/child');

function makeIndex() {
  const idx = new HelmIndex(new NodeHost());
  idx.graph.addChartFiles([path.join(umbrella, 'Chart.yaml')]);
  return idx;
}
/** `file:line: <line text after the edit>` for each edit, to check edits in context. */
function applied(edits: TextEditRange[]): string[] {
  const byFile = new Map<string, TextEditRange[]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  const out: string[] = [];
  for (const [file, es] of byFile) {
    let text = fs.readFileSync(file, 'utf8');
    for (const e of [...es].sort((a, b) => b.start - a.start)) {
      expect(['tag', 'image', 'name', 'env'].includes(text.slice(e.start, e.end))).toBe(true);
      text = text.slice(0, e.start) + e.newText + text.slice(e.end);
    }
    const lines = text.split('\n');
    for (const e of es) {
      const line = fs.readFileSync(file, 'utf8').slice(0, e.start).split('\n').length - 1;
      out.push(`${path.relative(FX, file)}:${line + 1}: ${lines[line].trim()}`);
    }
  }
  return out.sort();
}

describe('rename values key', () => {
  it('child image.tag → values, parent override, template refs (with / index / define body), and import-values target', () => {
    const idx = makeIndex();
    const plan = planRename(idx, idx.graph.get(child)!, ['image', 'tag'], 'version');
    expect(plan.chart.name).toBe('child');
    expect(applied(plan.edits)).toEqual([
      'umbrella/charts/child/templates/_helpers.tpl:3: {{ .repository }}:{{ .version }}',
      'umbrella/charts/child/templates/deployment.yaml:13: image: "{{ .repository }}:{{ .version }}"',
      'umbrella/charts/child/templates/deployment.yaml:26: value: {{ index .Values "image" "version" | quote }}',
      'umbrella/charts/child/values.yaml:5: version: "1.0"',
      'umbrella/templates/configmap.yaml:9: kidTag: {{ .Values.kidImage.version | quote }}',
      'umbrella/values.yaml:6: version: "2.0"',
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('from the parent, kid.image.tag renames the subchart key', () => {
    const idx = makeIndex();
    const fromParent = planRename(idx, idx.graph.get(umbrella)!, ['kid', 'image', 'tag'], 'version');
    const fromChild = planRename(idx, idx.graph.get(child)!, ['image', 'tag'], 'version');
    expect(fromParent.chart.name).toBe('child');
    expect(fromParent.edits).toEqual(fromChild.edits);
  });

  it('renaming an import-values source path warns instead of editing Chart.yaml', () => {
    const idx = makeIndex();
    const plan = planRename(idx, idx.graph.get(child)!, ['image'], 'img');
    expect(plan.warnings).toEqual([expect.stringContaining('import-values in')]);
    expect(applied(plan.edits).length).toBeGreaterThanOrEqual(4); // values, parent kid.image, with, index
  });

  it('range element keys and globals', () => {
    const idx = makeIndex();
    const items = planRename(idx, idx.graph.get(child)!, ['items', '[]', 'name'], 'title');
    expect(applied(items.edits)).toEqual([
      'umbrella/charts/child/templates/deployment.yaml:19: - name: {{ $item.title }}',
      'umbrella/charts/child/values.yaml:7: - title: a',
      'umbrella/values.yaml:8: - title: from-parent',
    ]);
    const env = planRename(idx, idx.graph.get(child)!, ['global', 'env'], 'stage');
    expect(applied(env.edits)).toEqual([
      'umbrella/charts/child/templates/deployment.yaml:6: env: {{ $.Values.global.stage }}',
      'umbrella/charts/child/values.yaml:2: stage: dev',
      'umbrella/templates/configmap.yaml:6: env: {{ .Values.global.stage|quote }}',
      'umbrella/values.yaml:3: stage: prod',
    ]);
  });
});
