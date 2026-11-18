import { isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';

/** One key in a values file. Sequence items contribute the segment `[]`. */
export interface ValueEntry {
  path: string[];
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
  /** Source text of the value, trimmed and truncated for hovers. */
  preview: string;
}

export interface ValuesFile {
  file: string;
  entries: ValueEntry[];
}

export function parseValues(file: string, text: string): ValuesFile {
  const entries: ValueEntry[] = [];
  let doc;
  try {
    doc = parseDocument(text, { version: '1.1', strict: false, uniqueKeys: false });
  } catch {
    return { file, entries };
  }
  const walk = (node: unknown, path: string[]) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key;
        if (!isScalar(key) || !key.range) continue;
        const p = [...path, String(key.value)];
        const v = pair.value as Node | null;
        const vr = v?.range;
        entries.push({
          path: p,
          keyStart: key.range[0],
          keyEnd: key.range[1],
          valueStart: vr ? vr[0] : key.range[1],
          valueEnd: vr ? vr[1] : key.range[1],
          preview: vr ? preview(text.slice(vr[0], vr[1])) : 'null',
        });
        walk(v, p);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item, [...path, '[]']);
    }
  };
  walk(doc.contents, []);
  return { file, entries };
}

function preview(src: string): string {
  const lines = src.replace(/\s+$/, '').split('\n');
  const indent = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length), Infinity);
  const body = lines.map((l, i) => (i > 0 && Number.isFinite(indent) ? l.slice(indent) : l));
  const max = 12;
  return body.length > max ? [...body.slice(0, max), '…'].join('\n') : body.join('\n');
}

/** `*` (from templates) matches any segment; `[]` (from values sequences) matches `*` or `[]`. */
export function segMatch(a: string, b: string): boolean {
  return a === b || a === '*' || b === '*';
}

export function pathEquals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => segMatch(s, b[i]));
}

/** True if `a` is a (non-strict) prefix of `b`. */
export function pathPrefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((s, i) => segMatch(s, b[i]));
}

export function findEntries(vf: ValuesFile | undefined, path: string[]): ValueEntry[] {
  if (!vf) return [];
  return vf.entries.filter((e) => pathEquals(e.path, path));
}

/** Longest prefix of `path` that exists in the values file (for refs deeper than what is declared). */
export function findClosest(vf: ValuesFile | undefined, path: string[]): ValueEntry[] {
  for (let n = path.length; n > 0; n--) {
    const hit = findEntries(vf, path.slice(0, n));
    if (hit.length) return hit;
  }
  return [];
}

export function entryAt(vf: ValuesFile, offset: number): ValueEntry | undefined {
  return vf.entries.find((e) => offset >= e.keyStart && offset <= e.keyEnd);
}
