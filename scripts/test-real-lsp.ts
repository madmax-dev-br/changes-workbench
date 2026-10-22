import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { DeepManager } from "../src/host/deep";
async function main() {
  const project = process.cwd();
  const root = path.join(project, ".dev/real-lsp-project");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, ".project"),
    `<projectDescription><name>changes-test</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>`,
  );
  await fs.writeFile(
    path.join(root, ".classpath"),
    `<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>`,
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const java =
    'class Demo {\n  /** Returns a greeting. */\n  String greeting() { return "hello"; }\n  String use() { return greeting(); }\n}\n';
  const kotlin =
    'class Demo {\n  /** Returns a greeting. */\n  fun greeting(): String = "hello"\n  fun use(): String = greeting()\n}\n';
  await fs.writeFile(path.join(root, "src/Demo.java"), java);
  await fs.writeFile(path.join(root, "Demo.kt"), kotlin);
  const results = [];
  for (const language of ["java", "kotlin"]) {
    const command =
      process.env[language === "java" ? "JDTLS_COMMAND" : "KOTLIN_LSP_COMMAND"];
    if (!command) continue;
    const manager = new DeepManager(
      root,
      path.join(project, ".dev/real-lsp-storage"),
      () => ({
        command,
        args:
          language === "java"
            ? ["-configuration", path.join(project, ".dev/jdtls-config")]
            : [
                "--stdio",
                "--system-path=" + path.join(project, ".dev/kotlin-system"),
              ],
      }),
      console.log,
      1,
      (message) =>
        void fs.appendFile(
          path.join(project, ".dev", `${language}-lsp.log`),
          message,
        ),
    );
    try {
      manager.enable();
      const text = language === "java" ? java : kotlin;
      const line = text.split("\n")[3],
        column = line.lastIndexOf("greeting") + 3;
      let found;
      // JDT project import is asynchronous after initialize.
      for (let i = 0; i < 8; i++) {
        found = await manager.navigate(
          language,
          language === "java" ? "src/Demo.java" : "Demo.kt",
          text,
          3,
          column,
        );
        if (found.candidates.length) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert.ok(found?.candidates.length, `${language}: definition`);
      results.push({
        language,
        passed: true,
        definition: found.candidates[0],
        hover: Boolean(found.candidates[0].documentation),
      });
      console.log(language, "REAL LSP PASS");
    } catch (error) {
      results.push({ language, passed: false, error: String(error) });
      console.error(language, String(error));
    } finally {
      await manager.stop();
    }
  }
  await fs.writeFile(
    "test-results/real-lsp.json",
    JSON.stringify(results, null, 2) + "\n",
  );
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}
void main();
