# Changes Workbench

An IntelliJ-style review workspace for VS Code and Cursor: a change tree, one reusable diff with gutter Rollback, Git blame in the gutter, IntelliJ run configurations, and Kotlin/Java navigation that works right away and gets precise once a language server has indexed the project.

The workbench never stages or commits. The only edit it makes is a **Rollback** you ask for from the gutter; use **Open in editor** (`F4`) for anything else.

## Features

- **Change tree with scopes.** All changes compares `HEAD` to the current editor buffer, including unsaved edits. Staged compares `HEAD` to the index; Unstaged compares the index to the buffer. Filter the tree by name or status, and mark files as reviewed. A review mark clears itself when the file or its base changes.
- **One diff, IntelliJ keys.** Side-by-side or unified. `F7` / `Shift+F7` move between changes, `Alt+Left` / `Alt+Right` switch files.
- **Rollback from the gutter.** Click a blue (modified), green (added) or grey-arrow (deleted) marker to see the original lines, step to the previous or next change, copy the original, or **Rollback** just that change, as in IntelliJ. `⌘⌥Z` / `Ctrl+Alt+Z` rolls back the change under the cursor, and the right-click menu has **Rollback Lines**. The edit goes into the working file (or its unsaved buffer) and can be undone with `⌘Z` / `Ctrl+Z` in the editor. Staged changes and merge conflicts are not rolled back from here.
- **Run configurations.** IntelliJ run configurations from `.run/*.run.xml`, `.idea/runConfigurations/*.xml` and `.idea/workspace.xml` appear in the workbench's run widget and in the status bar, including those of Gradle builds that live in subfolders. Press ▶ to run the selected one in its own terminal, ■ to stop it, or ▶ again to rerun. Gradle (using `gradlew` when present), Maven (`mvnw`), Shell Script, npm/yarn/pnpm, Python and Compound configurations run with their working directory and environment. **Application**, **Kotlin** and **Spring Boot** configurations compile and run their main class on the module's runtime classpath through Gradle (or `mvn exec:java`), with the program arguments, VM options and environment from the configuration.
- **Build.** The hammer beside the run configurations (or `⌘F9` / `Ctrl+F9`) compiles what the selected configuration runs, without running it, as IntelliJ's Build: `classes` for Gradle Application and Kotlin configurations, `mvn compile` for Maven ones, and `assemble<Variant>` (the chosen build variant, or `assembleDebug`) for Android apps.
- **Attach Debugger to Process.** The bug-with-arrow button beside the run widget (or `⌥⇧F5` / `Ctrl+Alt+F5`) lists what a debugger can attach to, as in Android Studio and IntelliJ: debuggable apps on every connected device or emulator (this project's apps marked first), local JVMs started with `-agentlib:jdwp=…,server=y`, and **Remote JVM…** for any `host:port`. Pick one and VS Code's debugger attaches without restarting it: breakpoints, stepping, variables and the call stack, with the app's sources found in every module and flavor. It uses Microsoft's **Debugger for Java** (with Red Hat's **Language Support for Java**), and offers to install them the first time. Line breakpoints work in Java files; that debugger cannot bind breakpoints in Kotlin files.
- **Android apps and build variants.** Every Android app module (`com.android.application`) is listed as a run configuration, the way Android Studio creates one, even when the Android build sits in a subfolder of the repository. When an Android app declares product flavors, a second combo box lists its build variants (for example `interHmgDebug` or `pjMockServerDebug`), read from Gradle once and remembered; **Changes: Select Build Variant…** does the same from the Command Palette and can reload them. ▶ installs the chosen variant and launches it on the connected device or emulator with that variant's application ID. An app without flavors runs `installDebug` and launches its debug application ID, with no variant read. Android Studio's own Android App configurations are used when they are shared or in `workspace.xml`.
- **Find in the diff.** `⌘F` / `Ctrl+F` opens IntelliJ's find bar over the side of the diff you are in: incremental search with a match counter, `Enter` / `⇧Enter` (or `⌘G` / `F3`) for next and previous, **Aa** match case, **W** whole words and **.\*** regular expressions. `Esc` closes it.
- **Search Everywhere and Find in Files.** In the workbench, press `Shift` twice for IntelliJ's Search Everywhere: **All**, **Classes**, **Files**, **Symbols**, **Actions** and **Text** tabs (`Tab` switches), with camel-hump matching (`PriCal` finds `PriceCalculator`, `calcTot` finds `calculateTotal`). `⌘⇧F` / `Ctrl+Shift+F` opens Find in Files: matches across the repository with a preview of the file below, **Aa** match case, **W** whole words, **.\*** regular expressions and a file mask such as `*.kt, *.java`. `Enter` opens the result in the editor. Both start with the selected text, respect `.gitignore`, and use the ripgrep that ships with VS Code and Cursor. Classes and functions come from a fast scan of Kotlin, Java, Scala, Groovy, TypeScript, JavaScript, Python, Go, Swift, Dart, Rust, C#, Ruby and PHP declarations; the Command Palette also has **Changes: Search Everywhere** and **Changes: Find in Files…**.
- **Git blame in the gutter.** Right-click the line numbers and choose **Annotate with Git Blame**: the date and author appear beside each line. Hover an annotation for the commit message, click it to open that commit's diff, and choose **Close Annotations** to hide them again.
- **Hover and go to definition.** Hover a symbol for its signature, documentation and the line's blame. Hold `⌘` (`Ctrl` on Windows and Linux) to underline functions and classes that have a definition, then click to preview it. `⌘B` / `Ctrl+B` shows a definition preview; open it in the editor from there.
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
| Find in the diff | `⌘F` | `Ctrl+F` |
| Next / previous occurrence | `⌘G` / `⇧⌘G` | `F3` / `Shift+F3` |
| Search Everywhere | `Shift` `Shift` | `Shift` `Shift` |
| Find in Files | `⌘⇧F` | `Ctrl+Shift+F` |
| Rollback lines | `⌘⌥Z` | `Ctrl+Alt+Z` |
| Run selected configuration | `Ctrl+R` | `Shift+F10` |
| Build selected configuration | `⌘F9` | `Ctrl+F9` |
| Attach debugger to process | `⌥⇧F5` | `Ctrl+Alt+F5` |
| Choose and run a configuration | `Ctrl+⌥R` | `Alt+Shift+F10` |

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
