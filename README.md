# Changes Workbench

An IntelliJ-style review workspace for VS Code and Cursor: a change tree, one reusable diff, Git blame in the gutter, and Kotlin/Java navigation that works right away and gets precise once a language server has indexed the project.

The workbench is read-only. It reviews files without staging, committing, discarding or saving them; use **Open in editor** (`F4`) to edit.

## Features

- **Change tree with scopes.** All changes compares `HEAD` to the current editor buffer, including unsaved edits. Staged compares `HEAD` to the index; Unstaged compares the index to the buffer. Filter the tree by name or status, and mark files as reviewed. A review mark clears itself when the file or its base changes.
- **One diff, IntelliJ keys.** Side-by-side or unified. `F7` / `Shift+F7` move between changes, `Alt+Left` / `Alt+Right` switch files.
- **Git blame in the gutter.** Right-click the line numbers and choose **Annotate with Git Blame**: the date and author appear beside each line. Hover an annotation for the commit message, click it to open that commit's diff, and choose **Close Annotations** to hide them again.
- **Hover and go to definition.** Hover a symbol for its signature, documentation and the line's blame. `⌘B` / `Ctrl+B` shows a definition preview; open it in the editor from there.
- **Lightweight navigation, no setup.** Kotlin and Java files are parsed on demand with Tree-sitter, using scopes, packages and imports. It needs no Java runtime and no project import. Ambiguous member calls show candidates instead of guessing.
- **Optional deep analysis.** Turn on **On demand** to use Kotlin LSP and/or Eclipse JDT LS for exact resolution, including the Kotlin standard library. See below.
- **IntelliJ keymap and themes.** IntelliJ shortcuts for review, navigation, search and editing are on by default. **Changes: Choose IntelliJ Theme** applies a Dark, Darcula or Light color scheme to the whole editor.

## Getting started

1. Open a folder that contains a Git repository.
2. Run **Changes: Open Workbench**, click **Changes** in the status bar, or press `⌘9` / `⌘0` (`Alt+9` / `Alt+0` on Windows and Linux).
3. Pick a file in the tree and review its diff.

## Deep analysis (optional)

Deep analysis starts local language servers for exact definitions across the project and its libraries.

1. Install [Kotlin LSP](https://github.com/Kotlin/kotlin-lsp) for Kotlin (it also resolves Kotlin → Java), and/or [Eclipse JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls) with a compatible Java runtime for navigation inside `.java` files.
2. Run **Changes: Configure Language Servers** to check whether each launcher is found, and set its path and arguments. The defaults are `kotlin-lsp --stdio` and `jdtls`.
3. Click **On demand** in the workbench.

The servers start right away and index in the background. The status line shows import and indexing progress. While the index builds, the file you are looking at and the likely targets of `⌘B` are analyzed first, so definitions usually resolve before indexing finishes. Otherwise you get lightweight results with a note. New, changed and deleted files are picked up as you work.

When the repository has no Gradle or Maven build at its root, the extension describes its Kotlin/Java source roots to Kotlin LSP itself, together with the Kotlin standard library from your Gradle or Maven cache and a JDK. That description lives in extension storage, never in your repository. If a server is not installed, navigation falls back to lightweight results for that language.

**Changes: Stop Deep Analysis** stops the servers this extension started. They also stop after ten idle minutes (`changesWorkbench.deepIdleMinutes`) and when the window closes. Project import may run build-tool code and resolve dependencies, so deep analysis only runs in trusted workspaces. Gradle caches and JDT workspace data stay in extension storage.

## Shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Open workbench | `⌘9` / `⌘0` | `Alt+9` / `Alt+0` |
| Next / previous change | `F7` / `Shift+F7` | `F7` / `Shift+F7` |
| Next / previous file | `Alt+Right` / `Alt+Left` | `Alt+Right` / `Alt+Left` |
| Go to definition | `⌘B` | `Ctrl+B` |
| Quick documentation | `F1` | `Ctrl+Q` |
| Open in editor | `F4` | `F4` |

The full mapping, including editing and search shortcuts in regular editors, is in `docs/appearance.md`. Set `changesWorkbench.intellijKeymap` to `false` if you use another keymap extension.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `changesWorkbench.diffLayout` | `sideBySide` | Initial diff presentation (`sideBySide` or `unified`). |
| `changesWorkbench.intellijKeymap` | `true` | IntelliJ shortcuts for navigation, editing, search and review. |
| `changesWorkbench.kotlin.command` / `.args` | `kotlin-lsp`, `["--stdio"]` | Kotlin LSP launcher. |
| `changesWorkbench.java.command` / `.args` | `jdtls`, `[]` | Eclipse JDT LS launcher. |
| `changesWorkbench.deepIdleMinutes` | `10` | Stop the language servers after this many idle minutes. |
| `changesWorkbench.cacheMiB` | `64` | Parsed-source cache size for lightweight navigation. |

## Privacy and limits

- No telemetry and no CDN: the webview, Monaco and the Tree-sitter grammars ship inside the extension, and the extension itself makes no network requests. Language servers you enable may resolve project dependencies.
- Git runs with argument arrays, output and time limits, and at most two processes at a time.
- Parsing is capped at 2 MiB per file and diff rendering at 5 MiB; binary files show an explanatory state. Source parsing does not follow symlinks outside the repository.
- Android projects depend on each language server and are experimental. Deep-analysis failures fall back to lightweight results and are logged in **Output → Changes Workbench**.

Third-party licenses are listed in `assets/THIRD_PARTY_NOTICES.txt`. IntelliJ and Darcula are trademarks of JetBrains s.r.o. This extension is not affiliated with or endorsed by JetBrains.
