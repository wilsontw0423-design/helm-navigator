import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { completeValues } from '../src/core/completion';
import { HelmIndex } from '../src/core/helmIndex';
import { NodeHost } from '../src/core/host';

const FX = path.join(__dirname, 'fixtures');
const umbrella = path.join(FX, 'umbrella');
const child = path.join(umbrella, 'charts/child');
const deployment = fs.readFileSync(path.join(child, 'templates/deployment.yaml'), 'utf8');

function makeIndex() {
  const idx = new HelmIndex(new NodeHost());
  idx.graph.addChartFiles([path.join(umbrella, 'Chart.yaml')]);
  return idx;
}

/** Completes at `‸` in `src` (inserted after `anchor` in the child deployment when `anchor` is given). */
function complete(src: string, chartDir = child) {
  const offset = src.indexOf('‸');
  const text = src.slice(0, offset) + src.slice(offset + 1);
  const idx = makeIndex();
  return completeValues(idx, idx.graph.get(chartDir)!, text, offset);
}
const insertAfter = (anchor: string, snippet: string) => {
  const i = deployment.indexOf(anchor) + anchor.length;
  return deployment.slice(0, i) + snippet + deployment.slice(i);
};
const labels = (r: ReturnType<typeof complete>) => r?.items.map((i) => i.label).sort();

describe('.Values completion', () => {
  it('inside `with .Values.image`, `.` lists repository and tag', () => {
    const r = complete(insertAfter('{{- with .Values.image }}\n', '          x: {{ .‸ }}\n'));
    expect(labels(r)).toEqual(['repository', 'tag']);
    expect(r!.items.find((i) => i.label === 'tag')!.detail).toBe('"2.0"'); // parent override wins
  });

  it('.Values. lists top-level keys, including keys only a parent sets', () => {
    const r = complete('{{ .Values.‸ }}');
    expect(labels(r)).toEqual(['exports', 'global', 'image', 'items', 'resources']);
    expect(r!.items.find((i) => i.label === 'image')!.kind).toBe('object');
    expect(r!.items.find((i) => i.label === 'resources')!.kind).toBe('key');
  });

  it('filters by the partial segment range and resolves nested paths', () => {
    const r = complete('{{ .Values.image.ta‸ }}');
    expect(labels(r)).toEqual(['repository', 'tag']);
    expect(r!.replaceStart).toBe('{{ .Values.image.'.length);
  });

  it('inside range, `.` and the element variable list item keys', () => {
    expect(labels(complete(insertAfter('{{- range $i, $item := .Values.items }}\n', '{{ .‸ }}')))).toEqual(['name', 'port']);
    expect(labels(complete(insertAfter('{{- range $i, $item := .Values.items }}\n', '{{ $item.‸ }}')))).toEqual(['name', 'port']);
  });

  it('`$` and root `.` offer built-in objects, then values', () => {
    expect(labels(complete('{{ .‸ }}'))).toContain('Values');
    expect(labels(complete('{{- with .Values.image }}{{ $.Values.‸ }}{{ end }}'))).toContain('image');
  });

  it('includes values imported through import-values', () => {
    expect(labels(complete('{{ .Values.‸ }}', umbrella))).toEqual(expect.arrayContaining(['team', 'tier', 'kidImage', 'kid']));
    expect(labels(complete('{{ .Values.kidImage.‸ }}', umbrella))).toEqual(['repository', 'tag']);
  });

  it('does nothing outside actions, in strings, comments, or after other objects', () => {
    expect(complete('name: .‸')).toBeUndefined();
    expect(complete('{{ printf ".‸ }}')).toBeUndefined();
    expect(complete('{{/* .‸ */}}')).toBeUndefined();
    expect(complete('{{ .Release.‸ }}')).toBeUndefined();
    expect(labels(complete('{{ printf "%s" .Values.‸ }}'))).toContain('image');
  });
});
