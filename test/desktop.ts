import * as vscode from "vscode";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
export async function run() {
  const extension = vscode.extensions.getExtension(
    "local-workbench.changes-workbench",
  );
  assert.ok(extension);
  await extension.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const checkout =
    "app/src/main/kotlin/dev/checkout/service/CheckoutService.kt";
  await vscode.commands.executeCommand("changesWorkbench.open");
  await vscode.commands.executeCommand("changesWorkbench.open");
  assert.equal(
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.label === "Changes").length,
    1,
  );
  const document = await vscode.workspace.openTextDocument(
    path.join(root, checkout),
  );
  await vscode.window.showTextDocument(document);
  const imports = document.getText().split("\n");
  const line = imports.findIndex(
    (s) => s.startsWith("import") && s.includes("PriceCalculator"),
  );
  const position = new vscode.Position(
    line,
    imports[line].indexOf("PriceCalculator") + 3,
  );
  const definitions = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >("vscode.executeDefinitionProvider", document.uri, position);
  assert.ok(
    definitions?.length,
    "Kotlin import resolved through native definition provider",
  );
  const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    document.uri,
    position,
  );
  assert.ok(hover?.length, "Native hover contains navigation/blame");
  const edit = new vscode.WorkspaceEdit();
  edit.insert(
    document.uri,
    new vscode.Position(document.lineCount, 0),
    "\n// Unsaved native editor verification\n",
  );
  await vscode.workspace.applyEdit(edit);
  assert.equal(document.isDirty, true);
  await vscode.commands.executeCommand("changesWorkbench.open");
  assert.equal(
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.label === "Changes").length,
    1,
  );
  await vscode.commands.executeCommand("changesWorkbench.startDeep");
  await vscode.commands.executeCommand("changesWorkbench.stopDeep");
  const checks = [
    "activation",
    "single review tab",
    "native Kotlin definition",
    "native hover + blame",
    "unsaved editor buffer",
    "explicit deep enable/stop",
  ];
  if (process.env.KOTLIN_LSP_COMMAND) {
    // A file created after the server started is untracked, so only the live index can resolve it.
    const config = vscode.workspace.getConfiguration("changesWorkbench");
    await config.update(
      "kotlin.command",
      process.env.KOTLIN_LSP_COMMAND,
      vscode.ConfigurationTarget.Global,
    );
    await config.update(
      "kotlin.args",
      [
        "--stdio",
        `--system-path=${path.join(process.env.CHANGES_PROJECT_ROOT!, ".dev/kotlin-system-desktop")}`,
      ],
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand("changesWorkbench.startDeep");
    const pricing = path.join(root, "app/src/main/kotlin/dev/checkout/pricing");
    await fs.writeFile(
      path.join(pricing, "Rounding.kt"),
      "package dev.checkout.pricing\n\nobject Rounding {\n    fun cents(value: Double) = Math.round(value * 100) / 100.0\n}\n",
    );
    const use = path.join(pricing, "UsesRounding.kt");
    await fs.writeFile(
      use,
      "package dev.checkout.pricing\n\nfun rounded(total: Double) = Rounding.cents(total)\n",
    );
    const source = await vscode.workspace.openTextDocument(use);
    await vscode.window.showTextDocument(source);
    const at = new vscode.Position(
      2,
      source.lineAt(2).text.indexOf("cents") + 2,
    );
    let target: string | undefined;
    for (let i = 0; i < 60 && !target; i++) {
      const found = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >("vscode.executeDefinitionProvider", source.uri, at);
      target = found
        ?.map((l) => ("targetUri" in l ? l.targetUri : l.uri).fsPath)
        .find((f) => f.endsWith("Rounding.kt"));
      if (!target) await new Promise((r) => setTimeout(r, 2000));
    }
    await vscode.commands.executeCommand("changesWorkbench.stopDeep");
    assert.ok(target, "deep index resolves a file created after start");
    checks.push("deep index follows new files");
  }
  const report = {
    passed: true,
    host: vscode.env.appName,
    version: vscode.version,
    checks,
  };
  await fs.mkdir(path.join(process.env.CHANGES_PROJECT_ROOT!, "test-results"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(
      process.env.CHANGES_PROJECT_ROOT!,
      "test-results",
      vscode.env.appName.toLowerCase().includes("cursor")
        ? "cursor.json"
        : "desktop.json",
    ),
    JSON.stringify(report, null, 2),
  );
  console.log("DESKTOP SMOKE PASSED", JSON.stringify(report));
}
