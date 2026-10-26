# Changelog

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
