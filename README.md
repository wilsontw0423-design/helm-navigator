# Helm Navigator

VS Code / Antigravity extension for Helm charts: a formatter for every Helm file type, and navigation
between `values.yaml`, templates, `_helpers.tpl`, and parent ↔ child charts.

## 安裝

> **命令面板**：按 `Cmd+Shift+P`（Windows / Linux：`Ctrl+Shift+P`）打開，輸入指令名稱（例如 *Developer: Reload Window*）後按 Enter。下面寫「按 `Cmd+Shift+P` 執行」的步驟都是這樣操作。

1. 到 [Releases](https://github.com/wilsontw0423-design/helm-navigator/releases/latest) 下載：
   - `helm-navigator-<版本>.vsix`：主擴充，**必裝**。
   - `helm-navigator-colors-<版本>.vsix`：IntelliJ 風格配色與檔案圖示，選裝。
2. 依序安裝，**先裝主擴充，再裝 colors**（colors 依賴主擴充，順序反了會安裝失敗）：
   - **VS Code**：左側 Extensions 側欄 → 右上角 `…` → *Install from VSIX…*，選下載的檔案。
     也可以用終端機（需先按 `Cmd+Shift+P` 執行 *Shell Command: Install 'code' command in PATH*）：

     ```bash
     code --install-extension helm-navigator-0.1.0.vsix
     code --install-extension helm-navigator-colors-0.1.0.vsix
     ```

   - **Antigravity**：Extensions 側欄 → `…` → *Install from VSIX…*（Antigravity 沒有 CLI）。
3. 按 `Cmd+Shift+P`（Windows / Linux：`Ctrl+Shift+P`），輸入並執行 *Developer: Reload Window*，讓擴充生效。
4. 打開含有 `Chart.yaml` 的資料夾，右下角會詢問是否把 Helm Navigator 設為這個 workspace 的預設 formatter。
   同意後會寫進該 workspace 的 `.vscode/settings.json`（如果那個檔案有被 git 追蹤，記得自己決定要不要 commit）。不想被詢問：設定 `helmNavigator.autoSetDefaultFormatter` 為 `always` 或 `never`。
5. 選用：按 `Cmd+Shift+P`，執行 *Preferences: File Icon Theme* → **Helm Navigator Icons (Seti)**，`_helpers.tpl` 才會有自己的圖示
   （template 與 values 的圖示不切換也看得到）。

### 試試看

- 在 template 的 `.Values.image.tag` 上 Cmd/Ctrl+點擊：開出 peek 視窗，列出每個 values 檔裡的設定。
- 在 values 檔的 key 上停留：列出讀取這個 key 的 template；點擊 key 則開 peek。
- 在 `include "xxx.labels"` 上 F12：跳到 `define`，子 chart 裡的也找得到。
- Shift+Alt+F（Mac 為 Shift+Option+F）：格式化（template 只動 `{{- ... }}` 單獨一行的縮排，不改 YAML 縮排）。

### 更新與移除

- 不會自動更新：到 Releases 下載新版 VSIX，用同樣步驟（同樣順序）重新安裝即可覆蓋。
- 移除：Extensions 側欄先解除安裝 **Helm Navigator Colors & Icons**，再解除安裝 **Helm Navigator**。

### 常見問題

- **右下角語言模式顯示 YAML，而不是 Helm Template / Helm Values**：檔案要在含有 `Chart.yaml` 的資料夾底下；
  確認 `helmNavigator.assignLanguages` 沒有被關掉。跳轉與診斷依路徑判斷，與語言模式無關。
- **想恢復原本的配色或圖示**：停用 **Helm Navigator Colors & Icons**；圖示主題改回 *Seti*。
- **values 檔出現 YAML / JSON Schema 的錯誤**：通常是檔案仍以 `yaml` 語言開啟，見第一點。

## Features

### Navigation (F12 / Shift+F12 / hover)

| Where the cursor is | Go to Definition (F12) | Find References (Shift+F12) | Hover |
|---|---|---|---|
| `.Values.a.b` in a template (also inside `with` / `range`, `$var.x`, `$.Values`, `index .Values "a" "b"`) | the chart's default **and** every parent override (`<alias>.a.b`, `global.*`) | other templates reading the same path | override chain with the **effective** value |
| `include "x"` / `template "x"` / `define "x"` | the `define`, in any chart of the tree | every `include` in the tree | – |
| key in a parent `values.yaml` under a subchart alias (`kid.image.tag`) | subchart default `image.tag` | subchart templates that read it | chain |
| key in a subchart `values.yaml` | parent overrides | templates reading it | chain |
| any key in a values file | **the templates that read it** (including subchart templates through `<alias>.*`, and every chart for `global.*`); when no template reads it, VS Code falls back to Find References | templates reading it | the template references, as `file:line` links |
| `global.*` key | the same key in every chart of the tree | templates in every chart | chain |
| key received through `import-values` (parent) / its source (`exports.*` in the child) | the other side of the import | templates reading it | chain, with the imported layer below the parent's own value |
| `dependencies` item in `Chart.yaml` / `requirements.yaml` | the subchart's `Chart.yaml` | – | – |

In Helm Template and Helm Values files, Cmd/Ctrl+click always opens the results in a **peek window** first
(`editor.definitionLinkOpensInPeek` is on by default for these two languages); Enter or double-click in the peek
opens the file. Links in hovers do the same. To jump directly instead, set
`"[helm-values]": { "editor.definitionLinkOpensInPeek": false }` (and the same for `[helm-template]`).

Subcharts are resolved from `dependencies` (`alias` aware), `file://` repositories, `charts/<dir>`, and
`charts/*.tgz`. Archives are unpacked into the extension's global storage (cached by path, mtime and size;
re-unpacked when the archive changes) and opened read-only.

`define` bodies are analyzed with the context their callers pass: `include "x" .Values.image` makes `.tag`
inside `define "x"` mean `.Values.image.tag` (call sites passing different values paths of equal depth
merge into `*`; any root call keeps the root context).

### Completion, diagnostics, rename

- **Completion** after `.` in a template action: built-in objects at the root, `.Values` keys at any depth,
  honoring `with` / `range` / `$var` / `define` call contexts. Keys come from the whole override chain
  (including keys only a parent sets, and `import-values`) and show the effective value.
- **Diagnostics** (`helmNavigator.diagnostics.enabled`):
  - Warning: a template reads a `.Values` path no values file sets. Not reported for paths with `*`
    (range elements, dynamic keys), actions that use `default` / `required` / `empty` / `coalesce` /
    `hasKey`, or keys below an open `{}` / `[]` / `null` value.
  - Hint (faded): a values key no template in the chart tree reads (outermost key only). Dependency
    `condition` keys, `tags`, `import-values` sources and subchart alias keys count as used.
  - Charts unpacked from `charts/*.tgz` and `type: library` charts are not checked.
- **Rename** (F2) on a values key or a `.Values` path segment: renames the key in the owning chart's
  values files, every parent's `<alias>.…` override (every `global.…` for globals), every template
  reference (including `index .Values "a" "b"` strings and `define` bodies), and the key a parent
  receives through `import-values`. `import-values` / `condition` strings in `Chart.yaml` are reported, not
  edited. Renaming `<alias>.x` from a parent renames the subchart's `x`.

### Formatter

| File | What it does | Guarantee |
|---|---|---|
| `Chart.yaml`, `Chart.lock`, `requirements.yaml`, `values*.yaml`, `*-values.yaml`, `ci/*.yaml` | Re-indent to 2 spaces, keeping the sequence style; falls back to whitespace cleanup if comments would move | Data compared under YAML 1.1 **and** 1.2; refused if anything changes |
| `templates/**/*.yaml` | Action spacing (`{{.x\|quote}}` → `{{ .x \| quote }}`), trailing whitespace, repeated blank lines | Never changes YAML indentation; block scalars, comments and strings untouched |
| `*.tpl` | Same, plus indentation of `{{- … }}` control lines by nesting depth | `{{-` removes the preceding whitespace, so rendered output is unchanged |
| `templates/NOTES.txt` | Action spacing, trailing whitespace | – |
| `.helmignore` | Trailing whitespace, repeated blank lines (escaped `\ ` kept) | – |
| `values.schema.json` | 2-space JSON | – |

## Settings

| Key | Default | Meaning |
|---|---|---|
| `helmNavigator.format.yaml` | `true` | Format pure YAML chart files |
| `helmNavigator.format.normalizeActions` | `true` | Normalize spacing inside `{{ }}` |
| `helmNavigator.format.tplIndentControlActions` | `true` | Indent `{{- if }}` lines in `.tpl` by depth |
| `helmNavigator.format.templateIndentControlActions` | `false` | Same for `templates/*.yaml` |
| `helmNavigator.valuesFiles` | `["values.yaml"]` | Extra values files per chart (relative to the chart dir), increasing precedence, for every environment. The chart's own `values.yaml` is always the lowest layer |
| `helmNavigator.environments` | `{}` | Environment name → values files layered on top (what you pass with `helm -f`); see below |
| `helmNavigator.diagnostics.enabled` | `true` | Undefined-value warnings and unused-value hints |
| `helmNavigator.assignLanguages` | `true` | Open chart templates as Helm Template and values files as Helm Values |

### Languages

Inside a chart (any folder with a `Chart.yaml` above the file) the extension sets the language when a file
opens, so it works even with `"files.associations": { "*.yaml": "yaml" }`:

| File | Language | Why |
|---|---|---|
| `templates/**` (`.yaml`, `.tpl`, `NOTES.txt`) | **Helm Template** | `{{ }}` highlighting; the YAML language server does not report template syntax as errors |
| values files (below) | **Helm Values** | YAML highlighting + `{{ }}` in strings, outline, folding; no Red Hat YAML / JSON Schema errors |
| `Chart.yaml`, `Chart.lock`, other YAML | unchanged | |

The extension also adds default `files.associations` for `**/templates/**/*.{yaml,yml,tpl}`,
`**/templates/NOTES.txt` and the values file names, so the file explorer shows the right language (and icon) before
a file is opened. They are longer than a user pattern like `*.yaml`, and VS Code picks the longest matching
pattern. To opt out, map those patterns to `yaml` in your own `files.associations`.

A Helm Template / Helm Values file outside any chart goes back to `yaml` when opened. Turn this off with
`helmNavigator.assignLanguages: false`. Navigation and diagnostics do not depend on the language: they decide by path.

### Colors and icons

Colors and file icons live in a separate extension, `colors/` (**Helm Navigator Colors & Icons**), so they can be
turned off or changed without touching this one. It colors only the Helm Values / Helm Template scopes
(IntelliJ-style, for dark themes), turns off bracket pair colorization in those two languages, and gives Helm
Template and Helm Values files their own icons in any file icon theme that has none for them (Seti included).
`_helpers.tpl` gets its own icon only with the bundled file icon theme **Helm Navigator Icons (Seti)**, because
Seti assigns `.tpl` a Smarty icon by extension, which wins over language icons. Without the extension, these files
use your theme's colors and icons.

### Values files and environments

Values files of a chart are found automatically: `values.yaml` plus every `values*.yaml`, `*-values.yaml`,
`*_values.yaml` anywhere inside the chart directory (e.g. `environments/prod/values.yaml`,
`enviroments/values_prod.yaml`), except under `templates/`, `charts/`, `ci/`, `tests/`, `unittests/` and
nested charts. Each found file is an environment of its own (`helm -f <file>` on top of `values.yaml`), so
F12 from a template lists every values file that sets the key, and hover shows the value per file.

When an environment layers several files, declare it as a chain of files, relative to the chart directory,
in `helm -f` order:

```jsonc
// .vscode/settings.json of the repo
"helmNavigator.environments": {
  "prod": ["environments/values.yaml", "environments/prod/values.yaml"], // shared + prod layer
  "uat": ["environments/uat/values.yaml"]                                // a standalone file
}
```

- Hover on `.Values.x` in a template shows a table with the effective value in each environment (and the
  file it comes from); parent overrides, globals and imports are listed below it. Hover on a key in a
  values file shows the templates that read it.
- Go to definition, references, rename and completion cover the files of every environment; files of
  an environment also override subchart defaults through `<alias>.*`, like `-f` does.
- Diagnostics: a key set in any environment is defined; keys that only one environment sets count as used.
- An environment is shown for a chart only if one of its files exists in that chart or an ancestor.

Features decide what a file is by its path (`templates/**`, `*.tpl`, configured values files), not by its
language id, so they work even when `files.associations` maps templates to `yaml` or values files to
`helm-template`.

YAML files keep the `yaml` language (Red Hat YAML still validates them). To use this formatter for them:

```jsonc
// settings.json
"[yaml]": { "editor.defaultFormatter": "local.helm-navigator" }
```

## Development

```bash
npm install
npm test                 # unit tests (core is vscode-free)
npm run build            # dist/extension.js + dist/cli.js
npm run package          # helm-navigator-<version>.vsix
```

Press F5 in VS Code to start an Extension Development Host on `test/fixtures`.

### Prove the formatter does not change rendering

```bash
node scripts/verify-render.mjs <root-dir> <chart-rel-path> [helm template args...]
```

Copies the directory to a temp folder, runs `helm template`, formats every file, renders again, and compares.

### CLI (for CI)

```bash
node dist/cli.js check  path/to/chart   # exit 1 if formatting is needed
node dist/cli.js format path/to/chart
```

## Publishing

Releases on GitHub carry both VSIX files (see [安裝](#安裝)). To publish to a marketplace instead, change
`publisher` in `package.json` (also the `configurationDefaults` formatter id, `EXTENSION_ID` in
`src/extension.ts`, and `extensionDependencies` in `colors/package.json`), then `vsce publish` (VS Code
Marketplace) / `ovsx publish` (Open VSX).

## Known limitations

- `define` call contexts are inferred one level deep: a call inside another `define` body is evaluated
  as if that body ran with the root context. `dict` / `list` arguments are not modelled.
- Dynamic keys (`index .Values $k`, `tpl`) cannot be resolved statically.
- Template syntax inside values files is plain string content for Helm (it only renders through `tpl`). It must
  be quoted or in a block scalar; an unquoted `key: {{ ... }}` is invalid YAML for Helm, and the formatter
  leaves such files untouched.
- `import-values` is modelled one level (a value imported into a chart that itself re-imports it upward is not followed).
- A workspace without `Chart.yaml` (e.g. a repo with only `helm/*-values.yaml`) is not treated as a Helm project:
  its values files are still formatted, but the default-formatter prompt does not appear. Run
  *Helm Navigator: Use as Default Formatter in This Workspace* there if wanted.

## License

MIT, see `LICENSE`. The file icon theme in `colors/icons/` is based on VS Code's Seti theme (MIT); its notices are in `colors/icons/SETI-NOTICES.txt`.
