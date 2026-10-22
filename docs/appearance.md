# IntelliJ appearance and keymap

The extension includes **Changes: IntelliJ Dark**, **Changes: IntelliJ Darcula**, and **Changes: IntelliJ Light**. Click **Theme** in the review footer, or run **Changes: Choose IntelliJ Theme**. This applies the palette to both VS Code/Cursor and the review webview. These are ports of the color values, not JetBrains UI components. Syntax uses lexical tokenization in lightweight mode; semantic classifications can differ from IntelliJ.

The palettes in `src/palettes.json` were mapped from JetBrains' open-source color definitions on 2026-10-22:

- [Default and Darcula editor schemes](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-resources/src/DefaultColorSchemesManager.xml)
- [Dark editor scheme](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-resources/src/themes/expUI/expUI_darkScheme.xml)
- [Light editor scheme](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-resources/src/themes/expUI/expUI_lightScheme.xml)
- [Dark UI palette](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-resources/src/themes/expUI/expUI_dark.theme.json)
- [Light UI palette](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-resources/src/themes/expUI/expUI_light.theme.json)

Additions are green, modifications blue, deletions gray, following the [IntelliJ diff viewer](https://www.jetbrains.com/help/idea/differences-viewer.html). This updates the earlier red-deletion design to match the requested IntelliJ colors.

## Shortcuts

Enabled by default. Disable `changesWorkbench.intellijKeymap` if you prefer another keymap. User-defined VS Code shortcuts take precedence. Terminal shortcuts are not remapped. Browser/OS shortcuts may be intercepted; desktop is the reference for keyboard behavior.

| Action | macOS | Windows/Linux |
|---|---|---|
| Open Changes | ⌘9 or ⌘0 | Alt+9 or Alt+0 |
| Next / previous difference | F7 / ⇧F7 | F7 / Shift+F7 |
| Next / previous review file | ⌥→ / ⌥← | Alt+Right / Alt+Left |
| Open source at cursor | F4 | F4 |
| Definition | ⌘B | Ctrl+B |
| Documentation | F1 | Ctrl+Q |
| Recent files | ⌘E | Ctrl+E |
| Find action | ⌘⇧A | Ctrl+Shift+A |
| Go to file | ⌘⇧O | Ctrl+Shift+N |
| Back / forward | ⌘[ / ⌘] | Ctrl+Alt+Left / Right |
| Find usages | ⌥F7 | Alt+F7 |
| Rename | ⇧F6 | Shift+F6 |
| Format | ⌘⌥L | Ctrl+Alt+L |
| Duplicate line | ⌘D | Ctrl+D |
| Delete line | ⌘⌫ | Ctrl+Y |
| Expand / shrink selection | ⌥↑ / ⌥↓ | Ctrl+W / Ctrl+Shift+W |

The complete contributed mapping is in `package.json`. The scope is review and supported VS Code navigation/editing actions; this is not the entire IntelliJ keymap. Double-tap Shift/Ctrl, Android execution, IntelliJ-specific refactorings, and bookmark slots are not implemented. Usages, rename and formatting depend on the language providers installed in the native editor. Lightweight navigation supplies definition and hover.

Sources: [IntelliJ macOS keymap](https://www.jetbrains.com/help/idea/reference-keymap-mac-default.html), [Windows keymap](https://www.jetbrains.com/help/idea/reference-keymap-win-default.html).
