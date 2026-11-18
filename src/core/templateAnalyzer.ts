import { scanActions, tokenize, type Action, type Token } from './templateScanner';

/**
 * Static analysis of a Helm template: which `.Values` paths are referenced (with `with` / `range` /
 * variable scoping), which named templates are defined, and which are included.
 *
 * Path segment `*` means "any child" (range element or dynamic key).
 */
export interface ValuesRef {
  path: string[];
  /** Range of the whole reference expression. */
  start: number;
  end: number;
  /** For each element of `path`, the literal source range if it appears in this expression. */
  segRanges: ({ start: number; end: number } | null)[];
  /** The action also calls `default` / `required` / `empty` / `coalesce` / `hasKey`: a missing key is expected. */
  guarded?: boolean;
}
export interface NameRef {
  name: string;
  /** Range of the string literal including quotes. */
  start: number;
  end: number;
  /** For `include` / `template`: the context passed as the argument, as seen at the call site. */
  arg?: Ctx;
}

/** Resolves the context a named template body runs with; undefined = assume the root context. */
export type DefineContext = (name: string) => Ctx | undefined;
export interface TemplateAnalysis {
  valuesRefs: ValuesRef[];
  defines: NameRef[];
  includes: NameRef[];
  actions: Action[];
}

export type Ctx = { kind: 'root' } | { kind: 'values'; path: string[]; ranges: ({ start: number; end: number } | null)[] } | { kind: 'unknown' };
interface Frame {
  ctx: Ctx;
  vars: Map<string, Ctx>;
}

const GUARDS = new Set(['default', 'required', 'empty', 'coalesce', 'hasKey']);
const ROOT: Ctx = { kind: 'root' };
const UNKNOWN: Ctx = { kind: 'unknown' };

export function analyzeTemplate(src: string, defineCtx?: DefineContext): TemplateAnalysis {
  return run(src, defineCtx).result;
}

export const ROOT_CTX: Ctx = { kind: 'root' };
export const UNKNOWN_CTX: Ctx = { kind: 'unknown' };

/**
 * Context of a named template body from the arguments of all its call sites:
 * no calls or any root call → root; values contexts of equal depth → their common path with
 * differing segments as `*`; only unresolvable arguments (`dict ...`) → unknown.
 */
export function mergeCallContexts(args: Ctx[]): Ctx {
  if (args.length === 0 || args.some((a) => a.kind === 'root')) return ROOT_CTX;
  const vals = args.filter((a): a is Extract<Ctx, { kind: 'values' }> => a.kind === 'values');
  if (vals.length === 0) return UNKNOWN_CTX;
  const n = vals[0].path.length;
  if (vals.some((v) => v.path.length !== n)) return UNKNOWN_CTX;
  const path = vals[0].path.map((seg, i) => (vals.every((v) => v.path[i] === seg) ? seg : '*'));
  return { kind: 'values', path, ranges: path.map(() => null) };
}

/** Scope in effect at `offset` (after every action that ends before it): what `.` and `$x` refer to. */
export interface Scope {
  dot: Ctx;
  lookupVar(name: string): Ctx;
}

export function scopeAt(src: string, offset: number, defineCtx?: DefineContext): Scope {
  // Truncating makes the action under the cursor unterminated, so it is ignored by the scanner.
  const { frames } = run(src.slice(0, offset), defineCtx);
  return {
    dot: frames[frames.length - 1].ctx,
    lookupVar(name: string): Ctx {
      if (name === '$') return ROOT;
      for (let k = frames.length - 1; k >= 0; k--) {
        const v = frames[k].vars.get(name);
        if (v) return v;
      }
      return UNKNOWN;
    },
  };
}

function run(src: string, defineCtx?: DefineContext): { result: TemplateAnalysis; frames: Frame[] } {
  const actions = scanActions(src);
  const result: TemplateAnalysis = { valuesRefs: [], defines: [], includes: [], actions };
  const frames: Frame[] = [{ ctx: ROOT, vars: new Map() }];
  const top = () => frames[frames.length - 1];

  const lookupVar = (name: string): Ctx => {
    for (let k = frames.length - 1; k >= 0; k--) {
      const v = frames[k].vars.get(name);
      if (v) return v;
    }
    return UNKNOWN;
  };

  /** Resolves a chain token to a context and records a values reference when applicable. */
  const resolveChain = (t: Extract<Token, { kind: 'chain' }>, record: boolean): Ctx => {
    let base: Ctx;
    switch (t.base.type) {
      case 'dot':
        base = top().ctx;
        break;
      case 'root':
        base = ROOT;
        break;
      case 'var':
        base = lookupVar(t.base.name);
        break;
      default:
        base = UNKNOWN;
    }
    let ctx: Ctx = base;
    const segs = t.segs;
    let k = 0;
    if (segs.length === 0) return base; // `.`, `$`, `$x`
    if (ctx.kind === 'root') {
      if (segs[0]?.name !== 'Values') return UNKNOWN;
      ctx = { kind: 'values', path: [], ranges: [] };
      k = 1;
    }
    if (ctx.kind !== 'values') return UNKNOWN;
    const path = [...ctx.path];
    // Context-derived prefix segments have no literal range inside this expression.
    const ranges: ({ start: number; end: number } | null)[] = ctx.path.map(() => null);
    for (; k < segs.length; k++) {
      path.push(segs[k].name);
      ranges.push({ start: segs[k].start, end: segs[k].end });
    }
    if (record && path.length > 0 && (k > 0 || segs.length > 0)) {
      result.valuesRefs.push({ path, start: t.start, end: t.end, segRanges: ranges });
    }
    return { kind: 'values', path, ranges };
  };

  /** Context produced by an expression: first chain, or `index <chain> "k" ...`. */
  const exprCtx = (toks: Token[]): Ctx => {
    let i = 0;
    while (toks[i]?.kind === 'punct' && (toks[i] as { text: string }).text === '(') i++;
    const t = toks[i];
    if (!t) return UNKNOWN;
    if (t.kind === 'chain') return resolveChain(t, false);
    if (t.kind === 'ident' && t.text === 'index' && toks[i + 1]?.kind === 'chain') {
      return indexCtx(toks, i, false);
    }
    return UNKNOWN;
  };

  const indexCtx = (toks: Token[], i: number, record: boolean): Ctx => {
    const chain = toks[i + 1] as Extract<Token, { kind: 'chain' }>;
    const c = resolveChain(chain, false);
    if (c.kind !== 'values') return UNKNOWN;
    const path = [...c.path];
    const ranges = [...c.ranges];
    let j = i + 2;
    let end = chain.end;
    for (; j < toks.length; j++) {
      const a = toks[j];
      if (a.kind === 'string') {
        path.push(a.value);
        ranges.push({ start: a.start + 1, end: a.end - 1 });
      } else if (a.kind === 'number') {
        path.push('*');
        ranges.push({ start: a.start, end: a.end });
      } else break;
      end = a.end;
    }
    if (record && path.length > 0) result.valuesRefs.push({ path, start: chain.start, end, segRanges: ranges });
    return { kind: 'values', path, ranges };
  };

  const elem = (c: Ctx): Ctx => (c.kind === 'values' ? { kind: 'values', path: [...c.path, '*'], ranges: [...c.ranges, null] } : UNKNOWN);

  for (const a of actions) {
    if (a.isComment) continue;
    const toks = tokenize(src, a.innerStart, a.innerEnd);
    if (toks.length === 0) continue;

    // Record references, includes.
    const refsBefore = result.valuesRefs.length;
    const indexed = new Set<number>();
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind === 'ident' && t.text === 'index' && toks[i + 1]?.kind === 'chain') {
        indexCtx(toks, i, true);
        indexed.add(i + 1);
      } else if (t.kind === 'ident' && (t.text === 'include' || t.text === 'template') && toks[i + 1]?.kind === 'string') {
        const s = toks[i + 1] as Extract<Token, { kind: 'string' }>;
        result.includes.push({ name: s.value, start: s.start, end: s.end, arg: exprCtx(toks.slice(i + 2)) });
      }
    }
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind === 'chain' && !indexed.has(i)) resolveChain(t, true);
    }
    if (toks.some((t) => t.kind === 'ident' && GUARDS.has(t.text))) {
      for (let k = refsBefore; k < result.valuesRefs.length; k++) result.valuesRefs[k].guarded = true;
    }

    // Control flow.
    const first = toks[0];
    const kw = first.kind === 'ident' ? first.text : '';
    const rest = toks.slice(1);
    switch (kw) {
      case 'end':
        if (frames.length > 1) frames.pop();
        break;
      case 'if':
        frames.push({ ctx: top().ctx, vars: new Map() });
        break;
      case 'else':
        if (rest[0]?.kind === 'ident' && rest[0].text === 'with') {
          const decl = parseDecl(rest.slice(1));
          const c = exprCtx(decl.expr);
          top().ctx = c;
          if (decl.vars[0]) top().vars.set(decl.vars[0], c);
        }
        break;
      case 'with': {
        const decl = parseDecl(rest);
        const c = exprCtx(decl.expr);
        const f: Frame = { ctx: c, vars: new Map() };
        if (decl.vars[0]) f.vars.set(decl.vars[0], c);
        frames.push(f);
        break;
      }
      case 'range': {
        const decl = parseDecl(rest);
        const c = elem(exprCtx(decl.expr));
        const f: Frame = { ctx: c, vars: new Map() };
        if (decl.vars.length === 1) f.vars.set(decl.vars[0], c);
        if (decl.vars.length === 2) {
          f.vars.set(decl.vars[0], UNKNOWN);
          f.vars.set(decl.vars[1], c);
        }
        frames.push(f);
        break;
      }
      case 'define':
      case 'block': {
        const s = rest[0];
        if (s?.kind === 'string') result.defines.push({ name: s.value, start: s.start, end: s.end });
        // The body's `.` is what callers pass (resolved across the chart tree by HelmIndex); root by default.
        const ctx = kw === 'block' ? exprCtx(rest.slice(1)) : ((s?.kind === 'string' && defineCtx?.(s.value)) || ROOT);
        frames.push({ ctx, vars: new Map() });
        break;
      }
      default:
        // `$x := expr` / `$x = expr`
        if (first.kind === 'chain' && first.base.type === 'var' && first.segs.length === 0 && toks[1]?.kind === 'punct' && (toks[1].text === ':=' || toks[1].text === '=')) {
          const c = exprCtx(toks.slice(2));
          if (toks[1].text === ':=') top().vars.set(first.base.name, c);
          else {
            // assignment updates the nearest declaring frame
            let set = false;
            for (let k = frames.length - 1; k >= 0 && !set; k--) {
              if (frames[k].vars.has(first.base.name)) {
                frames[k].vars.set(first.base.name, c);
                set = true;
              }
            }
            if (!set) top().vars.set(first.base.name, c);
          }
        }
    }
  }
  return { result, frames };
}

/** Parses `$a := expr`, `$a, $b := expr`, or plain `expr`. */
function parseDecl(toks: Token[]): { vars: string[]; expr: Token[] } {
  const idx = toks.findIndex((t) => t.kind === 'punct' && t.text === ':=');
  if (idx < 0) return { vars: [], expr: toks };
  const vars: string[] = [];
  for (const t of toks.slice(0, idx)) {
    if (t.kind === 'chain' && t.base.type === 'var' && t.segs.length === 0) vars.push(t.base.name);
  }
  return { vars, expr: toks.slice(idx + 1) };
}
