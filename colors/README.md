# Helm Navigator Colors & Icons

IntelliJ-style colors for the **Helm Values** and **Helm Template** languages of Helm Navigator, for dark
themes. Only `source.helm-values` / `source.helm-template` scopes are colored; other YAML and other languages
keep your theme. Disable this extension (globally or per workspace) to get your theme's colors back.

| Element | Color |
|---|---|
| YAML keys, `.Values` path segments (`.Values` / `.Release` italic) | `#56A8F5` |
| `{{ }}` (bold), `if` / `range` / `with` / `end`, `true` / `false` / `null`, `\|-` | `#CF8E6D` |
| template functions (`include`, `toYaml`, `quote`, …), anchors | `#E5C07B` |
| quoted strings | `#6AAB73` |
| numbers | `#2AACB8` |
| plain scalars, pipes, punctuation, `$variables` (italic) | `#BCBEC4` |
| comments | `#7A7E85` |

Base colors (keyword, string, number, comment, text) come from IntelliJ's New UI *Dark* scheme
(`expUI_darkScheme.xml` in JetBrains/intellij-community); the key and function colors are design choices.
Bracket pair colorization is turned off for these two languages so `{{ }}` take the colors above.

To adjust a color, edit `contributes.configurationDefaults` in `package.json` and run `npm run package:colors`
from the repository root. Your own `editor.tokenColorCustomizations.textMateRules` replaces these rules.

## Icons

| File | Icon | Color (dark / light) |
|---|---|---|
| Helm Template (`templates/*.yaml`, `NOTES.txt`) | `{·}` | `#CF8E6D` / `#A9562A` |
| helpers (`templates/*.tpl`) | `ƒ` | `#E5C07B` / `#9A7A16` |
| Helm Values (`values*.yaml`, `*-values.yaml`, …) | key/value rows | `#56A8F5` / `#2470C0` |

Two ways they show up:

- **Language icons** (any file icon theme, e.g. the default Seti): Helm Template and Helm Values files get their
  icon because Seti has none for these languages. `.tpl` keeps Seti's Smarty icon: a file icon theme's
  extension rule wins over a language icon.
- **File icon theme "Helm Navigator Icons (Seti)"** (*Preferences: File Icon Theme*): a copy of VS Code's Seti
  theme with the three Helm icons added, so `templates/*.tpl` gets the `ƒ` icon too. Entries such as
  `templates/yaml` only match files directly inside a `templates` folder.

The SVGs and the theme are generated: edit `scripts/icons.mjs`, then run `node scripts/build-icons.mjs` (it copies
Seti from the installed VS Code; pass another `theme-seti` folder as the argument) and `npm run package:colors`
from the repository root. Seti is MIT licensed; its notices are in `icons/SETI-NOTICES.txt`.
