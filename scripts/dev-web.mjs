import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createFixture } from "./fixtures.mjs";
const root = process.cwd();
const dev = path.join(root, ".dev");
const fixture = path.join(dev, "checkout-demo");
await fs.mkdir(dev, { recursive: true });
try {
  await fs.access(path.join(fixture, ".git"));
} catch {
  await createFixture(fixture);
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Launch using npm run dev:web");
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: root });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
await run(process.execPath, [npm, "run", "package"]);
const codeServer = process.env.CODE_SERVER ?? "code-server";
const common = [
  "--config",
  path.join(dev, "code-server.yaml"),
  "--user-data-dir",
  path.join(dev, "user-data"),
  "--extensions-dir",
  path.join(dev, "extensions"),
];
await fs.mkdir(path.join(dev, "user-data", "User"), { recursive: true });
const settings = path.join(dev, "user-data", "User", "settings.json");
try {
  await fs.access(settings);
} catch {
  await fs.writeFile(
    settings,
    JSON.stringify(
      {
        "workbench.colorTheme": "Changes: IntelliJ Dark",
        "workbench.startupEditor": "none",
        "workbench.sideBar.location": "left",
        "security.workspace.trust.enabled": false,
        "telemetry.telemetryLevel": "off",
        "editor.fontSize": 13,
        "window.menuBarVisibility": "compact",
        "git.autofetch": false,
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
      },
      null,
      2,
    ),
  );
}
await run(codeServer, [
  ...common,
  "--install-extension",
  path.join(root, "changes-workbench.vsix"),
  "--force",
]);
const port = process.env.PORT ?? "8080";
console.log(
  `\nChanges Workbench: http://127.0.0.1:${port}/?folder=${encodeURIComponent(fixture)}\nOpen the command palette and run Changes: Open Workbench.\n`,
);
const child = spawn(
  codeServer,
  [
    ...common,
    "--auth",
    "none",
    "--bind-addr",
    `127.0.0.1:${port}`,
    "--disable-telemetry",
    "--disable-update-check",
    fixture,
  ],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
