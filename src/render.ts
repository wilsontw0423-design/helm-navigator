import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Chart } from './core/chartGraph';
import type { HelmIndex } from './core/helmIndex';
import { norm } from './core/host';
import {
  DEFAULT_RELEASE_NAME,
  helmTemplateArgs,
  isRenderedTemplate,
  NAMESPACE_NAME,
  parseHelmErrors,
  RELEASE_NAME,
  renderRoots,
  renderValuesFiles,
  selectManifests,
  sourcePathOf,
  sourcePrefix,
  sourceToFile,
  splitManifests,
  type HelmProblem,
  type Manifest,
  type RenderRoot,
} from './core/render';

/**
 * One read-only preview of `helm template` output, like the Markdown preview: it follows the active
 * editor (another template, or another chart in chart mode) and re-renders when a file of the chart
 * tree is saved. Helm always renders a whole root chart, so the output of a root + environment is
 * cached and switching between its templates only re-filters it.
 */
const SCHEME = 'helm-rendered';
/** The preview uses the Helm Values language: YAML highlighting with the Helm colors, no YAML/JSON Schema checks. */
const PREVIEW_LANGUAGE = 'helm-values';
const ENV_KEY = 'helmNavigator.renderEnvironment:';
const ROOT_KEY = 'helmNavigator.renderRoot:';
const RELEASE_KEY = 'helmNavigator.renderRelease:';
/** Picker item that opens the release name / namespace inputs instead of choosing an environment. */
const CONFIGURE = Symbol('configure');

/** `.Release.Name` / `.Release.Namespace` for one root chart + environment (unset: helm's defaults). */
interface Release {
  releaseName?: string;
  namespace?: string;
}

type Kind = 'chart' | 'template';

/** What the preview shows. */
interface View {
  kind: Kind;
  chart: Chart;
  /** The template file, for `kind: 'template'`. */
  file?: string;
  root: RenderRoot;
  /** Environment name; `null` renders with the chart's own values.yaml only. */
  env: string | null;
}

/** Result of one `helm template` run of a root chart with one environment. */
interface Output {
  args: string[];
  valuesFiles: string[];
  manifests: Manifest[];
  problems: HelmProblem[];
  /** helm could not run at all (not installed, timeout). */
  fatal?: string;
}

interface HelmResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when helm could not be started (e.g. not installed). */
  spawnError?: string;
}

function runHelm(args: string[], cwd: string): Promise<HelmResult> {
  const helm = vscode.workspace.getConfiguration('helmNavigator').get<string>('helmPath') || 'helm';
  return new Promise((resolve) => {
    execFile(helm, args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (err && (err as { killed?: boolean }).killed) resolve({ ok: false, stdout, stderr, spawnError: 'helm 執行超過 120 秒，已中止' });
      else if (err && typeof code === 'string') {
        resolve({ ok: false, stdout, stderr, spawnError: code === 'ENOENT' ? `找不到 helm（${helm}）` : err.message });
      } else resolve({ ok: !err, stdout, stderr });
    });
  });
}

function under(file: string, dir: string): boolean {
  return norm(file).startsWith(norm(dir) + path.sep);
}

export function registerRender(
  context: vscode.ExtensionContext,
  getIndex: () => HelmIndex,
  isTemplateFile: (file: string) => boolean,
): void {
  /** Content of each preview document; the tab title names the template and environment. */
  const texts = new Map<string, string>();
  /** The preview document currently shown (one preview tab at a time). */
  let current: vscode.Uri | undefined;
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const diagnostics = vscode.languages.createDiagnosticCollection('helm-template');
  /** Files that got a render diagnostic, per root chart directory. */
  const diagnosed = new Map<string, vscode.Uri[]>();
  /** helm output per root directory + environment. */
  const cache = new Map<string, { root: Chart; output: Promise<Output> }>();
  /** Follow mode: the preview switches templates (`template`) or charts (`chart`). */
  let mode: Kind = 'template';
  let view: View | undefined;
  /** Increases with every update, so a slow helm run cannot overwrite a newer view. */
  let seq = 0;

  const previewEditor = () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === SCHEME);
  const previewVisible = () => !!previewEditor();
  const setText = (uri: vscode.Uri, t: string) => {
    texts.set(uri.toString(), t);
    changed.fire(uri);
  };

  context.subscriptions.push(
    changed,
    status,
    diagnostics,
    // A render error describes the file as it was when helm ran: drop it as soon as the file is edited.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length && diagnostics.has(e.document.uri)) diagnostics.delete(e.document.uri);
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: changed.event,
      provideTextDocumentContent: (uri) => texts.get(uri.toString()) ?? '',
    }),
  );

  // Context keys for the editor title buttons.
  const updateContext = (editor: vscode.TextEditor | undefined) => {
    const file = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined;
    const chart = file ? getIndex().graph.chartForFile(file) : undefined;
    void vscode.commands.executeCommand('setContext', 'helmNavigator.inChart', !!chart);
    void vscode.commands.executeCommand('setContext', 'helmNavigator.isTemplate', !!chart && !!file && isTemplateFile(file));
  };
  updateContext(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateContext));

  // ------------------------------------------------------------------ choosing what to render

  /**
   * The view for `file`. `interactive` (a command): explain fallbacks and ask for the root / environment;
   * otherwise (following the editor) use the remembered choices and return `'choose'` when there are none.
   */
  const viewFor = async (file: string, kind: Kind, interactive: boolean): Promise<View | 'choose' | undefined> => {
    const index = getIndex();
    const chart = index.graph.chartForFile(file);
    if (!chart) {
      if (interactive) void vscode.window.showWarningMessage(`Helm Navigator：${path.basename(file)} 不在任何 Helm chart 裡（找不到上層的 Chart.yaml）。`);
      return undefined;
    }
    if (kind === 'template' && !isRenderedTemplate(chart, file)) {
      if (!interactive) return undefined;
      const base = path.basename(file);
      const why = base === 'NOTES.txt' ? 'helm template 不會輸出 NOTES.txt' : base.startsWith('_') ? `${base} 只放 define，helm 不會單獨輸出它` : `${base} 不是 templates/ 裡的檔案`;
      void vscode.window.showInformationMessage(`Helm Navigator：${why}，改為渲染整份 chart。`);
      kind = 'chart';
    }

    const roots = renderRoots(chart);
    let root: RenderRoot | undefined = roots[0];
    if (roots.length > 1) {
      const last = context.workspaceState.get<string>(ROOT_KEY + chart.dir);
      root = roots.find((r) => r.root.dir === last);
      if (interactive) {
        const items = roots.map((r) => ({ label: r.root.name, description: sourcePrefix(r), detail: r === root ? '上次使用' : r.root.dir, r }));
        if (root) items.unshift(...items.splice(roots.indexOf(root), 1));
        const pick = await vscode.window.showQuickPick(items, { title: `${chart.name} 被多個 chart 使用：要從哪一個渲染？` });
        if (!pick) return undefined;
        root = pick.r;
        await context.workspaceState.update(ROOT_KEY + chart.dir, root.root.dir);
      }
      if (!root) return 'choose';
    }

    const env = interactive ? await pickEnvironment(index, root.root) : rememberedEnvironment(index, root.root);
    if (env === undefined) return interactive ? undefined : 'choose';
    return { kind, chart, file: kind === 'template' ? file : undefined, root, env };
  };

  const rememberedEnvironment = (index: HelmIndex, root: Chart): string | null | undefined => {
    const envs = index.environmentsFor(root);
    if (!envs.length) return null;
    const last = context.workspaceState.get<string | null>(ENV_KEY + root.dir);
    return last === null || (last !== undefined && envs.includes(last)) ? last : undefined;
  };

  /**
   * Asks for the environment. The last item opens the release name / namespace inputs for an
   * environment (asked next) and then renders with that environment.
   */
  const pickEnvironment = async (index: HelmIndex, root: Chart, title?: string, withConfigure = true): Promise<string | null | undefined> => {
    const envs = index.environmentsFor(root);
    const last = context.workspaceState.get<string | null>(ENV_KEY + root.dir);
    const rel = (files: string[]) => files.map((f) => path.relative(root.dir, f)).join(' + ') || '（無）';
    type Item = vscode.QuickPickItem & { env: string | null | typeof CONFIGURE };
    const items: Item[] = [
      ...envs.map((env) => ({ label: env, description: rel(renderValuesFiles(index, root, env)), env })),
      { label: envs.length ? '只用 values.yaml' : 'values.yaml', description: '不加 -f', env: null },
    ];
    for (const i of items) if (i.env !== CONFIGURE) i.detail = releaseLabel(releaseOf(root, i.env));
    const lastIdx = items.findIndex((i) => i.env === last);
    if (lastIdx > 0) items.unshift(...items.splice(lastIdx, 1));
    if (lastIdx >= 0) items[0].detail = `上次使用 · ${items[0].detail}`;
    // Nothing to choose: render right away (the release can still be set from the Command Palette).
    if (!envs.length && !withConfigure) return null;
    if (!envs.length && title === undefined) return null;
    if (withConfigure) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, env: CONFIGURE });
      items.push({ label: '$(gear) 設定 release name / namespace…', description: '模擬 helm install 的 .Release.Name / .Release.Namespace', env: CONFIGURE });
    }
    const pick = await vscode.window.showQuickPick(items, { title: title ?? `用哪一組 values 渲染 ${root.name}？`, placeHolder: '環境（values 檔）' });
    if (!pick) return undefined;
    if (pick.env === CONFIGURE) {
      const env = envs.length ? await pickEnvironment(index, root, `要設定哪個環境的 release name / namespace？（${root.name}）`, false) : null;
      if (env === undefined || !(await configureRelease(root, env))) return undefined;
      await context.workspaceState.update(ENV_KEY + root.dir, env);
      return env;
    }
    await context.workspaceState.update(ENV_KEY + root.dir, pick.env);
    return pick.env;
  };

  const releaseKey = (root: Chart, env: string | null) => `${RELEASE_KEY}${root.dir}\0${env ?? ''}`;
  const releaseOf = (root: Chart, env: string | null): Release => context.workspaceState.get<Release>(releaseKey(root, env)) ?? {};
  const releaseLabel = (r: Release) =>
    `release ${r.releaseName ?? `${DEFAULT_RELEASE_NAME}（預設）`} · namespace ${r.namespace ?? '（未指定）'}`;

  /** Two input boxes; an empty value goes back to helm's default. Returns false when cancelled. */
  const configureRelease = async (root: Chart, env: string | null): Promise<boolean> => {
    const cur = releaseOf(root, env);
    const where = `${root.name}${env ? ` · ${env}` : ''}`;
    const releaseName = await vscode.window.showInputBox({
      title: `Release name（${where}）`,
      prompt: `.Release.Name；留空用 helm 預設 ${DEFAULT_RELEASE_NAME}`,
      value: cur.releaseName ?? '',
      placeHolder: DEFAULT_RELEASE_NAME,
      validateInput: (v) => (!v.trim() || RELEASE_NAME.test(v.trim()) ? undefined : '只能用小寫英數字、- 和 .，開頭結尾要是英數字，最多 53 字'),
    });
    if (releaseName === undefined) return false;
    const namespace = await vscode.window.showInputBox({
      title: `Namespace（${where}）`,
      prompt: '.Release.Namespace（helm template --namespace）；留空則不指定：helm 會用 kubeconfig 目前 context 的 namespace，沒有就是 default',
      value: cur.namespace ?? '',
      placeHolder: 'default',
      validateInput: (v) => (!v.trim() || NAMESPACE_NAME.test(v.trim()) ? undefined : '只能用小寫英數字和 -，開頭結尾要是英數字，最多 63 字'),
    });
    if (namespace === undefined) return false;
    const next: Release = {};
    if (releaseName.trim()) next.releaseName = releaseName.trim();
    if (namespace.trim()) next.namespace = namespace.trim();
    await context.workspaceState.update(releaseKey(root, env), Object.keys(next).length ? next : undefined);
    cache.delete(cacheKey(root, env));
    return true;
  };

  // ------------------------------------------------------------------ running helm

  const cacheKey = (root: Chart, env: string | null) => `${root.dir}\0${env ?? ''}`;

  const outputOf = (root: Chart, env: string | null): Promise<Output> => {
    const key = cacheKey(root, env);
    const hit = cache.get(key);
    if (hit) return hit.output;
    const output = runRender(root, env).then((o) => {
      if (o.fatal) cache.delete(key); // retry next time (e.g. helm installed meanwhile)
      return o;
    });
    cache.set(key, { root, output });
    return output;
  };

  const runRender = async (root: Chart, env: string | null): Promise<Output> => {
    const valuesFiles = renderValuesFiles(getIndex(), root, env);
    const release = releaseOf(root, env);
    const args = helmTemplateArgs(root, { valuesFiles, ...release });
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `helm template ${root.name}` }, () =>
      runHelm(args, root.dir),
    );
    if (result.spawnError) {
      void vscode.window.showErrorMessage(`Helm Navigator：${result.spawnError}。請安裝 helm，或設定 helmNavigator.helmPath。`, '開啟設定').then((a) => {
        if (a) void vscode.commands.executeCommand('workbench.action.openSettings', 'helmNavigator.helmPath');
      });
      return { args, valuesFiles, manifests: [], problems: [], fatal: result.spawnError };
    }

    const problems = result.ok ? [] : parseHelmErrors(result.stderr);
    if (!result.ok && !problems.length) problems.push({ kind: 'other', message: result.stderr.trim() || 'helm 以非 0 結束代碼結束' });
    if (problems.some((p) => p.kind === 'dependencies')) offerDependencyBuild(root, env);

    // With invalid YAML, `--debug` still prints the rendered output: show it next to the error.
    let stdout = result.stdout;
    if (problems.some((p) => p.kind === 'yaml')) stdout = (await runHelm(helmTemplateArgs(root, { valuesFiles, ...release, debug: true }), root.dir)).stdout;

    // Errors go to the preview header and the template lines; no popup (saves re-render repeatedly).
    report(root, problems);
    return { args, valuesFiles, manifests: splitManifests(stdout), problems };
  };

  const offerDependencyBuild = (root: Chart, env: string | null) => {
    void vscode.window
      .showErrorMessage(
        `Helm Navigator：${root.name} 的 charts/ 缺少依賴，需要先執行 helm dependency build（會在 ${path.basename(root.dir)}/charts 產生檔案）。`,
        '執行 helm dependency build',
      )
      .then(async (a) => {
        if (!a) return;
        const built = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `helm dependency build ${root.name}` }, () =>
          runHelm(['dependency', 'build', root.dir], root.dir),
        );
        if (!built.ok) {
          void vscode.window.showErrorMessage(`helm dependency build 失敗：${built.spawnError ?? built.stderr.trim()}`);
          return;
        }
        cache.delete(cacheKey(root, env));
        if (view) await show(view, false);
      });
  };

  /** Puts helm errors on the template lines they point at (replacing this root's previous ones). */
  const report = (root: Chart, problems: HelmProblem[]) => {
    for (const u of diagnosed.get(root.dir) ?? []) diagnostics.delete(u);
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const p of problems) {
      const file = p.source && sourceToFile(root, p.source);
      if (!file) continue;
      const yaml = p.kind === 'yaml';
      const line = !yaml && p.line ? p.line - 1 : 0;
      const col = !yaml && p.column !== undefined ? p.column : 0;
      const range = new vscode.Range(line, col, line, Number.MAX_SAFE_INTEGER);
      const d = new vscode.Diagnostic(range, yaml ? `渲染結果不是合法 YAML（渲染後第 ${p.line ?? '?'} 行）：${p.message}` : p.message, vscode.DiagnosticSeverity.Error);
      d.source = 'helm template';
      byFile.set(file, [...(byFile.get(file) ?? []), d]);
    }
    const uris: vscode.Uri[] = [];
    for (const [file, ds] of byFile) {
      const u = vscode.Uri.file(file);
      diagnostics.set(u, ds);
      uris.push(u);
    }
    diagnosed.set(root.dir, uris);
  };

  // ------------------------------------------------------------------ the preview document

  const show = async (v: View, open: boolean): Promise<void> => {
    const my = ++seq;
    view = v;
    const out = await outputOf(v.root.root, v.env);
    if (my !== seq) return;
    const uri = uriFor(v);
    setText(uri, previewText(v, out));
    updateStatus(v, out);
    if (open || previewVisible()) await reveal(uri);
  };

  /** Shows `uri` in the preview tab: replaces the previous preview document in its editor group. */
  const reveal = async (uri: vscode.Uri) => {
    const shown = previewEditor();
    if (shown?.document.uri.toString() === uri.toString()) return;
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== PREVIEW_LANGUAGE) doc = await vscode.languages.setTextDocumentLanguage(doc, PREVIEW_LANGUAGE);
    await vscode.window.showTextDocument(doc, {
      viewColumn: shown?.viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: true,
      preview: false,
    });
    current = uri;
    // Close the other preview tabs, so the preview stays one tab that changes title.
    const stale = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === SCHEME && t.input.uri.toString() !== uri.toString());
    if (stale.length) await vscode.window.tabGroups.close(stale, true);
    for (const t of stale) texts.delete((t.input as vscode.TabInputText).uri.toString());
  };

  /** Short environment label for titles: `environments/hk/prod/values.yaml` → `hk/prod`. */
  const envLabel = (env: string | null) => {
    if (env === null) return 'values.yaml';
    let s = env.replace(/\\/g, '/');
    if (/\/values\.ya?ml$/i.test(s)) s = s.replace(/\/values\.ya?ml$/i, '');
    else s = s.replace(/\.ya?ml$/i, '');
    const parts = s.split('/');
    if (parts.length > 1 && /^env/i.test(parts[0])) parts.shift();
    return parts.join('/') || env;
  };

  /** One document per template / chart + environment, so the tab title says what is previewed. */
  const uriFor = (v: View): vscode.Uri => {
    const what = v.kind === 'template' ? path.basename(v.file!).replace(/\.(ya?ml|tpl|txt)$/i, '') : `chart ${v.chart.name}`;
    const key = [v.root.root.dir, v.kind, v.file ?? v.chart.dir, v.env ?? ''].join('|');
    return vscode.Uri.from({ scheme: SCHEME, path: `/${what} · ${envLabel(v.env).replace(/\//g, '∕')}`, query: encodeURIComponent(key) });
  };

  /** Status bar: what the preview shows and with which parameters; click to choose another environment. */
  const updateStatus = (v: View, out: Output) => {
    const r = releaseOf(v.root.root, v.env);
    const s = summary(v, out);
    status.text = `$(open-preview) ${v.kind === 'template' ? path.basename(v.file!) : v.chart.name} · ${envLabel(v.env)} · ${r.releaseName ?? DEFAULT_RELEASE_NAME}${r.namespace ? ` / ${r.namespace}` : ''}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`${v.kind === 'template' ? 'template' : 'chart'}: \`${s.target}\`  \n`);
    md.appendMarkdown(`values: \`${s.values}\`  \n`);
    md.appendMarkdown(`release: \`${s.release}\`  \n`);
    md.appendMarkdown(`namespace: \`${s.namespace}\`\n\n`);
    md.appendMarkdown('點一下換環境或 release / namespace');
    status.tooltip = md;
    status.command =
      v.kind === 'template'
        ? { title: 'Render', command: 'helmNavigator.renderTemplate', arguments: [vscode.Uri.file(v.file!)] }
        : { title: 'Render', command: 'helmNavigator.renderChart', arguments: [vscode.Uri.file(v.chart.chartFile)] };
    status.show();
  };

  /** What the preview shows, in four short values (header lines and status bar tooltip). */
  const summary = (v: View, out: Output) => {
    const root = v.root.root;
    const r = releaseOf(root, v.env);
    return {
      // `<root>/templates/x.yaml`, or `<root>/charts/<alias>/templates/x.yaml` for a subchart.
      target: v.kind === 'template' ? sourcePathOf(v.root, v.chart, v.file!) : sourcePrefix(v.root),
      values: ['values.yaml', ...out.valuesFiles.map((f) => path.relative(root.dir, f))].join(' + '),
      release: r.releaseName ?? `${DEFAULT_RELEASE_NAME}（預設）`,
      namespace: r.namespace ?? '（未指定）',
    };
  };

  const previewText = (v: View, out: Output): string => {
    const s = summary(v, out);
    const lines = [
      `# ${v.kind === 'template' ? 'template' : 'chart'}: ${s.target}`,
      `# values: ${s.values}`,
      `# release: ${s.release}`,
      `# namespace: ${s.namespace}`,
    ];
    if (out.fatal) return [...lines, `# ❌ ${out.fatal}`].join('\n') + '\n';
    for (const p of out.problems) lines.push(`# ❌ ${describe(p)}`);
    const selected =
      v.kind === 'template'
        ? selectManifests(out.manifests, { file: sourcePathOf(v.root, v.chart, v.file!) })
        : selectManifests(out.manifests, { prefix: sourcePrefix(v.root) });
    if (!selected.length && (!out.problems.length || out.manifests.length)) {
      lines.push(
        v.kind === 'template'
          ? '# （這個 template 在這組 values 下沒有輸出：可能被 if 條件排除，或只有空白／註解）'
          : '# （這個 chart 沒有輸出：可能所有 template 都被條件排除，或 dependencies 的 condition 關閉了它）',
      );
    }
    return [...lines, ...selected.map((m) => `---\n${m.text}`)].join('\n') + '\n';
  };

  const choosePrompt = (file: string, chart: Chart | undefined) =>
    [
      `# helm template：${chart ? path.relative(chart.dir, file) : path.basename(file)}`,
      `# ${chart?.name ?? '這個 chart'} 還沒選過要用哪組 values（或從哪個父 chart 渲染）。`,
      '# 按編輯器右上角的預覽按鈕，或執行 Helm Navigator: Render This Template 來選擇。',
    ].join('\n') + '\n';

  // The status bar item belongs to the preview: hide it while no preview is visible.
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      if (previewVisible() && view) status.show();
      else status.hide();
    }),
  );

  // Follow the active editor while the preview is visible.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (!previewVisible() || editor?.document.uri.scheme !== 'file') return;
      const file = editor.document.uri.fsPath;
      const chart = getIndex().graph.chartForFile(file);
      if (!chart) return;
      if (mode === 'template') {
        if (!isRenderedTemplate(chart, file) || (view && norm(view.file ?? '') === norm(file))) return;
      } else if (view?.chart === chart) return;
      const v = await viewFor(file, mode, false);
      if (v === 'choose') {
        ++seq;
        view = undefined;
        status.hide();
        if (current) setText(current, choosePrompt(file, chart));
      } else if (v) await show(v, false);
    }),
  );

  // Re-render after a save anywhere in the chart tree (templates, values files, Chart.yaml, subcharts).
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return;
      const file = doc.uri.fsPath;
      const index = getIndex();
      let affected = false;
      for (const [key, { root }] of cache) {
        if (index.graph.component(root).some((c) => under(file, c.dir))) {
          cache.delete(key);
          if (view?.root.root === root) affected = true;
        }
      }
      if (affected && view && previewVisible()) void show(view, false);
    }),
  );

  // ------------------------------------------------------------------ commands

  const command = (kind: Kind) => async (uri?: vscode.Uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') {
      void vscode.window.showWarningMessage('Helm Navigator：請先開啟 Helm chart 裡的檔案。');
      return;
    }
    const v = await viewFor(target.fsPath, kind, true);
    if (!v || v === 'choose') return;
    mode = v.kind;

    // Helm reads the disk; saving triggers a re-render through the save listener.
    const dirs = getIndex().graph.component(v.root.root).map((c) => c.dir);
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file' && dirs.some((dir) => under(d.uri.fsPath, dir)));
    if (dirty.length) {
      void vscode.window
        .showWarningMessage(`Helm Navigator：有 ${dirty.length} 個未存檔的檔案，helm 讀的是磁碟上的版本。`, '全部儲存並重新渲染')
        .then((a) => a && vscode.workspace.saveAll(false));
    }
    cache.delete(cacheKey(v.root.root, v.env)); // an explicit render always runs helm again
    await show(v, true);
  };
  // Release name / namespace of the previewed root + environment (or of the active file's chart).
  const setRelease = async () => {
    let v = view;
    if (!v) {
      const doc = vscode.window.activeTextEditor?.document;
      const chart = doc?.uri.scheme === 'file' ? getIndex().graph.chartForFile(doc.uri.fsPath) : undefined;
      if (!doc || !chart) {
        void vscode.window.showWarningMessage('Helm Navigator：請先開啟 Helm chart 裡的檔案，或開著 helm template 預覽。');
        return;
      }
      const kind: Kind = isRenderedTemplate(chart, doc.uri.fsPath) ? 'template' : 'chart';
      const roots = renderRoots(chart);
      let r: RenderRoot | undefined = roots[0];
      if (roots.length > 1) {
        const last = context.workspaceState.get<string>(ROOT_KEY + chart.dir);
        const items = roots.map((x) => ({ label: x.root.name, description: sourcePrefix(x), detail: x.root.dir === last ? '上次使用' : x.root.dir, x }));
        r = (await vscode.window.showQuickPick(items, { title: `${chart.name} 被多個 chart 使用：要設定從哪一個渲染時的值？` }))?.x;
        if (!r) return;
      }
      const env = getIndex().environmentsFor(r.root).length ? await pickEnvironment(getIndex(), r.root, `要設定哪個環境的 release name / namespace？（${r.root.name}）`, false) : null;
      if (env === undefined) return;
      v = { kind, chart, file: kind === 'template' ? doc.uri.fsPath : undefined, root: r, env };
    }
    if (!(await configureRelease(v.root.root, v.env))) return;
    mode = v.kind;
    await show(v, true);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('helmNavigator.setRenderRelease', setRelease),
    vscode.commands.registerCommand('helmNavigator.renderChart', command('chart')),
    vscode.commands.registerCommand('helmNavigator.renderTemplate', command('template')),
  );
}

function describe(p: HelmProblem): string {
  const where = p.source ? `${p.source}${p.line ? `:${p.line}` : ''}${p.kind === 'yaml' ? '（渲染後的行號）' : ''} ` : '';
  return `${where}${p.message}`.replace(/\n/g, ' ');
}
