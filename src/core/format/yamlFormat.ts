import { isDeepStrictEqual } from 'node:util';
import { isScalar, parseAllDocuments, visit } from 'yaml';

/**
 * Formats a pure YAML file (Chart.yaml, values.yaml, ...).
 *
 * Strategy:
 *  1. Full re-serialization with 2-space indentation, accepted only if
 *     - the parsed data is identical under YAML 1.1 (Helm's go-yaml) and YAML 1.2, and
 *     - every comment keeps its kind (own line vs end of line) and its alignment relative to the
 *       surrounding content lines. values.yaml comments are documentation; the YAML library
 *       re-attaches some of them to the wrong node, which this check detects.
 *  2. Otherwise a whitespace-only cleanup (trailing whitespace, repeated blank lines, empty
 *     flow collections), again accepted only if the data is unchanged.
 * Returns undefined when neither is safe (e.g. the file does not parse).
 */
export function formatYaml(text: string): string | undefined {
  const docs = parseAllDocuments(text, { version: '1.1' });
  if (!Array.isArray(docs)) return undefined; // empty stream
  if (docs.some((d) => d.errors.length)) return undefined;
  // `key: {{ .x }}` (unquoted template syntax) parses as a mapping with a collection key. go-yaml
  // rejects it, and the yaml library stringifies such keys, so the data check could not see a rewrite.
  if (docs.some(hasCollectionKey)) return undefined;
  const src = text.replace(/\r\n/g, '\n');

  const indentSeq = detectIndentedSequences(src);
  let full = docs.map((d) => d.toString({ indent: 2, indentSeq, lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false })).join('');
  if (!full.endsWith('\n')) full += '\n';
  if (sameData(src, full) && isDeepStrictEqual(commentShape(src), commentShape(full))) return full;

  const light = cleanupWhitespace(src);
  return sameData(src, light) ? light : undefined;
}

function hasCollectionKey(doc: Parameters<typeof visit>[0]): boolean {
  let found = false;
  visit(doc, {
    Pair(_, pair) {
      if (pair.key != null && !isScalar(pair.key)) {
        found = true;
        return visit.BREAK;
      }
    },
  });
  return found;
}

function sameData(a: string, b: string): boolean {
  return (['1.1', '1.2'] as const).every((v) => isDeepStrictEqual(toJs(a, v), toJs(b, v)));
}

function toJs(text: string, version: '1.1' | '1.2'): unknown {
  try {
    const docs = parseAllDocuments(text, { version });
    if (!Array.isArray(docs)) return [];
    return docs.map((d) => [d.errors.length, d.toJS({ maxAliasCount: -1 })]);
  } catch (e) {
    return { error: String(e) };
  }
}

/** Lines that are inside a block scalar (`key: |`), where whitespace is content. */
function blockScalarLines(lines: string[]): boolean[] {
  const prot = new Array<boolean>(lines.length).fill(false);
  const header = /(?::|^\s*-)\s+[|>][-+0-9]*\s*(?:#.*)?$/;
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue;
    const base = lines[i].match(/^ */)![0].length;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim() !== '' && lines[j].match(/^ */)![0].length <= base) break;
      prot[j] = true;
    }
    i = j - 1;
  }
  return prot;
}

/**
 * For each comment: own-line or trailing, and for own-line comments how its column compares to
 * the previous and next content line. Stable under re-indentation, sensitive to re-attachment.
 */
function commentShape(text: string): string[] {
  const lines = text.split('\n');
  const prot = blockScalarLines(lines);
  const col = (l: string) => l.match(/^ */)![0].length;
  const isContent = (i: number) => !prot[i] && lines[i].trim() !== '' && !lines[i].trim().startsWith('#');
  const cmp = (a: number, b: number | undefined) => (b === undefined ? 'none' : a < b ? 'lt' : a > b ? 'gt' : 'eq');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (prot[i]) continue;
    const t = lines[i].trim();
    if (t.startsWith('#')) {
      let p = i - 1;
      while (p >= 0 && !isContent(p)) p--;
      let n = i + 1;
      while (n < lines.length && !isContent(n)) n++;
      const c = col(lines[i]);
      out.push(`own:${cmp(c, p >= 0 ? col(lines[p]) : undefined)}:${cmp(c, n < lines.length ? col(lines[n]) : undefined)}:${t}`);
    } else {
      const m = trailingComment(lines[i]);
      if (m) out.push(`eol:${m}`);
    }
  }
  return out;
}

/** The trailing `# comment` of a content line, ignoring `#` inside quotes. */
function trailingComment(line: string): string | undefined {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(i).trim();
  }
  return undefined;
}

/** Whitespace-only cleanup that never moves comments or changes indentation. */
function cleanupWhitespace(src: string): string {
  const lines = src.split('\n');
  const prot = blockScalarLines(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (prot[i]) {
      out.push(lines[i]);
      continue;
    }
    let l = lines[i].replace(/[ \t]+$/, '');
    if (!l.trim().startsWith('#')) l = l.replace(/(:\s+)\{\s+\}(\s*(#.*)?)$/, '$1{}$2').replace(/(:\s+)\[\s+\](\s*(#.*)?)$/, '$1[]$2');
    if (l === '' && out[out.length - 1] === '' && !prot[i - 1]) continue;
    out.push(l);
  }
  while (out.length > 1 && out[out.length - 1] === '' && out[out.length - 2] === '') out.pop();
  let r = out.join('\n');
  if (!r.endsWith('\n')) r += '\n';
  return r;
}

/**
 * Keeps the file's existing sequence style: `key:\n  - a` (indented) vs `key:\n- a` (not indented).
 * Decided by the first block sequence that follows a mapping key.
 */
function detectIndentedSequences(text: string): boolean {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(/^(\s*)[^\s#-][^#]*:\s*(#.*)?$/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
    const n = lines[j]?.match(/^(\s*)- /);
    if (n) return n[1].length > m[1].length;
  }
  return true;
}
