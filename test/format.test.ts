import { describe, expect, it } from 'vitest';
import { classify, formatHelmFile } from '../src/core/format';
import { formatTemplate, normalizeActions } from '../src/core/format/templateFormat';
import { formatYaml } from '../src/core/format/yamlFormat';

describe('classify', () => {
  it.each([
    ['c/Chart.yaml', 'yaml'],
    ['c/values.yaml', 'yaml'],
    ['c/Chart.lock', 'yaml'],
    ['c/requirements.yaml', 'yaml'],
    ['c/templates/deploy.yaml', 'templateYaml'],
    ['c/templates/sub/x.yml', 'templateYaml'],
    ['c/templates/_helpers.tpl', 'tpl'],
    ['c/templates/NOTES.txt', 'notes'],
    ['c/.helmignore', 'helmignore'],
    ['c/values.schema.json', 'schemaJson'],
  ])('%s → %s', (f, k) => expect(classify(f)).toBe(k));
});

describe('normalizeActions', () => {
  it('pads delimiters and pipes, keeps trim markers', () => {
    expect(normalizeActions('a: {{.Values.x|quote}}')).toBe('a: {{ .Values.x | quote }}');
    expect(normalizeActions('{{-   include  "x"   .   -}}')).toBe('{{- include "x" . -}}');
    expect(normalizeActions('{{ $a:=( default  1 .x ) }}')).toBe('{{ $a := (default 1 .x) }}');
  });
  it('leaves strings, comments, negative numbers and multi-line actions alone', () => {
    expect(normalizeActions('{{ printf "a  |  b}}" .x }}')).toBe('{{ printf "a  |  b}}" .x }}');
    expect(normalizeActions('{{/*  keep   me */}}')).toBe('{{/*  keep   me */}}');
    expect(normalizeActions('{{-3}}')).toBe('{{ -3 }}');
    const multi = '{{ dict\n  "a" 1 }}';
    expect(normalizeActions(multi)).toBe(multi);
  });
  it('keeps (expr).field adjacency', () => {
    expect(normalizeActions('{{ (index .x 0).name }}')).toBe('{{ (index .x 0).name }}');
  });
});

describe('formatTemplate', () => {
  const yamlOpts = { normalizeActions: true, indentControlActions: false, yaml: true, collapseBlankLines: true };

  it('strips trailing whitespace and collapses blank lines, but not in block scalars', () => {
    const src = 'a: 1   \n\n\n\nb: |\n  keep   \n\n\n  x\nc: 2\n';
    expect(formatTemplate(src, yamlOpts)).toBe('a: 1\n\nb: |\n  keep   \n\n\n  x\nc: 2\n');
  });

  it('never changes YAML indentation of content lines', () => {
    const src = 'spec:\n      weird: 1\n  {{- if .x }}\n   y: 2\n  {{- end }}\n';
    expect(formatTemplate(src, yamlOpts)).toBe(src);
  });

  it('indents sole {{- }} control lines in .tpl by depth', () => {
    const src = ['{{- define "x" -}}', '{{- if .a }}', '{{- .a }}', '{{- else }}', '{{- range .b }}', '{{- . }}', '{{- end }}', '{{- end }}', '{{- end }}', ''].join('\n');
    const out = formatTemplate(src, { ...yamlOpts, indentControlActions: true });
    expect(out).toBe(['{{- define "x" -}}', '{{- if .a }}', '  {{- .a }}', '{{- else }}', '  {{- range .b }}', '    {{- . }}', '  {{- end }}', '{{- end }}', '{{- end }}', ''].join('\n'));
  });

  it('does not re-indent lines without left trim (their indentation is rendered)', () => {
    const src = '{{ define "x" }}\n{{ if .a }}\nkey: v\n{{ end }}\n{{ end }}\n';
    expect(formatTemplate(src, { ...yamlOpts, indentControlActions: true })).toBe(src);
  });

  it('is idempotent', () => {
    const src = 'a: {{.x}}  \n\n\n{{- if .y}}\nb: 1\n{{- end}}\n';
    const once = formatTemplate(src, yamlOpts);
    expect(formatTemplate(once, yamlOpts)).toBe(once);
  });
});

describe('formatYaml', () => {
  it('leaves template syntax in values files alone: quoted / block scalar kept, unquoted refused', () => {
    expect(formatYaml('name:   "{{ .Release.Name }}-x"\n')).toBe('name: "{{ .Release.Name }}-x"\n');
    expect(formatYaml('config: |\n    url: {{ .Values.host }}\n')).toBe('config: |\n  url: {{ .Values.host }}\n');
    // go-yaml (Helm) rejects this; the yaml library would rewrite it to `name: {? {.Release.Name}}`
    expect(formatYaml('name: {{ .Release.Name }}\n')).toBeUndefined();
  });

  it('re-indents and keeps comments, quotes and sequence style', () => {
    const src = '# top\nimage:\n    repository: nginx   # repo\n    tag: "1.0"\nlist:\n- a\n- b\n';
    expect(formatYaml(src)).toBe('# top\nimage:\n  repository: nginx # repo\n  tag: "1.0"\nlist:\n- a\n- b\n');
  });

  it('keeps YAML 1.1 octal and refuses changes that would alter data', () => {
    expect(formatYaml('mode: 0755\n')).toBe('mode: 0755\n');
    // Under YAML 1.1 `yes` is a bool; any rewrite to `true` changes the 1.2 reading → refused.
    const out = formatYaml('a: yes\n');
    expect(out === undefined || out === 'a: yes\n').toBe(true);
  });

  it('falls back to whitespace cleanup when re-serializing would move comments', () => {
    // Real pattern from values.yaml files: a comment documenting a key, and section headers.
    const src = 'a:\n  ctx: {}\n    # fsGroup: 2000\n  hosts: [ ]   \n\n\n# ----\n# Section\nb: 1\n';
    expect(formatYaml(src)).toBe('a:\n  ctx: {}\n    # fsGroup: 2000\n  hosts: []\n\n# ----\n# Section\nb: 1\n');
  });

  it('refuses invalid YAML', () => {
    expect(formatYaml('a: [1, 2\n')).toBeUndefined();
  });
});

describe('formatHelmFile', () => {
  it('formats values.schema.json and .helmignore', () => {
    expect(formatHelmFile('schemaJson', '{"a":1}')).toBe('{\n  "a": 1\n}\n');
    expect(formatHelmFile('helmignore', '\n.git  \n\n\n*.tgz\nkeep\\ \n')).toBe('.git\n\n*.tgz\nkeep\\ \n');
  });
});
