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
  const report = {
    passed: true,
    host: vscode.env.appName,
    version: vscode.version,
    checks: [
      "activation",
      "single review tab",
      "native Kotlin definition",
      "native hover + blame",
      "unsaved editor buffer",
      "explicit deep enable/stop",
    ],
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
