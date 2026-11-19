# Helm Navigator — Reference

Detailed behavior, settings and development notes. For installation and an overview, see [README.md](README.md).

## Updating and uninstalling

- Updates are not automatic: download the new VSIX files from
  [Releases](https://github.com/wilsontw0423-design/helm-navigator/releases/latest) and install them the same way
  (main extension first) to replace the old version.
- To uninstall, remove **Helm Navigator Colors & Icons** first, then **Helm Navigator**.

## Troubleshooting

- **The status bar shows `YAML` instead of Helm Template / Helm Values**: the file must be inside a folder with a
  `Chart.yaml` above it, and `helmNavigator.assignLanguages` must be on. Navigation and diagnostics work by path
  either way.
- **Red Hat YAML / JSON Schema errors in a values file**: the file is still open as `yaml`; see the previous item.
- **Back to your theme's colors and icons**: disable **Helm Navigator Colors & Icons** and switch the file icon
  theme back to *Seti*.

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

### Render (helm template)

*Helm Navigator: Render This Template* and *Helm Navigator: Render Chart* run `helm template` and open the result
beside the editor as a read-only YAML document (editor title button, Explorer context menu on templates and
`Chart.yaml`, or the Command Palette). Requires `helm` on the machine (`helmNavigator.helmPath`).

- **Values**: pick an environment (the same environments as navigation: each is a `-f` chain on top of the root
  chart's `values.yaml`), or *values.yaml only*. The last choice is listed first.
- **Release name / namespace**: per root chart and environment, set with the last item of the environment picker
  (*Set release name / namespace…*) or *Helm Navigator: Set Release Name / Namespace*. Unset, helm's defaults apply
  (`release-name`; without `--namespace` helm uses the kubeconfig context's namespace, else `default`). The values
  are stored for this workspace on this machine and shown at the top of the preview.
- **Subcharts**: a subchart is rendered through its top-level parent, so parent overrides, `global.*` and
  `import-values` apply. When a chart is used by several parents, you pick which one.
- **One template**: the whole root chart is rendered and the output is filtered by its `# Source:` headers
  (`--show-only` is not used: it fails with "could not find template" when a template renders to nothing). A
  template whose output is empty in the chosen values says so. `_helpers.tpl` / `_*` partials and `NOTES.txt`
  are never printed by `helm template`; rendering them renders the whole chart instead.
- **Errors**: template errors (`nil pointer`, `fail`, parse errors) are shown on the template line they point
  at. When the output is not valid YAML, the output is rendered again with `--debug` so you can see it; YAML
  line numbers refer to the rendered manifest. Missing dependencies offer `helm dependency build`.
- **One preview that follows you** (like the Markdown preview): while it is open, switching to another template
  shows that template (another chart: rendered with that chart's last environment; never asked before, the preview
  says how to choose). After *Render Chart* it follows charts instead. Saving any file of the chart tree renders
  again. One helm run per root chart and environment is cached, so switching between its templates is instant;
  pressing the button always runs helm again (and lets you change the environment).
- **What is previewed**: the tab title names the template (or chart) and the environment, e.g. `statefulset · stage`;
  the status bar shows template, environment, release and namespace (hover for the values chain, click to choose
  another environment). The preview uses the Helm Values language, so it gets the Helm colors and no YAML /
  JSON Schema checks.
- Helm reads files from disk: with unsaved changes in the chart tree you are offered *Save All*, which renders again.

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
| `helmNavigator.helmPath` | `helm` | `helm` executable for *Render Chart* / *Render This Template* |

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

Releases on GitHub carry both VSIX files (see the README). To publish to a marketplace instead, change
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
