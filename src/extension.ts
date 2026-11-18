import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PackagedChartCache } from './core/archive';
import { completeValues } from './core/completion';
import { templateFindings, valuesFindings, type Finding } from './core/diagnostics';
import { planRename, VALID_KEY } from './core/rename';
import { registerRender } from './render';
import { classify, formatHelmFile, type FormatOptions } from './core/format';
import type { Chart } from './core/chartGraph';
import { HelmIndex, type ChainItem, type FileRange } from './core/helmIndex';
import { LineIndex, NodeHost, norm } from './core/host';
import { entryAt } from './core/valuesFile';

/** Disk access with unsaved editor buffers overlaid. */
class EditorHost extends NodeHost {
  private doc(file: string): vscode.TextDocument | undefined {
    const n = norm(file);
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && norm(d.uri.fsPath) === n);
  }
  override readFile(file: string): string | undefined {
    return this.doc(file)?.getText() ?? super.readFile(file);
  }
  override version(file: string): string {
    const d = this.doc(file);
    return d ? `doc:${d.version}:${super.version(file)}` : super.version(file);
  }
}

let index: HelmIndex;

/** Languages this extension serves (navigation, completion, rename, formatting). */
const HELM_LANGUAGES = ['helm-template', 'helm-values', 'yaml'];
/** Languages `assignLanguage` may switch away from (it never overrides e.g. JSON or a manual choice of another language). */
const SWITCHABLE = new Set(['yaml', 'helm-template', 'helm-values', 'helm', 'plaintext']);

function desiredLanguage(doc: vscode.TextDocument): string | undefined {
  if (doc.uri.scheme !== 'file' || !SWITCHABLE.has(doc.languageId)) return undefined;
  const file = doc.uri.fsPath;
  const chart = index.graph.chartForFile(file);
  if (!chart) return /\.ya?ml$/i.test(file) && (doc.languageId === 'helm-template' || doc.languageId === 'helm-values') ? 'yaml' : undefined;
  if (!vscode.workspace.getConfiguration('helmNavigator').get<boolean>('assignLanguages', true)) return undefined;
  if (index.isValuesFile(file)) return 'helm-values';
  if (isTemplateFile(file)) return 'helm-template';
  return undefined;
}

function assignLanguage(doc: vscode.TextDocument): void {
  const want = desiredLanguage(doc);
  if (want && want !== doc.languageId) void vscode.languages.setTextDocumentLanguage(doc, want);
}

function dedupeRanges(xs: FileRange[]): FileRange[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${norm(x.file)}:${x.start}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/** Outline of a values file (Helm Values files are not served by the YAML language server). */
function provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
  const vf = index.valuesFile(doc.uri.fsPath);
  if (!vf) return [];
  const roots: vscode.DocumentSymbol[] = [];
  const stack: { path: string[]; sym: vscode.DocumentSymbol }[] = [];
  for (const e of vf.entries) {
    const keyPath = e.path.filter((s) => s !== '[]');
    const isMap = vf.entries.some((x) => x.path.length > e.path.length && x.path.slice(0, e.path.length).every((s, i) => s === e.path[i]));
    const range = new vscode.Range(doc.positionAt(e.keyStart), doc.positionAt(Math.max(e.valueEnd, e.keyEnd)));
    const sym = new vscode.DocumentSymbol(
      keyPath[keyPath.length - 1],
      isMap ? '' : e.preview.split('\n')[0],
      isMap ? vscode.SymbolKind.Module : vscode.SymbolKind.Field,
      range,
      new vscode.Range(doc.positionAt(e.keyStart), doc.positionAt(e.keyEnd)),
    );
    while (stack.length && !(stack[stack.length - 1].path.length < keyPath.length && stack[stack.length - 1].path.every((s, i) => s === keyPath[i]))) stack.pop();
    (stack.length ? stack[stack.length - 1].sym.children : roots).push(sym);
    stack.push({ path: keyPath, sym });
  }
  return roots;
}

/**
 * Whether a file is a chart template, decided by its path (`templates/**`, `*.tpl`), not its language
 * id: `files.associations` may map templates to `yaml` or values files to `helm-template`.
 */
function isTemplateFile(file: string): boolean {
  const kind = classify(file);
  return (kind === 'templateYaml' || kind === 'tpl' || kind === 'notes') && !index.isValuesFile(file);
}
const lineIndexCache = new Map<string, { v: string; li: LineIndex }>();

function toLocation(r: FileRange): vscode.Location {
  const v = index.host.version(r.file);
  let hit = lineIndexCache.get(r.file);
  if (!hit || hit.v !== v) {
    hit = { v, li: new LineIndex(index.host.readFile(r.file) ?? '') };
    lineIndexCache.set(r.file, hit);
  }
  const s = hit.li.position(r.start);
  const e = hit.li.position(r.end);
  return new vscode.Location(vscode.Uri.file(r.file), new vscode.Range(s.line, s.character, e.line, e.character));
}

/** `helmNavigator.environments`, keeping only well-formed entries. */
function readEnvironments(): Record<string, string[]> {
  const raw = vscode.workspace.getConfiguration('helmNavigator').get<Record<string, unknown>>('environments', {});
  const out: Record<string, string[]> = {};
  for (const [name, files] of Object.entries(raw ?? {})) {
    if (Array.isArray(files)) out[name] = files.filter((f): f is string => typeof f === 'string');
  }
  return out;
}

function readConfig(): FormatOptions {
  const c = vscode.workspace.getConfiguration('helmNavigator.format');
  return {
    yaml: c.get('yaml', true),
    normalizeActions: c.get('normalizeActions', true),
    tplIndentControlActions: c.get('tplIndentControlActions', true),
    templateIndentControlActions: c.get('templateIndentControlActions', false),
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const packages = new PackagedChartCache(path.join(context.globalStorageUri.fsPath, 'packaged-charts'));
  const cfg = vscode.workspace.getConfiguration('helmNavigator');
  index = new HelmIndex(new EditorHost(), cfg.get('valuesFiles', ['values.yaml']), packages, readEnvironments());

  const scan = async () => {
    index.graph.clear();
    const files = await vscode.workspace.findFiles('**/{Chart.yaml,requirements.yaml}', '**/node_modules/**');
    index.graph.addChartFiles(files.filter((f) => f.fsPath.endsWith('Chart.yaml')).map((f) => f.fsPath));
  };
  await scan();

  let timer: NodeJS.Timeout | undefined;
  const rescan = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 300);
  };
  for (const glob of ['**/{Chart.yaml,requirements.yaml}', '**/charts/*.tgz']) {
    const watcher = vscode.workspace.createFileSystemWatcher(glob);
    watcher.onDidChange(rescan);
    watcher.onDidCreate(rescan);
    watcher.onDidDelete(rescan);
    context.subscriptions.push(watcher);
  }

  // Call contexts of `define`s depend on every template in the tree: recompute after any change.
  const templatesWatcher = vscode.workspace.createFileSystemWatcher('**/templates/**');
  templatesWatcher.onDidChange(() => index.touch());
  templatesWatcher.onDidCreate(() => index.touch());
  templatesWatcher.onDidDelete(() => index.touch());
  context.subscriptions.push(
    templatesWatcher,
    vscode.workspace.onDidChangeTextDocument((e) => e.document.uri.scheme === 'file' && isTemplateFile(e.document.uri.fsPath) && index.touch()),
  );

  // Files unpacked from charts/*.tgz are a cache: edits there would be silently lost.
  const markReadonly = (editor: vscode.TextEditor | undefined) => {
    if (editor?.document.uri.scheme === 'file' && packages.contains(editor.document.uri.fsPath)) {
      void vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
    }
  };
  markReadonly(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(markReadonly));

  context.subscriptions.push(
    vscode.commands.registerCommand('helmNavigator.reindex', async () => {
      await scan();
      vscode.window.setStatusBarMessage(`Helm Navigator: indexed ${index.graph.all.length} chart(s)`, 3000);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('helmNavigator.valuesFiles')) {
        index.valuesFileNames = vscode.workspace.getConfiguration('helmNavigator').get('valuesFiles', ['values.yaml']);
      }
      if (e.affectsConfiguration('helmNavigator.environments')) index.environments = readEnvironments();
    }),
  );

  // Language by chart membership (files.associations can only match paths): templates → helm-template,
  // values files → helm-values; files outside charts that a path pattern gave a Helm language → yaml.
  const assignAll = () => vscode.workspace.textDocuments.forEach(assignLanguage);
  assignAll();
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(assignLanguage));

  // Values files are discovered inside chart directories; refresh when such files come and go.
  const valuesWatcher = vscode.workspace.createFileSystemWatcher('**/*values*.{yaml,yml}');
  const valuesChanged = () => {
    index.touchValuesFiles();
    assignAll();
  };
  valuesWatcher.onDidCreate(valuesChanged);
  valuesWatcher.onDidDelete(valuesChanged);
  context.subscriptions.push(
    valuesWatcher,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('helmNavigator.assignLanguages') || e.affectsConfiguration('helmNavigator.environments') || e.affectsConfiguration('helmNavigator.valuesFiles')) assignAll();
    }),
  );

  const navSel: vscode.DocumentFilter[] = HELM_LANGUAGES.map((language) => ({ scheme: 'file', language }));

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(navSel, { provideDefinition }),
    vscode.languages.registerReferenceProvider(navSel, { provideReferences }),
    vscode.languages.registerHoverProvider(navSel, { provideHover }),
    vscode.languages.registerCompletionItemProvider(navSel, { provideCompletionItems }, '.'),
    vscode.languages.registerRenameProvider(navSel, { prepareRename, provideRenameEdits }),
    vscode.languages.registerDocumentSymbolProvider({ scheme: 'file', language: 'helm-values' }, { provideDocumentSymbols }),
  );

  const formatter: vscode.DocumentFormattingEditProvider = {
    provideDocumentFormattingEdits(doc) {
      // Any other YAML (CI files, raw manifests) gets the same data-guarded YAML formatter, so
      // Helm Navigator can be the default `[yaml]` formatter of a Helm project without gaps.
      const kind = classify(doc.uri.fsPath) ?? (['yaml', 'helm-template', 'helm-values'].includes(doc.languageId) ? 'yaml' : undefined);
      if (!kind) return [];
      const text = doc.getText();
      const out = formatHelmFile(kind, text, readConfig());
      if (out === undefined) {
        if (kind === 'yaml') vscode.window.setStatusBarMessage('Helm Navigator: formatting skipped (YAML does not parse, or the result would change data)', 4000);
        return [];
      }
      if (out === text) return [];
      return [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), out)];
    },
  };
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      [
        { scheme: 'file', language: 'helm-template' },
        { scheme: 'file', language: 'helmignore' },
        { scheme: 'file', language: 'yaml' },
        { scheme: 'file', language: 'helm-values' },
        { scheme: 'file', pattern: '**/values.schema.json' },
      ],
      formatter,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('helmNavigator.useAsDefaultFormatter', () => setWorkspaceDefaults(true)),
    vscode.commands.registerCommand(PEEK_COMMAND, peekFromHover),
  );
  registerDiagnostics(context);
  registerRender(context, () => index, isTemplateFile);
  void offerWorkspaceDefaults(context);
}

const EXTENSION_ID = 'local.helm-navigator';
/** Languages whose formatter is switched to Helm Navigator inside a Helm project. */
const FORMATTED_LANGUAGES = ['yaml', 'helm-template', 'helm-values', 'helmignore'];

function isDefaultEverywhere(): boolean {
  return FORMATTED_LANGUAGES.every(
    (languageId) => vscode.workspace.getConfiguration('editor', { languageId }).get<string>('defaultFormatter') === EXTENSION_ID,
  );
}

/** Writes `[yaml]` / `[helm-template]` / `[helmignore]` defaultFormatter into the workspace settings. */
async function setWorkspaceDefaults(notify: boolean): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showWarningMessage('Helm Navigator: open a folder first.');
    return;
  }
  for (const languageId of FORMATTED_LANGUAGES) {
    await vscode.workspace
      .getConfiguration('editor', { languageId })
      .update('defaultFormatter', EXTENSION_ID, vscode.ConfigurationTarget.Workspace, true);
  }
  if (notify) void vscode.window.showInformationMessage('Helm Navigator is now the default formatter for YAML and Helm files in this workspace (.vscode/settings.json).');
}

/**
 * In a workspace that contains a Helm chart, make Helm Navigator the default formatter.
 * `helmNavigator.autoSetDefaultFormatter`: "ask" (default) | "always" | "never".
 */
async function offerWorkspaceDefaults(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length || index.graph.all.length === 0 || isDefaultEverywhere()) return;
  const mode = vscode.workspace.getConfiguration('helmNavigator').get<string>('autoSetDefaultFormatter', 'ask');
  if (mode === 'never') return;
  if (mode === 'always') return setWorkspaceDefaults(false);
  if (context.workspaceState.get<boolean>('helmNavigator.declinedDefaultFormatter')) return;
  const yes = 'Use Helm Navigator';
  const always = 'Always for Helm projects';
  const no = "Don't ask again here";
  const pick = await vscode.window.showInformationMessage('This workspace contains a Helm chart. Use Helm Navigator as the default formatter for YAML and Helm files here?', yes, always, no);
  if (pick === yes) await setWorkspaceDefaults(true);
  else if (pick === always) {
    await vscode.workspace.getConfiguration('helmNavigator').update('autoSetDefaultFormatter', 'always', vscode.ConfigurationTarget.Global);
    await setWorkspaceDefaults(true);
  } else if (pick === no) await context.workspaceState.update('helmNavigator.declinedDefaultFormatter', true);
}

export function deactivate(): void {}

// ------------------------------------------------------------------ diagnostics

/** Undefined `.Values` keys (warning) and unused values keys (hint) for every open chart file. */
function registerDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('helm-navigator');
  const enabled = () => vscode.workspace.getConfiguration('helmNavigator').get<boolean>('diagnostics.enabled', true);

  const findingsFor = (doc: vscode.TextDocument): Finding[] => {
    if (doc.uri.scheme !== 'file') return [];
    const file = doc.uri.fsPath;
    const chart = index.graph.chartForFile(file);
    if (!chart) return [];
    if (index.isValuesFile(file)) return valuesFindings(index, chart, file);
    if (isTemplateFile(file)) return templateFindings(index, chart, file);
    return [];
  };
  const toDiagnostic = (f: Finding): vscode.Diagnostic => {
    const loc = toLocation(f);
    const d = new vscode.Diagnostic(loc.range, f.message, f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint);
    d.source = 'helm-navigator';
    d.code = f.code;
    if (f.code === 'unused-value') d.tags = [vscode.DiagnosticTag.Unnecessary];
    return d;
  };
  const refresh = () => {
    collection.clear();
    if (!enabled()) return;
    for (const doc of vscode.workspace.textDocuments) {
      try {
        const fs_ = findingsFor(doc);
        if (fs_.length) collection.set(doc.uri, fs_.map(toDiagnostic));
      } catch (e) {
        console.error('helm-navigator diagnostics failed for', doc.uri.fsPath, e);
      }
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 400);
  };
  schedule();
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    vscode.workspace.onDidChangeTextDocument((e) => e.document.uri.scheme === 'file' && /\.(ya?ml|tpl|txt)$/.test(e.document.fileName) && schedule()),
    vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('helmNavigator') && schedule()),
    { dispose: () => clearTimeout(timer) },
  );
}

// ------------------------------------------------------------------ providers

function provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location[] | undefined {
  const file = doc.uri.fsPath;
  const chart = index.graph.chartForFile(file);
  if (!chart) return;
  const offset = doc.offsetAt(pos);

  if (isTemplateFile(file)) {
    const a = index.analysis(file);
    if (!a) return;
    const inc = [...a.includes, ...a.defines].find((r) => offset >= r.start && offset <= r.end);
    if (inc) return index.findDefines(chart, inc.name).map(toLocation);
    const p = valuesPathAt(file, offset);
    if (p) {
      const chain = index.overrideChain(chart, p);
      const locs = chain.flatMap((c) => c.entries.map((e) => toLocation({ file: c.file, start: e.keyStart, end: e.keyEnd })));
      if (locs.length) return locs;
      // Not declared at this depth: fall back to the closest declared parent key.
      for (let n = p.length - 1; n > 0; n--) {
        const up = index.overrideChain(chart, p.slice(0, n)).flatMap((c) => c.entries.map((e) => toLocation({ file: c.file, start: e.keyStart, end: e.keyEnd })));
        if (up.length) return up;
      }
    }
    return;
  }

  // Chart.yaml / requirements.yaml: dependency → subchart.
  const base = path.basename(file);
  if (base === 'Chart.yaml' || base === 'requirements.yaml') {
    const dep = dependencyAt(doc, pos, chart);
    if (dep) return [dep];
    return;
  }

  // values file: key → subchart default and/or parent overrides.
  if (index.isValuesFile(file)) {
    const vf = index.valuesFile(file);
    const entry = vf && entryAt(vf, offset);
    if (!entry) return;
    // From a values key, jump to where templates read it (also through subchart aliases and `global.*`).
    // Other values files that set the key are listed in the hover.
    const locs = dedupeRanges(index.templateRefsForKey(chart, entry.path));
    // No template reads it: return the key itself, so VS Code falls back to Find References.
    return (locs.length ? locs : [{ file, start: entry.keyStart, end: entry.keyEnd }]).map(toLocation);
  }
  return;
}

function provideReferences(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.ReferenceContext): vscode.Location[] | undefined {
  const file = doc.uri.fsPath;
  const chart = index.graph.chartForFile(file);
  if (!chart) return;
  const offset = doc.offsetAt(pos);

  if (isTemplateFile(file)) {
    const a = index.analysis(file);
    if (!a) return;
    const name = [...a.includes, ...a.defines].find((r) => offset >= r.start && offset <= r.end)?.name;
    if (name) {
      const refs = index.findIncludes(chart, name);
      if (ctx.includeDeclaration) refs.push(...index.findDefines(chart, name));
      return refs.map(toLocation);
    }
    const p = valuesPathAt(file, offset);
    if (!p) return;
    const out: FileRange[] = index.templateRefsExact(chart, p);
    if (ctx.includeDeclaration) {
      for (const c of index.overrideChain(chart, p)) for (const e of c.entries) out.push({ file: c.file, start: e.keyStart, end: e.keyEnd });
    }
    return out.map(toLocation);
  }

  if (index.isValuesFile(file)) {
    const vf = index.valuesFile(file);
    const entry = vf && entryAt(vf, offset);
    if (!entry) return;
    const out: FileRange[] = index.templateRefsForKey(chart, entry.path);
    if (ctx.includeDeclaration) out.push({ file, start: entry.keyStart, end: entry.keyEnd });
    return out.map(toLocation);
  }
  return;
}

function provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
  const file = doc.uri.fsPath;
  const chart = index.graph.chartForFile(file);
  if (!chart) return;
  const offset = doc.offsetAt(pos);

  if (index.isValuesFile(file)) {
    const vf = index.valuesFile(file);
    const entry = vf && entryAt(vf, offset);
    if (!entry) return;
    return valuesKeyHover(chart, entry.path, new vscode.Range(doc.positionAt(entry.keyStart), doc.positionAt(entry.keyEnd)), { file, offset: entry.keyStart });
  }
  if (!isTemplateFile(file)) return;
  const hit = valuesRefAt(file, offset);
  if (!hit) return;
  const p = hit.path;
  const range = new vscode.Range(doc.positionAt(hit.start), doc.positionAt(hit.end));

  const chain = index.overrideChain(chart, p);
  const md = hoverMarkdown();
  const from = { file, offset: hit.start };
  md.appendMarkdown(`**\`.Values.${p.join('.')}\`** — chart \`${chart.name}\`\n\n`);
  const rows = chain.filter((c) => c.entries.length);
  const envs = index.environmentsFor(chart);
  if (!rows.length) {
    md.appendMarkdown('_No value declared in any values file of this chart or its parents._\n');
  } else if (envs.length) {
    // One effective value per environment; the table already names the file each value comes from.
    md.appendMarkdown('| environment | effective value | from |\n|---|---|---|\n');
    for (const env of envs) {
      const eff = index.effective(index.overrideChain(chart, p, env));
      if (!eff) {
        md.appendMarkdown(`| ${env} | _not set_ | |\n`);
        continue;
      }
      const e = eff.entries[0];
      const loc = toLocation({ file: eff.file, start: e.keyStart, end: e.keyEnd });
      const lines = e.preview.split('\n');
      const value = (lines[0] + (lines.length > 1 ? ' …' : '')).replace(/\|/g, '\\|').replace(/`/g, "'");
      const target = { file: eff.file, start: e.keyStart, end: e.keyEnd };
      md.appendMarkdown(`| ${env} | \`${value}\` | ${peekLink(`${vscode.workspace.asRelativePath(eff.file)}:${loc.range.start.line + 1}`, from, [target])} |\n`);
    }
    // Sources the table cannot show: parent overrides, globals and import-values that an environment value hides.
    const extra = rows.filter((c) => c.role !== 'default');
    if (extra.length) md.appendMarkdown('\nAlso set by:\n\n');
    for (const c of extra) appendLayer(md, c, false, from);
  } else {
    const eff = index.effective(chain);
    for (const c of rows) appendLayer(md, c, c === eff, from);
  }
  md.appendMarkdown(`\n_${index.templateRefsExact(chart, p).length} template reference(s)_`);
  return new vscode.Hover(md, range);
}

function appendLayer(md: vscode.MarkdownString, c: ChainItem, effective: boolean, from: PeekFrom): void {
  const e = c.entries[0];
  const target = { file: c.file, start: e.keyStart, end: e.keyEnd };
  const line = toLocation(target).range.start.line + 1;
  md.appendMarkdown(`${effective ? '✅ **effective** · ' : ''}${roleLabel(c)} — ${peekLink(`${vscode.workspace.asRelativePath(c.file)}:${line}`, from, [target])}\n`);
  md.appendCodeblock(e.preview, 'yaml');
}

// Hover links open a peek window (like Cmd+click) instead of jumping; Enter / double-click in the peek opens the file.
const PEEK_COMMAND = 'helmNavigator.peek';
interface PeekFrom {
  file: string;
  offset: number;
}

function hoverMarkdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [PEEK_COMMAND] };
  return md;
}

function peekLink(label: string, from: PeekFrom, targets: FileRange[]): string {
  const args = encodeURIComponent(JSON.stringify([{ from, targets }]));
  return `[${label.replace(/[[\]]/g, '\\$&')}](command:${PEEK_COMMAND}?${args} "Peek")`;
}

async function peekFromHover(arg: { from: PeekFrom; targets: FileRange[] }): Promise<void> {
  if (!arg?.from || !Array.isArray(arg.targets) || !arg.targets.length) return;
  const uri = vscode.Uri.file(arg.from.file);
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === uri.fsPath);
  const doc = editor?.document ?? (await vscode.workspace.openTextDocument(uri));
  await vscode.commands.executeCommand('editor.action.peekLocations', doc.uri, doc.positionAt(arg.from.offset), arg.targets.map(toLocation), 'peek');
}

const MAX_HOVER_REFS = 15;

/** Hover on a values key: where templates read it (the other values files are not listed here). */
function valuesKeyHover(chart: Chart, p: string[], range: vscode.Range, from: PeekFrom): vscode.Hover {
  const md = hoverMarkdown();
  md.appendMarkdown(`**\`.Values.${p.filter((s) => s !== '[]').join('.')}\`** — chart \`${chart.name}\`\n\n`);
  const refs = dedupeRanges(index.templateRefsForKey(chart, p)).sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  if (!refs.length) {
    md.appendMarkdown('_No template reads this key._\n');
    return new vscode.Hover(md, range);
  }
  const all: FileRange[] = refs.map((r) => ({ file: r.file, start: r.start, end: r.end }));
  md.appendMarkdown(`**${refs.length} template reference(s)** · ${peekLink('peek all', from, all)}\n\n`);
  for (const r of all.slice(0, MAX_HOVER_REFS)) {
    const line = toLocation(r).range.start.line + 1;
    const text = (index.host.readFile(r.file) ?? '').slice(r.start, r.end).replace(/`/g, "'");
    md.appendMarkdown(`- ${peekLink(`${vscode.workspace.asRelativePath(r.file)}:${line}`, from, [r])} \`${text}\`\n`);
  }
  if (refs.length > MAX_HOVER_REFS) md.appendMarkdown(`- … ${refs.length - MAX_HOVER_REFS} more (Shift+F12 lists all)\n`);
  return new vscode.Hover(md, range);
}

function provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
  if (doc.uri.scheme !== 'file' || !isTemplateFile(doc.uri.fsPath)) return;
  const chart = index.graph.chartForFile(doc.uri.fsPath);
  if (!chart) return;
  const offset = doc.offsetAt(pos);
  const r = completeValues(index, chart, doc.getText(), offset, doc.uri.fsPath);
  if (!r) return;
  const range = new vscode.Range(doc.positionAt(r.replaceStart), pos);
  return r.items.map((it, i) => {
    const item = new vscode.CompletionItem(it.label, it.kind === 'object' ? vscode.CompletionItemKind.Module : vscode.CompletionItemKind.Field);
    item.range = range;
    item.detail = it.detail;
    item.sortText = String(i).padStart(4, '0');
    if (it.preview !== undefined && it.file) {
      const md = new vscode.MarkdownString();
      md.appendCodeblock(it.preview, 'yaml');
      md.appendMarkdown(`_${vscode.workspace.asRelativePath(it.file)}_`);
      item.documentation = md;
    }
    return item;
  });
}

/** The values key under the cursor for rename: its chart, path, and the literal range of the key. */
function renameTarget(doc: vscode.TextDocument, pos: vscode.Position): { chart: Chart; path: string[]; range: vscode.Range } | undefined {
  const file = doc.uri.fsPath;
  const chart = index.graph.chartForFile(file);
  if (!chart) return;
  const offset = doc.offsetAt(pos);
  if (isTemplateFile(file)) {
    const ref = index.analysis(file)?.valuesRefs.find((r) => offset >= r.start && offset <= r.end);
    if (!ref) return;
    const k = ref.segRanges.findIndex((sr) => !!sr && offset >= sr.start && offset <= sr.end);
    if (k < 0) return;
    const sr = ref.segRanges[k]!;
    return { chart, path: ref.path.slice(0, k + 1), range: new vscode.Range(doc.positionAt(sr.start), doc.positionAt(sr.end)) };
  }
  if (!index.isValuesFile(file)) return;
  const vf = index.valuesFile(file);
  const entry = vf && entryAt(vf, offset);
  if (!entry) return;
  return { chart, path: entry.path, range: new vscode.Range(doc.positionAt(entry.keyStart), doc.positionAt(entry.keyEnd)) };
}

function prepareRename(doc: vscode.TextDocument, pos: vscode.Position): { range: vscode.Range; placeholder: string } {
  const t = renameTarget(doc, pos);
  if (!t) throw new Error('Place the cursor on a values key or a `.Values` path segment.');
  const last = t.path[t.path.length - 1];
  if (last === '*' || last === '[]') throw new Error('Dynamic keys and list items cannot be renamed.');
  if (t.chart.packagedFrom) throw new Error(`Chart "${t.chart.name}" comes from ${path.basename(t.chart.packagedFrom)} and is read-only.`);
  return { range: t.range, placeholder: last };
}

function provideRenameEdits(doc: vscode.TextDocument, pos: vscode.Position, newName: string): vscode.WorkspaceEdit {
  const t = renameTarget(doc, pos);
  if (!t) throw new Error('Nothing to rename here.');
  if (!VALID_KEY.test(newName)) throw new Error(`"${newName}" cannot be read as .Values.${newName} in templates; use letters, digits and _.`);
  const plan = planRename(index, t.chart, t.path, newName);
  if (plan.chart.packagedFrom) throw new Error(`Chart "${plan.chart.name}" is read-only (packaged archive).`);
  const edit = new vscode.WorkspaceEdit();
  for (const e of plan.edits) {
    if (index.graph.packages?.contains(e.file)) continue;
    edit.replace(vscode.Uri.file(e.file), toLocation(e).range, e.newText);
  }
  for (const w of plan.warnings) void vscode.window.showWarningMessage(`Helm Navigator rename: ${w}`);
  return edit;
}

function roleLabel(c: ChainItem): string {
  if (c.role === 'default') return `default in \`${c.chart.name}\``;
  if (c.role === 'global') return `global from parent \`${c.chart.name}\``;
  if (c.role === 'import') return `imported (import-values) from \`${c.chart.name}\` at \`${c.path.join('.')}\``;
  return `override in parent \`${c.chart.name}\` at \`${c.path.join('.')}\``;
}

/** The values ref under the cursor, truncated to the segment the cursor is on. */
function valuesRefAt(file: string, offset: number): { path: string[]; start: number; end: number } | undefined {
  const a = index.analysis(file);
  const ref = a?.valuesRefs.find((r) => offset >= r.start && offset <= r.end);
  if (!ref) return;
  for (let k = 0; k < ref.segRanges.length; k++) {
    const sr = ref.segRanges[k];
    if (sr && offset >= sr.start && offset <= sr.end) return { path: ref.path.slice(0, k + 1), start: ref.start, end: sr.end };
  }
  return { path: ref.path, start: ref.start, end: ref.end };
}

function valuesPathAt(file: string, offset: number): string[] | undefined {
  return valuesRefAt(file, offset)?.path;
}

function dependencyAt(doc: vscode.TextDocument, pos: vscode.Position, chart: Chart): vscode.Location | undefined {
  // Find which `- name:` list item of `dependencies:` the cursor is in.
  const text = doc.getText();
  const lines = text.split('\n');
  const depsLine = lines.findIndex((l) => /^dependencies:\s*(#.*)?$/.test(l));
  if (depsLine < 0 || pos.line <= depsLine) return;
  let item = -1;
  for (let i = depsLine + 1; i <= pos.line && i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') return; // left the dependencies block
    if (/^\s*-\s/.test(lines[i])) item++;
  }
  if (item < 0) return;
  const declared = norm(doc.uri.fsPath);
  const link = chart.subcharts.find((s) => s.dependency && norm(s.dependency.declaredIn) === declared && s.dependency.index === item);
  if (link?.chart) return new vscode.Location(vscode.Uri.file(link.chart.chartFile), new vscode.Position(0, 0));
  if (link?.packagedPath && fs.existsSync(link.packagedPath)) {
    void vscode.window.showInformationMessage(`Subchart "${link.name}" could not be unpacked: ${path.basename(link.packagedPath)}`);
  }
  return;
}
