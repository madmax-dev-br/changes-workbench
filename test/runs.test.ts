import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRuns, resolveRun } from "../src/host/runs";
import { revertChange } from "../src/shared";

const root = path.resolve("/work/shop");
const none = () => false;
const wrapper = (name: string) => (file: string) =>
  file === path.join(root, name);

test("resolves a Gradle configuration to the project wrapper with tasks, parameters and env", () => {
  const run = resolveRun(
    `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Test &amp; lint" type="GradleRunConfiguration" factoryName="Gradle">
    <ExternalSystemSettings>
      <option name="env"><map><entry key="CI" value="true" /></map></option>
      <option name="executionName" />
      <option name="externalProjectPath" value="$PROJECT_DIR$" />
      <option name="scriptParameters" value="--info" />
      <option name="taskNames"><list><option value=":app:test" /><option value="lint" /></list></option>
    </ExternalSystemSettings>
    <method v="2" />
  </configuration>
</component>`,
    "Test.run.xml",
    root,
    wrapper(process.platform === "win32" ? "gradlew.bat" : "gradlew"),
  )!;
  assert.equal(run.name, "Test & lint");
  assert.equal(run.cwd, root);
  assert.equal(
    run.command,
    `${process.platform === "win32" ? ".\\gradlew.bat" : "./gradlew"} :app:test lint --info`,
  );
  assert.deepEqual(run.env, { CI: "true" });
});

test("falls back to the tool on PATH and reads Maven goals and profiles", () => {
  const run = resolveRun(
    `<component name="ProjectRunConfigurationManager">
  <configuration name="package" type="MavenRunConfiguration" factoryName="Maven">
    <MavenSettings><option name="myRunnerParameters"><MavenRunnerParameters>
      <option name="cmdOptions" value="-DskipTests" />
      <option name="goals"><list><option value="clean" /><option value="package" /></list></option>
      <option name="profilesMap"><map><entry key="prod" value="true" /><entry key="dev" value="false" /></map></option>
      <option name="workingDirPath" value="$PROJECT_DIR$/server" />
    </MavenRunnerParameters></option></MavenSettings>
  </configuration>
</component>`,
    "package.run.xml",
    root,
    none,
  )!;
  assert.equal(run.cwd, path.join(root, "server"));
  assert.equal(run.command, "mvn clean package -P prod -DskipTests");
  assert.deepEqual(run.env, {});
});

test("runs shell scripts, inline shell text, npm scripts and compounds", () => {
  const script = resolveRun(
    `<configuration name="deploy" type="ShConfigurationType">
      <option name="SCRIPT_TEXT" value="" />
      <option name="SCRIPT_PATH" value="$PROJECT_DIR$/scripts/deploy.sh" />
      <option name="SCRIPT_OPTIONS" value="--dry-run" />
      <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$/scripts" />
      <option name="INTERPRETER_PATH" value="/bin/zsh" />
      <option name="EXECUTE_SCRIPT_FILE" value="true" />
      <envs><env name="STAGE" value="beta" /></envs>
    </configuration>`,
    "deploy.run.xml",
    root,
  )!;
  assert.equal(
    script.command,
    `/bin/zsh ${path.join(root, "scripts/deploy.sh")} --dry-run`,
  );
  assert.equal(script.cwd, path.join(root, "scripts"));
  assert.deepEqual(script.env, { STAGE: "beta" });
  const inline = resolveRun(
    `<configuration name="hello" type="ShConfigurationType">
      <option name="SCRIPT_TEXT" value="echo &quot;hi&quot; &amp;&amp; ls" />
      <option name="EXECUTE_SCRIPT_FILE" value="false" />
    </configuration>`,
    "hello.run.xml",
    root,
  )!;
  assert.equal(inline.command, 'echo "hi" && ls');
  const npm = resolveRun(
    `<configuration name="web dev" type="js.build_tools.npm">
      <package-json value="$PROJECT_DIR$/web/package.json" />
      <command value="run" />
      <scripts><script value="dev" /></scripts>
      <node-interpreter value="project" />
    </configuration>`,
    "web.run.xml",
    root,
  )!;
  assert.equal(npm.command, "npm run dev");
  assert.equal(npm.cwd, path.join(root, "web"));
  const compound = resolveRun(
    `<configuration name="All" type="CompoundRunConfigurationType">
      <toRun name="web dev" type="js.build_tools.npm" />
      <toRun name="deploy" type="ShConfigurationType" />
    </configuration>`,
    "All.run.xml",
    root,
  )!;
  assert.deepEqual(compound.compound, ["web dev", "deploy"]);
  assert.equal(compound.reason, undefined);
});

test("keeps IDE-only configurations visible with a reason instead of a command", () => {
  const run = resolveRun(
    `<configuration name="Server" type="JetRunConfigurationType">
      <option name="MAIN_CLASS_NAME" value="dev.shop.ServerKt" />
      <module name="shop.main" />
    </configuration>`,
    "Server.run.xml",
    root,
  )!;
  assert.equal(run.command, undefined);
  assert.match(run.reason!, /IntelliJ/);
});

test("loads .run and .idea/runConfigurations, preferring .run on duplicate names", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "changes-runs-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, ".run"));
  await fs.mkdir(path.join(dir, ".idea/runConfigurations"), {
    recursive: true,
  });
  const sh = (name: string, text: string) =>
    `<component name="ProjectRunConfigurationManager"><configuration name="${name}" type="ShConfigurationType"><option name="SCRIPT_TEXT" value="${text}" /><option name="EXECUTE_SCRIPT_FILE" value="false" /></configuration></component>`;
  await fs.writeFile(path.join(dir, ".run/b.run.xml"), sh("Build", "make"));
  await fs.writeFile(path.join(dir, ".run/notes.txt"), "ignored");
  await fs.writeFile(
    path.join(dir, ".idea/runConfigurations/Build.xml"),
    sh("Build", "old"),
  );
  await fs.writeFile(
    path.join(dir, ".idea/runConfigurations/Api.xml"),
    sh("Api", "serve"),
  );
  const runs = await loadRuns(dir);
  assert.deepEqual(
    runs.map((r) => [r.name, r.command]),
    [
      ["Api", "serve"],
      ["Build", "make"],
    ],
  );
  assert.deepEqual(await loadRuns(path.join(dir, "missing")), []);
});

test("rolls back modified, added and deleted hunks like IntelliJ's gutter", () => {
  const original = "a\nb\nc\nd\n";
  // Modified: line 2 changed.
  assert.equal(
    revertChange("a\nB\nc\nd\n", original, {
      originalStartLineNumber: 2,
      originalEndLineNumber: 2,
      modifiedStartLineNumber: 2,
      modifiedEndLineNumber: 2,
    }),
    original,
  );
  // Added: lines 2-3 inserted after original line 1.
  assert.equal(
    revertChange("a\nx\ny\nb\nc\nd\n", original, {
      originalStartLineNumber: 1,
      originalEndLineNumber: 0,
      modifiedStartLineNumber: 2,
      modifiedEndLineNumber: 3,
    }),
    original,
  );
  // Deleted: original lines 1-2 removed from the top.
  assert.equal(
    revertChange("c\nd\n", original, {
      originalStartLineNumber: 1,
      originalEndLineNumber: 2,
      modifiedStartLineNumber: 0,
      modifiedEndLineNumber: 0,
    }),
    original,
  );
  // Only the clicked hunk is rolled back; CRLF files keep their line endings.
  assert.equal(
    revertChange("A\r\nb\r\nc\r\nD\r\n", "a\r\nb\r\nc\r\nd\r\n", {
      originalStartLineNumber: 4,
      originalEndLineNumber: 4,
      modifiedStartLineNumber: 4,
      modifiedEndLineNumber: 4,
    }),
    "A\r\nb\r\nc\r\nd\r\n",
  );
  assert.throws(
    () =>
      revertChange("a\n", original, {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 5,
        modifiedEndLineNumber: 9,
      }),
    /refresh/,
  );
});
