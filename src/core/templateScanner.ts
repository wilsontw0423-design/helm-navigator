/**
 * Splits a Go-template source into actions (`{{ ... }}`), following text/template lexing rules:
 *  - `{{- ` / ` -}}` are trim markers only when followed/preceded by whitespace.
 *  - Comments are `{{/* ... *\/}}` or `{{- /* ... *\/ -}}` and may contain `}}`.
 *  - String literals ("...", `...`, '.') may contain `}}`.
 */
export interface Action {
  /** Offset of `{{`. */
  start: number;
  /** Offset just after `}}`. */
  end: number;
  /** Content between delimiters and trim markers. */
  innerStart: number;
  innerEnd: number;
  trimLeft: boolean;
  trimRight: boolean;
  isComment: boolean;
}

const WS = /[ \t\r\n]/;

export function scanActions(src: string): Action[] {
  const out: Action[] = [];
  let i = 0;
  for (;;) {
    const start = src.indexOf('{{', i);
    if (start < 0) break;
    let p = start + 2;
    let trimLeft = false;
    if (src[p] === '-' && WS.test(src[p + 1] ?? '')) {
      trimLeft = true;
      p += 1;
    }

    // Comment: `{{/*` directly, or `{{- ` + spaces + `/*`.
    let q = p;
    if (trimLeft) while (q < src.length && WS.test(src[q])) q++;
    if (src.startsWith('/*', q)) {
      const cEnd = src.indexOf('*/', q + 2);
      if (cEnd < 0) break;
      let r = cEnd + 2;
      let trimRight = false;
      let rr = r;
      while (rr < src.length && WS.test(src[rr])) rr++;
      if (src[rr] === '-' && src.startsWith('}}', rr + 1) && rr > r) {
        trimRight = true;
        r = rr + 1;
      }
      if (!src.startsWith('}}', r)) {
        i = start + 2;
        continue;
      }
      out.push({ start, end: r + 2, innerStart: p, innerEnd: cEnd + 2, trimLeft, trimRight, isComment: true });
      i = r + 2;
      continue;
    }

    let j = p;
    let quote: string | null = null;
    while (j < src.length) {
      const c = src[j];
      if (quote) {
        if (quote !== '`' && c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if (c === '"' || c === '`' || c === "'") {
        quote = c;
        j++;
        continue;
      }
      if (c === '}' && src[j + 1] === '}') break;
      j++;
    }
    if (j >= src.length) break; // unterminated action
    let innerEnd = j;
    let trimRight = false;
    if (src[j - 1] === '-' && WS.test(src[j - 2] ?? '') && j - 1 > p) {
      trimRight = true;
      innerEnd = j - 1;
    }
    out.push({ start, end: j + 2, innerStart: p, innerEnd, trimLeft, trimRight, isComment: false });
    i = j + 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokenizer for the inside of an action.

export type Token =
  | { kind: 'string'; start: number; end: number; value: string }
  | { kind: 'number'; start: number; end: number; text: string }
  | { kind: 'ident'; start: number; end: number; text: string }
  | { kind: 'punct'; start: number; end: number; text: string }
  | { kind: 'chain'; start: number; end: number; base: ChainBase; segs: Seg[] };

/** `dot` = `.x`, `root` = `$.x`, `var` = `$name.x`, `expr` = `(…).x` (unresolvable). */
export type ChainBase = { type: 'dot' } | { type: 'root' } | { type: 'var'; name: string } | { type: 'expr' };
export interface Seg {
  name: string;
  start: number;
  end: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT = /[A-Za-z0-9_]/;

/** Tokenizes `src.slice(from, to)`; offsets in the result are absolute. Whitespace is dropped. */
export function tokenize(src: string, from: number, to: number): Token[] {
  const toks: Token[] = [];
  let i = from;
  while (i < to) {
    const c = src[i];
    if (WS.test(c)) {
      i++;
      continue;
    }
    const prevAdjacent = i > from && !WS.test(src[i - 1]);
    if (c === '"' || c === '`' || c === "'") {
      let j = i + 1;
      while (j < to && src[j] !== c) {
        if (c !== '`' && src[j] === '\\') j++;
        j++;
      }
      const raw = src.slice(i + 1, Math.min(j, to));
      toks.push({ kind: 'string', start: i, end: Math.min(j + 1, to), value: c === '`' ? raw : unescape(raw) });
      i = j + 1;
      continue;
    }
    if (c === '$' || (c === '.' && (IDENT_START.test(src[i + 1] ?? '') || !IDENT.test(src[i + 1] ?? '')))) {
      const start = i;
      let base: ChainBase;
      if (c === '$') {
        let j = i + 1;
        while (j < to && IDENT.test(src[j])) j++;
        const name = src.slice(i + 1, j);
        base = name ? { type: 'var', name } : { type: 'root' };
        i = j;
      } else {
        const prev = toks[toks.length - 1];
        base = prevAdjacent && prev && (prev.kind === 'punct' ? prev.text === ')' : prev.kind !== 'chain') ? { type: 'expr' } : { type: 'dot' };
      }
      const segs: Seg[] = [];
      while (i < to && src[i] === '.' && IDENT_START.test(src[i + 1] ?? '')) {
        let j = i + 1;
        while (j < to && IDENT.test(src[j])) j++;
        segs.push({ name: src.slice(i + 1, j), start: i + 1, end: j });
        i = j;
      }
      if (c === '.' && segs.length === 0) i++; // bare dot
      toks.push({ kind: 'chain', start, end: i, base, segs });
      continue;
    }
    if (/[0-9]/.test(c) || ((c === '-' || c === '+') && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < to && /[0-9A-Za-z_.+-]/.test(src[j])) j++;
      toks.push({ kind: 'number', start: i, end: j, text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < to && IDENT.test(src[j])) j++;
      toks.push({ kind: 'ident', start: i, end: j, text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === ':' && src[i + 1] === '=') {
      toks.push({ kind: 'punct', start: i, end: i + 2, text: ':=' });
      i += 2;
      continue;
    }
    toks.push({ kind: 'punct', start: i, end: i + 1, text: c });
    i++;
  }
  return toks;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, ch: string) => ({ n: '\n', t: '\t', r: '\r' })[ch as 'n'] ?? ch);
}
