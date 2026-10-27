import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCommand,
  defaultVariant,
  loadRuns,
  parseVariants,
  resolveRun,
  resolveRuns,
  withVariant,
  type BuildModule,
} from "../src/host/runs";
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
    {
      exists: wrapper(process.platform === "win32" ? "gradlew.bat" : "gradlew"),
    },
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
    { exists: none },
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

const gradleModule = (dir: string, extra: Partial<BuildModule> = {}) =>
  ({
    dir: path.join(root, dir),
    kind: "gradle",
    buildRoot: root,
    gradlePath: dir ? `:${dir.split("/").join(":")}` : ":",
    ideName: ["shop", ...dir.split("/").filter(Boolean)].join("."),
    android: false,
    ...extra,
  }) satisfies BuildModule;

test("runs Java Application configurations on the module's Gradle runtime classpath", () => {
  const run = resolveRun(
    `<configuration name="Server" type="Application" factoryName="Application">
      <option name="MAIN_CLASS_NAME" value="dev.shop.Server" />
      <module name="shop.server.main" />
      <option name="PROGRAM_PARAMETERS" value="--port 8080 --name &quot;my shop&quot;" />
      <option name="VM_PARAMETERS" value="-Xmx256m" />
      <envs><env name="MODE" value="dev" /></envs>
    </configuration>`,
    "Server.run.xml",
    root,
    {
      exists: wrapper("gradlew"),
      modules: [gradleModule(""), gradleModule("server")],
      initScript: "/store/run.gradle",
    },
  )!;
  assert.equal(run.reason, undefined);
  assert.equal(run.cwd, root);
  assert.deepEqual(run.env, { MODE: "dev" });
  assert.equal(
    run.command,
    `./gradlew --init-script /store/run.gradle --no-configuration-cache :server:changesWorkbenchRun -PcwProject=:server -PcwMain=dev.shop.Server -PcwDir=${path.join(root, "server")} '-PcwArgs=--port 8080 --name "my shop"' -PcwJvmArgs=-Xmx256m`,
  );
  // Build compiles the module without running it.
  assert.equal(run.build, "./gradlew :server:classes");
});

test("finds a Kotlin main class's module from its source file, or uses Maven exec", () => {
  const kotlin = resolveRun(
    `<configuration name="Cli" type="JetRunConfigurationType">
      <option name="MAIN_CLASS_NAME" value="dev.shop.cli.MainKt" />
      <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$" />
    </configuration>`,
    "Cli.run.xml",
    root,
    {
      exists: (f) =>
        f === path.join(root, "tools/cli/src/main/kotlin/dev/shop/cli/Main.kt"),
      modules: [
        gradleModule(""),
        gradleModule("server"),
        gradleModule("tools/cli"),
      ],
    },
  )!;
  assert.match(
    kotlin.command!,
    /^gradle .* :tools:cli:changesWorkbenchRun .*-PcwMain=dev\.shop\.cli\.MainKt/,
  );
  assert.match(kotlin.command!, new RegExp(`-PcwDir=${root}( |$)`));
  const maven = resolveRun(
    `<configuration name="Api" type="Application">
      <option name="MAIN_CLASS_NAME" value="dev.api.App" />
      <module name="api" />
      <option name="PROGRAM_PARAMETERS" value="serve" />
      <option name="VM_PARAMETERS" value="-Xmx1g" />
    </configuration>`,
    "Api.run.xml",
    root,
    {
      exists: none,
      modules: [{ ...gradleModule("api"), kind: "maven", ideName: "api" }],
    },
  )!;
  assert.equal(maven.cwd, path.join(root, "api"));
  assert.equal(
    maven.command,
    "mvn compile exec:java -Dexec.mainClass=dev.api.App -Dexec.args=serve",
  );
  assert.deepEqual(maven.env, { MAVEN_OPTS: "-Xmx1g" });
  assert.equal(maven.build, "mvn compile");
  const missing = resolveRun(
    `<configuration name="Lost" type="Application"><option name="MAIN_CLASS_NAME" value="a.B" /></configuration>`,
    "Lost.run.xml",
    root,
    { exists: none, modules: [gradleModule(""), gradleModule("x")] },
  )!;
  assert.match(missing.reason!, /a\.B/);
});

test("keeps IDE-only configurations visible with a reason instead of a command", () => {
  const run = resolveRun(
    `<configuration name="Tests" type="JUnit">
      <module name="shop.main" />
    </configuration>`,
    "Tests.run.xml",
    root,
  )!;
  assert.equal(run.command, undefined);
  assert.match(run.reason!, /IntelliJ/);
});

test("reads workspace.xml run configurations, skipping templates", () => {
  const runs = resolveRuns(
    `<project version="4">
      <component name="RunManager" selected="Android App.app">
        <configuration name="app" type="AndroidRunConfigurationType" factoryName="Android App">
          <module name="shop.app.main" />
          <option name="MODE" value="specific_activity" />
          <option name="ACTIVITY_CLASS" value="dev.shop.MainActivity" />
        </configuration>
        <configuration default="true" type="Application" factoryName="Application" />
        <list><item itemvalue="Android App.app" /></list>
      </component>
    </project>`,
    "workspace.xml",
    root,
    {
      exists: none,
      modules: [gradleModule("app", { android: true })],
    },
  );
  assert.deepEqual(
    runs.map((r) => [r.name, r.command]),
    [
      [
        "app",
        "gradle --init-script changes-workbench-run.gradle --no-configuration-cache :app:changesWorkbenchAndroidRun -PcwProject=:app -PcwActivity=dev.shop.MainActivity",
      ],
    ],
  );
});

test("detects Android app modules in separate Gradle builds below the repository", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "changes-android-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  };
  await write("package.json", "{}");
  await write(
    "mobile/settings.gradle.kts",
    'rootProject.name = "Mobile"\ninclude(":app", ":core", ":shop")\n',
  );
  await write("mobile/gradlew", "#!/bin/sh\n");
  await write(
    "mobile/build.gradle.kts",
    "plugins {\n  alias(libs.plugins.android.application) apply false\n}\n",
  );
  await write("mobile/local.properties", "sdk.dir=/nowhere/sdk\n");
  await write(
    "mobile/app/build.gradle.kts",
    'plugins { alias(libs.plugins.android.application) }\nandroid {\n  namespace = "dev.mobile"\n  defaultConfig { applicationId = "dev.mobile.app" }\n  buildTypes { debug { applicationIdSuffix = ".debug" } }\n}\n',
  );
  await write(
    "mobile/core/build.gradle.kts",
    'plugins { id("com.android.library") }\n',
  );
  await write(
    "mobile/shop/build.gradle.kts",
    'plugins { id("com.android.application") }\nandroid {\n  defaultConfig { applicationId = "dev.shop" }\n  flavorDimensions += "env"\n  productFlavors { create("hmg") { dimension = "env" } }\n}\n',
  );
  await write("mobile/app/build/generated/build.gradle", "ignored");
  await write(
    "tools/legacy/build.gradle",
    "apply plugin: 'com.android.application'\n",
  );
  await write(
    "mobile/core/src/main/java/dev/mobile/Tool.java",
    "package dev.mobile; class Tool {}",
  );
  await write(
    "mobile/.idea/workspace.xml",
    `<project><component name="RunManager"><configuration name="Tool" type="Application"><option name="MAIN_CLASS_NAME" value="dev.mobile.Tool" /><module name="Mobile.core.main" /></configuration></component></project>`,
  );
  const runs = await loadRuns(dir, "/store/run.gradle");
  const byName = Object.fromEntries(runs.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "Tool",
    "app",
    "legacy",
    "shop",
  ]);
  assert.equal(byName.app.cwd, path.join(dir, "mobile"));
  // Without flavors: the plain debug install, then a launch of the debug application ID.
  assert.match(
    byName.app.command!,
    /^\.\/gradlew :app:installDebug && \S*adb shell monkey --pct-syskeys 0 -p dev\.mobile\.app\.debug -c android\.intent\.category\.LAUNCHER 1$/,
  );
  assert.equal(byName.app.android!.variants, undefined);
  assert.equal(byName.app.android!.applicationId, "dev.mobile.app.debug");
  assert.equal(buildCommand(byName.app), "./gradlew :app:assembleDebug");
  // With flavors the variant is read from Gradle and chosen at run time.
  assert.equal(
    byName.shop.command,
    "./gradlew --init-script /store/run.gradle --no-configuration-cache :shop:changesWorkbenchAndroidRun -PcwProject=:shop",
  );
  assert.equal(
    byName.shop.android!.variants,
    "./gradlew --init-script /store/run.gradle --no-configuration-cache -q :shop:changesWorkbenchVariants -PcwProject=:shop",
  );
  assert.equal(
    withVariant(byName.shop, "hmgDebug"),
    `${byName.shop.command} -PcwVariant=hmgDebug`,
  );
  assert.equal(
    buildCommand(byName.shop, "hmgDebug"),
    "./gradlew :shop:assembleHmgDebug",
  );
  // A standalone module without a settings file is its own build.
  assert.equal(byName.legacy.cwd, path.join(dir, "tools/legacy"));
  assert.match(
    byName.legacy.command!,
    /^gradle .* :changesWorkbenchAndroidRun -PcwProject=:$/,
  );
  assert.match(
    byName.Tool.command!,
    /:core:changesWorkbenchRun .*-PcwMain=dev\.mobile\.Tool/,
  );
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

test("reads build variants and picks IntelliJ's default", () => {
  const variants = parseVariants(
    "> Configure project :app\ncw-variant interHmgDebug\ncw-variant interMockServerDebug\ncw-variant pjMockServerDebug\n",
  );
  assert.deepEqual(variants, [
    "interHmgDebug",
    "interMockServerDebug",
    "pjMockServerDebug",
  ]);
  assert.equal(defaultVariant(variants), "interHmgDebug");
  assert.equal(defaultVariant(["release", "debug"]), "debug");
  assert.equal(defaultVariant([]), undefined);
});
