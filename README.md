# Helm Navigator

Helm chart support for VS Code and Antigravity: dedicated languages for chart files, navigation across
templates, helpers and values files, and a live `helm template` preview.

## How to use

### Install

1. Download from [Releases](https://github.com/wilsontw0423-design/helm-navigator/releases/latest):
   - `helm-navigator-<version>.vsix`: the extension (required).
   - `helm-navigator-colors-<version>.vsix`: colors and file icons (optional).
2. Install the extension first, then the colors package (it depends on the extension).

   **No terminal needed** (same in VS Code and Antigravity IDE): open the Extensions view, click the `…` menu at
   the top, choose *Install from VSIX…*, and select the downloaded file; then do the same for the colors package.
   You can also run *Extensions: Install from VSIX…* from the Command Palette.

   **Or from a terminal**: the commands use bare file names, so first go to the folder you downloaded them to
   (otherwise you get `ENOENT: no such file or directory`):

   ```bash
   cd ~/Downloads
   ```

   - **VS Code**

     ```bash
     code --install-extension helm-navigator-0.2.0.vsix
     code --install-extension helm-navigator-colors-0.1.0.vsix
     ```

   - **Antigravity IDE** (macOS; its CLI is inside the app bundle)

     ```bash
     "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" --install-extension helm-navigator-0.2.0.vsix
     "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" --install-extension helm-navigator-colors-0.1.0.vsix
     ```

3. Open the Command Palette (`Cmd+Shift+P`, or `Ctrl+Shift+P` on Windows / Linux) and run *Developer: Reload Window*.
4. Open a folder that contains a chart (`Chart.yaml`). Accept the prompt to use Helm Navigator as the formatter for
   the workspace.
5. Optional: run *Preferences: File Icon Theme* and choose **Helm Navigator Icons (Seti)** to give `_helpers.tpl`
   its own icon.

The live preview needs `helm` installed on your machine.

### Everyday use

| To | Do |
|---|---|
| See where a value is set | Cmd/Ctrl+click `.Values.…` in a template; a peek window lists every values file |
| See which templates use a value | Hover over a key in a values file, or Cmd/Ctrl+click it |
| Jump to a helper | Cmd/Ctrl+click the name in `include "…"` |
| Preview the rendered template | Click the preview icon in the editor title bar, then pick an environment |
| Set release name / namespace | Choose the last item of the environment picker |
| Format a file | `Shift+Alt+F` (`Shift+Option+F` on macOS) |

See [REFERENCE.md](REFERENCE.md) for settings, detailed behavior, troubleshooting and development.

## Key features

### 1. Dedicated language modes for Helm files

Every file inside a chart is recognized by its role, regardless of your `files.associations`:

- **Helm Template**: `templates/*.yaml`, `_helpers.tpl` partials and `NOTES.txt`, with Go template highlighting
  and no false errors from YAML validators.
- **Helm Values**: `values.yaml`, `values-*.yaml` and environment files such as `environments/prod/values.yaml`,
  with an outline and folding, and no false JSON Schema errors.
- A **formatter** for every chart file type that never changes the rendered output.
- Optional companion extension **Helm Navigator Colors & Icons**: IntelliJ-style colors and dedicated file icons
  for templates, helpers and values files.

### 2. Bidirectional navigation with multi-environment values

Templates, helpers and values files are linked both ways, across parent charts and subcharts:

- From `.Values.image.tag` in a template to every values file that sets it, and from a values key to every
  template that reads it.
- From `include "app.labels"` to its `define`, wherever it lives in the chart tree.
- Every values file in a chart is treated as an environment. Hover shows the effective value in each
  environment.
- Subchart aliases, `global.*`, `import-values` and packaged `charts/*.tgz` are resolved.
- Also included: completion, warnings for undefined or unused keys, and rename across files.

### 3. Live template preview

Render a single template or a whole chart with `helm template`, side by side with the source:

- Choose which values file (environment) to render with, and set the release name and namespace per
  environment to match a real deployment.
- The preview follows the template you are editing and re-renders on save.
- Rendering errors are reported on the template line that caused them.

## License

MIT, see `LICENSE`. The file icon theme in `colors/icons/` is based on VS Code's Seti theme (MIT); its notices are
in `colors/icons/SETI-NOTICES.txt`.
