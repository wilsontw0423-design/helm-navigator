import { scanActions, type Action } from '../templateScanner';

export interface TemplateFormatOptions {
  /** Normalize whitespace inside actions. Never changes rendered output. */
  normalizeActions: boolean;
  /** Re-indent lines that consist only of a `{{- ...}}` action by control nesting depth. */
  indentControlActions: boolean;
  /** Treat the text as YAML: protect block scalars, collapse repeated blank lines. */
  yaml: boolean;
  /** For .tpl: also collapse blank lines (text outside `define` is never rendered). */
  collapseBlankLines: boolean;
}

const OPEN = new Set(['if', 'with', 'range', 'define', 'block']);

/**
 * Conservative formatter for Go-template files (templates/*.yaml, _helpers.tpl, NOTES.txt).
 *
 * Invariant: rendered output is unchanged except for whitespace that YAML ignores. In particular
 * it never changes YAML indentation, and never touches block scalars, comments or string literals.
 */
export function formatTemplate(text: string, opts: TemplateFormatOptions): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let src = text.replace(/\r\n/g, '\n');

  if (opts.normalizeActions) src = normalizeActions(src);

  const actions = scanActions(src);
  const lines = src.split('\n');
  const lineStarts: number[] = [];
  {
    let off = 0;
    for (const l of lines) {
      lineStarts.push(off);
      off += l.length + 1;
    }
  }

  // Lines whose end lies inside a (multi-line) action must not be touched.
  const insideAction = new Array<boolean>(lines.length).fill(false);
  for (const a of actions) {
    for (let i = lineIndexOf(lineStarts, a.start); i < lines.length && lineStarts[i] + lines[i].length < a.end; i++) insideAction[i] = true;
  }

  const protectedLines = opts.yaml ? blockScalarLines(lines, insideAction) : new Array<boolean>(lines.length).fill(false);
  const depthBefore = opts.indentControlActions ? controlDepthPerLine(src, actions, lineStarts, lines.length) : [];

  const out: string[] = [];
  let blankRun = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (protectedLines[i] || insideAction[i]) {
      out.push(line);
      blankRun = 0;
      continue;
    }
    line = line.replace(/[ \t]+$/, '');
    if (line === '') {
      blankRun++;
      if ((opts.yaml || opts.collapseBlankLines) && blankRun > 1) continue;
      out.push(line);
      continue;
    }
    blankRun = 0;
    if (opts.indentControlActions) {
      const sole = soleTrimLeftAction(line);
      if (sole) line = '  '.repeat(Math.max(0, depthBefore[i] - (sole.dedent ? 1 : 0))) + line.trimStart();
    }
    out.push(line);
  }
  while (out.length > 1 && out[out.length - 1] === '' && out[out.length - 2] === '') out.pop();
  let result = out.join('\n');
  if (!result.endsWith('\n')) result += '\n';
  return eol === '\n' ? result : result.replace(/\n/g, eol);
}

/** Rewrites each single-line, non-comment action to `{{ x }}` / `{{- x -}}` with tidy inner spacing. */
export function normalizeActions(src: string): string {
  const actions = scanActions(src);
  let out = '';
  let last = 0;
  for (const a of actions) {
    const inner = src.slice(a.innerStart, a.innerEnd);
    if (a.isComment || inner.includes('\n') || inner.trim() === '') continue;
    const body = tidyInner(inner.trim());
    const rebuilt = '{{' + (a.trimLeft ? '- ' : ' ') + body + (a.trimRight ? ' -' : ' ') + '}}';
    out += src.slice(last, a.start) + rebuilt;
    last = a.end;
  }
  return out + src.slice(last);
}

/** Collapses whitespace runs and spaces `|`, `:=`, `=` — outside string literals only. */
function tidyInner(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === '`' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (c !== '`' && s[j] === '\\') j++;
        j++;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) {
      while (i < s.length && /\s/.test(s[i])) i++;
      out += ' ';
      continue;
    }
    if (c === '|' || (c === ':' && s[i + 1] === '=') || (c === '=' && s[i - 1] !== ':')) {
      const op = c === ':' ? ':=' : c;
      out = out.replace(/ $/, '') + ' ' + op + ' ';
      i += op.length;
      while (i < s.length && /\s/.test(s[i])) i++;
      continue;
    }
    // No padding just inside parentheses.
    if (c === '(') {
      out += c;
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      continue;
    }
    if (c === ')') {
      out = out.replace(/ $/, '');
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out.trim();
}

function lineIndexOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Lines that belong to a YAML block scalar (`key: |`, `- >-`). Their content — including trailing
 * whitespace and blank lines — is significant, so they are left exactly as written.
 */
function blockScalarLines(lines: string[], insideAction: boolean[]): boolean[] {
  const prot = new Array<boolean>(lines.length).fill(false);
  // `key: |`, `key: >-`, `- |2`, optionally followed by a comment.
  const header = /(?::|^\s*-)\s+[|>][-+0-9]*\s*(?:#.*)?$/;
  for (let i = 0; i < lines.length; i++) {
    if (insideAction[i]) continue;
    const stripped = lines[i].replace(/\{\{.*?\}\}/g, 'x');
    if (!header.test(stripped)) continue;
    const baseIndent = lines[i].match(/^ */)![0].length;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') {
        prot[j] = true;
        continue;
      }
      if (l.match(/^ */)![0].length <= baseIndent) break;
      prot[j] = true;
    }
    // Trailing blank lines after the block belong to "clip/keep" chomping; keep them protected.
    i = j - 1;
  }
  return prot;
}

/** If the line is exactly one `{{- ... }}` action, returns whether it closes/continues a block. */
function soleTrimLeftAction(line: string): { dedent: boolean } | undefined {
  const t = line.trim();
  if (!t.startsWith('{{- ') && !t.startsWith('{{-\t')) return undefined;
  const acts = scanActions(t);
  if (acts.length !== 1 || acts[0].start !== 0 || acts[0].end !== t.length) return undefined;
  const word = t.slice(acts[0].innerStart, acts[0].innerEnd).trim().split(/[\s(]/)[0];
  return { dedent: word === 'end' || word === 'else' };
}

/** Control nesting depth at the start of each line (`define` does not add indentation). */
function controlDepthPerLine(src: string, actions: Action[], lineStarts: number[], n: number): number[] {
  const depth = new Array<number>(n).fill(0);
  const stack: string[] = [];
  let ai = 0;
  for (let i = 0; i < n; i++) {
    const lineStart = lineStarts[i];
    while (ai < actions.length && actions[ai].start < lineStart) {
      apply(actions[ai]);
      ai++;
    }
    depth[i] = stack.filter((k) => k !== 'define').length;
  }
  function apply(a: Action) {
    if (a.isComment) return;
    const word = src.slice(a.innerStart, a.innerEnd).trim().split(/[\s(]/)[0];
    if (OPEN.has(word)) stack.push(word);
    else if (word === 'end') stack.pop();
  }
  return depth;
}
