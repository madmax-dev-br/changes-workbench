# Contributing

## Build and test

Requires Node.js 22+, npm and Git.

```sh
npm ci
npm run check
npm run build
npm test
npm run package   # builds changes-workbench.vsix
```

`vscode:prepublish` runs the TypeScript check and the build, so `vsce package` and `vsce publish` always ship a fresh `dist/`.

## Develop and test in a browser

Requires code-server. On macOS: `brew install code-server` (its Node runtime is available at `/opt/homebrew/opt/node@22/bin`).

```sh
npm run dev:web
```

Open the localhost URL printed by the script. The VSIX, code-server profile and generated Git fixture are isolated from your regular editor settings. The server binds to `127.0.0.1`. Use `PORT=8081 npm run dev:web` if needed. Stop it with Ctrl+C.

```sh
npm run test:web     # real extension in code-server; dev:web must be running
npm run bench        # generated 10,000-file repository
npm run review       # local visual review and owner-only approval
npm run test:desktop # downloads isolated VS Code and runs extension-host tests
```

To test an installed Cursor without changing its normal profile:

```sh
VSCODE_EXECUTABLE_PATH="/Applications/Cursor.app/Contents/MacOS/Cursor" npm run test:desktop
```

Set `KOTLIN_LSP_COMMAND` as well to also check that the live Kotlin index resolves a file created after the server started.

## Real language-server tests

Set `JDTLS_COMMAND` and `KOTLIN_LSP_COMMAND` to local launchers, then run `npm run test:lsp`. Set `JAVA_HOME` to the JDK required by JDT LS. This opt-in test starts and stops real servers, creates a small project under `.dev/`, and writes `test-results/real-lsp.json`. The Kotlin test uses the current `intellij-server` launcher; its older `kotlin-lsp.sh` wrapper is deprecated. Downloaded runtimes are development fixtures and are not bundled into the VSIX.

Real-server smoke tests passed with Kotlin LSP 263.7084.0 and Eclipse JDT LS 1.63.0. That JDT build required Java 25 at runtime.

## GitHub builds

[Actions → Build VSIX](https://github.com/madmax-dev-br/changes-workbench/actions/workflows/vsix.yml) runs on pushes to `main`, pull requests targeting `main`, and **Run workflow**. It uses Node.js 22, installs the lockfile with `npm ci`, builds and typechecks the extension, runs the Git/navigation/server lifecycle tests, verifies the packaged assets, and retains the VSIX artifact (with a SHA-256 checksum) for 30 days.

## Visual review

Screenshots and results are recorded under `docs/layout-review/`. Approval belongs to the project owner through `npm run review`; agents never mark approvals. Screenshot/content fingerprints invalidate stale approvals.

## Publishing

The extension is published to [Open VSX](https://open-vsx.org/), the registry Cursor, VSCodium and Windsurf use, under the `madmax-dev-br` namespace. Create an access token at open-vsx.org › Settings › Access Tokens and keep it in `OVSX_PAT`.

```sh
npm run package
npx ovsx publish changes-workbench.vsix -p "$OVSX_PAT"
```

Bump `version` in `package.json` and add a `CHANGELOG.md` entry before each release; a version can be published only once.
