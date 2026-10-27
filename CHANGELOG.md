# Changelog

## 0.6.1

- Android apps without product flavors run as before build variants: `installDebug`, then a launch of the debug application ID, with no Gradle read of variants and no variant combo box. Apps with `productFlavors` keep the build variant combo box.

## 0.6.0

- Attach Debugger to Process, as in Android Studio and IntelliJ: a button beside the run widget (and `⌥⇧F5` / `Ctrl+Alt+F5`) lists debuggable apps on connected devices and emulators, with this project's apps first, local JVMs started with a JDWP agent, and a Remote JVM entry for any `host:port`. The chosen process is attached to without restarting it, with breakpoints, stepping, variables and the call stack, and sources found in every module and flavor. It uses the Debugger for Java extension and offers to install it. Breakpoints in Kotlin files are not supported by that debugger.

## 0.5.0

- Search Everywhere, as in IntelliJ: press `Shift` twice in the workbench to search classes, files, symbols (functions and methods), actions and text, with camel-hump matching and **All / Classes / Files / Symbols / Actions / Text** tabs.
- Find in Files (`⌘⇧F` / `Ctrl+Shift+F`): text search across the repository with a live preview of each match, match case, whole words, regular expressions and a file mask.
- Go to definition reaches Kotlin extension functions and properties (`total.toMoney()`, `name.initials`) when they are imported or in the same package, including in large projects where the extension is used in many files, in new files not yet committed, and in files with a comment right after the `package` line.
- Faster Changes view: the panel stays loaded when you switch tabs, reopening shows the last change list at once while Git refreshes, and run configurations no longer hold up the change list.
- Build, as in IntelliJ: the hammer beside the run configurations (or `⌘F9` / `Ctrl+F9`) compiles what the selected configuration runs without running it — `classes` for Gradle Application and Kotlin configurations, `mvn compile` for Maven, and `assemble<Variant>` with the chosen build variant for Android apps.
- No run configuration is selected until you pick one, so opening the workbench never starts a Gradle read for an Android app. ▶ in the status bar asks which configuration to run.

## 0.4.0

- Build variants for Android apps, as in Android Studio: selecting an Android app shows a combo box with the module's variants (product flavors × build types), read from Gradle and remembered per configuration. ▶ installs that variant and launches it with its own application ID, so projects with flavors no longer fail with "task 'installDebug' is ambiguous". Also **Changes: Select Build Variant…** in the Command Palette.
- Root build files that only declare the Android plugin with `apply false` are no longer listed as apps.
- Submodules and nested Git repositories open as a `Subproject commit` diff instead of failing with "EISDIR: illegal operation on a directory".

## 0.3.0

- Application, Kotlin and Spring Boot run configurations now run: their main class is compiled and started on the module's runtime classpath through Gradle (or Maven), with program arguments, VM options, working directory and environment.
- Android app modules are detected anywhere in the repository, including Android builds in subfolders, and listed as run configurations. ▶ installs the debug build and launches it on the device or emulator.
- Run configurations are also read from `.idea/workspace.xml` and from Gradle builds in subfolders.
- IntelliJ-style find bar in the diff (`⌘F` / `Ctrl+F`) with match counter, next/previous, match case, whole words and regex.

## 0.2.0

- Rollback from the gutter, as in IntelliJ: click a blue, green or grey-arrow change marker for the original lines, previous/next change, copy and **Rollback**. Also `⌘⌥Z` / `Ctrl+Alt+Z` and **Rollback Lines** in the right-click menu.
- Run IntelliJ run configurations from `.run/` and `.idea/runConfigurations/`: a run widget with ▶ Run / Rerun and ■ Stop in the workbench, a status bar button, and `Ctrl+R` / `Shift+F10` (`Ctrl+⌥R` / `Alt+Shift+F10` to choose). Supports Gradle, Maven, Shell Script, npm, Python and Compound configurations.
- Hold `⌘` / `Ctrl` over a function or class in the diff to underline it as a link when it has a definition.

## 0.1.0

First public release.

- Change tree with All / Staged / Unstaged scopes, filters and review marks.
- Side-by-side and unified diff with IntelliJ shortcuts (`F7`, `Alt+Left/Right`, `F4`, `⌘B`).
- Git blame from the gutter: right-click **Annotate with Git Blame**, click an annotation to open its commit.
- Hover documentation and definition preview in the diff.
- Lightweight Kotlin/Java navigation with Tree-sitter, no setup required.
- Optional deep analysis with Kotlin LSP and Eclipse JDT LS: background indexing with progress, files you open are prioritized while indexing, live updates as files change, Kotlin standard library resolution, and graceful fallback when a server is not installed.
- IntelliJ-style Dark, Darcula and Light color themes.
