# Changes Workbench

[![Build VSIX](https://github.com/madmax-dev-br/changes-workbench/actions/workflows/vsix.yml/badge.svg)](https://github.com/madmax-dev-br/changes-workbench/actions/workflows/vsix.yml)

A focused review workspace for VS Code and Cursor: an IntelliJ-inspired change tree, one reusable diff, line history, and on-demand Kotlin/Java navigation.

## Install

Run **Extensions: Install from VSIX** and select `changes-workbench.vsix`. Open a Git folder, then run **Changes: Open Workbench** (`⌘9` / `⌘0` on macOS, `Alt+9` / `Alt+0` elsewhere).

The workbench reviews files without staging, committing, discarding, or saving them. Use **Open in editor** to edit. All changes compares HEAD to the current editor buffer, including unsaved edits. Staged compares HEAD to the index; unstaged compares the index to the current buffer.

## Download a GitHub build

Open [Actions → Build VSIX](https://github.com/madmax-dev-br/changes-workbench/actions/workflows/vsix.yml), select a successful run, and download its `changes-workbench-<version>-<commit>` artifact. Extract the ZIP and install `changes-workbench-<version>.vsix` using **Extensions: Install from VSIX**. A SHA-256 checksum is included. Sign in with access to this private repository to download artifacts.

The workflow runs on pushes to `main`, pull requests targeting `main`, and **Run workflow**. It uses Node.js 22, installs the lockfile with `npm ci`, builds and typechecks the extension, runs the Git/navigation/server lifecycle tests, verifies the packaged assets, and retains the VSIX artifact for 30 days. Browser, desktop and real language-server tests remain separate validation commands documented below.

## IntelliJ shortcuts and colors

The IntelliJ keymap is enabled by default for supported review, navigation, search and editing actions. Run **Changes: Choose IntelliJ Theme** (or click **Theme**) to apply Dark, Darcula or Light to the whole editor. `F7` / `Shift+F7` move through differences, `Alt+Left/Right` switch review files, `F4` opens the editor, and `⌘B` / `Ctrl+B` opens a definition. The full mapping and scope are documented in `docs/appearance.md` (included in the package).

## Develop and test in a browser

Requires Node.js 22+, npm, Git, and code-server. On macOS: `brew install code-server` (its Node runtime is available at `/opt/homebrew/opt/node@22/bin`).

```sh
npm ci
npm run check
npm run build
npm test
npm run dev:web
```

Open the localhost URL printed by the script. The VSIX, code-server profile and generated Git fixture are isolated from your regular editor settings. The server binds to `127.0.0.1`. Use `PORT=8081 npm run dev:web` if needed. Stop it with Ctrl+C.

```sh
npm run test:web   # real extension in code-server; dev:web must be running
npm run bench     # generated 10,000-file repository
npm run review    # local visual review and owner-only approval
npm run package   # builds changes-workbench.vsix
npm run test:desktop # downloads isolated VS Code and runs extension-host tests
```

## Navigation

Lightweight mode parses only requested Kotlin/Java files with Tree-sitter in a worker. It discovers file names and searches for the requested symbol when needed; it does not build a semantic index of the workspace. Results use scopes, packages and imports. Ambiguous member calls show candidates instead of claiming exact type resolution. Hover for documentation, or use **Preview Definition** / `⌘B` (`Ctrl+B` inside the diff).

The default cache budget is 64 MiB. Parsing is capped at 2 MiB per file. Diff rendering is capped at 5 MiB, and binary files show an explanatory state. Source parsing does not follow symlinks outside the repository.

## Optional deep analysis

Real-server smoke tests passed with Kotlin LSP 263.7084.0 and Eclipse JDT LS 1.63.0. That JDT build required Java 25 at runtime; check the requirements of your chosen build. Tests used a small JVM project, not an Android project.

Install a standalone [Kotlin LSP](https://github.com/Kotlin/kotlin-lsp) and/or [Eclipse JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls) with a compatible Java runtime. Configure their launcher paths and argument arrays in **Changes: Configure Language Servers**. Defaults are `kotlin-lsp --stdio` and `jdtls`. Launcher options may differ between releases; use the flags supported by your installed version.

Click **On demand** to enable deep analysis. The installed servers for the repository's languages start right away and index in the background; the status line shows import and indexing progress. While the index is building, the file you view (in the review or the editor) is opened on the server first, and a definition request also opens its likely targets and the files they import or share a package with, so it usually resolves before the full index is done; otherwise lightweight results are shown with a note. File creations, edits and deletions are forwarded to servers that watch files (JDT LS); Kotlin LSP follows the disk itself. When the repository has no Gradle or Maven build at its root, a `workspace.json` describing its Kotlin/Java source roots is generated in extension storage (never in the repository) and reloaded when new source roots appear. **Changes: Stop Deep Analysis** stops processes started by this extension; servers also stop after ten idle minutes or when the extension shuts down. Existing third-party extensions control their own processes independently. Gradle caches and JDT workspace data are isolated in extension storage. Project import may run build-tool code and resolve dependencies; deep analysis only runs in trusted workspaces.

Android integration depends on each server and is experimental. Ordinary Git review and lightweight navigation require no Java runtime. Deep server failures fall back to lightweight candidates and are logged in **Output → Changes Workbench**.

## Visual review

Screenshots and results are recorded under `docs/layout-review/`. Approval belongs to the project owner through `npm run review`; agents never mark approvals. Screenshot/content fingerprints invalidate stale approvals. Browser validation is supplemented with desktop VS Code/Cursor smoke tests where installed.

## Build and dependencies

The extension uses stable VS Code APIs, a local React/Monaco webview, and bundled Tree-sitter WASM grammars. No CDN is used at runtime. Git commands use argument arrays, output/time limits and a two-process queue. No telemetry is added by the extension.

Third-party licenses are shipped in `assets/THIRD_PARTY_NOTICES.txt`.

## Reproduce optional real-server tests

Set `JDTLS_COMMAND` and `KOTLIN_LSP_COMMAND` to local launchers, then run `npm run test:lsp`. Set `JAVA_HOME` to the JDK required by JDT LS. This opt-in test starts and stops real servers, creates a small project under `.dev/`, and writes `test-results/real-lsp.json`. The Kotlin test uses the current `intellij-server` launcher; its older `kotlin-lsp.sh` wrapper is deprecated. Downloaded runtimes are development fixtures and are not bundled into the VSIX.

To test an installed Cursor without changing its normal profile:

```sh
VSCODE_EXECUTABLE_PATH="/Applications/Cursor.app/Contents/MacOS/Cursor" npm run test:desktop
```
