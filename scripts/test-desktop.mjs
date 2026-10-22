import { runTests, downloadAndUnzipVSCode } from "@vscode/test-electron";
import { build } from "esbuild";
import path from "node:path";
import { createFixture } from "./fixtures.mjs";
const root = process.cwd();
const fixture = path.resolve(".dev", `desktop-test-${Date.now()}`);
await createFixture(fixture);
await build({
  entryPoints: ["test/desktop.ts"],
  outfile: ".dev/desktop-test.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
const executable =
  process.env.VSCODE_EXECUTABLE_PATH ??
  (await downloadAndUnzipVSCode({ cachePath: path.resolve(".dev/vscode") }));
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.resolve(".dev/desktop-test.cjs"),
  extensionTestsEnv: { CHANGES_PROJECT_ROOT: root },
  launchArgs: [
    fixture,
    "--disable-extensions",
    "--disable-gpu",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--user-data-dir",
    path.resolve(
      process.env.VSCODE_EXECUTABLE_PATH
        ? ".dev/cursor-profile"
        : ".dev/desktop-profile",
    ),
    "--extensions-dir",
    path.resolve(
      process.env.VSCODE_EXECUTABLE_PATH
        ? ".dev/cursor-extensions"
        : ".dev/desktop-extensions",
    ),
  ],
});
