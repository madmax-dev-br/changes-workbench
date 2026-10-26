import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * An IntelliJ run configuration (`.run/*.run.xml`, `.idea/runConfigurations/*.xml` or
 * `.idea/workspace.xml`), or an Android app module detected from its build file.
 */
export interface RunConfiguration {
  name: string;
  type: string;
  file: string;
  /** Shell command line, or undefined when the type needs the IDE (see `reason`). */
  command?: string;
  cwd: string;
  env: Record<string, string>;
  /** Names of the configurations a compound configuration starts. */
  compound?: string[];
  reason?: string;
  /** Command that compiles what the configuration runs, without running it (IntelliJ's Build). */
  build?: string;
  /** Android app module: the build variant is chosen at run time (see `withVariant`). */
  android?: {
    module: string;
    /** Command that prints the module's installable variants as `cw-variant <name>` lines. */
    variants: string;
  };
}
interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
const entities: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
};
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, code: string) =>
    code[0] === "#"
      ? String.fromCodePoint(
          code[1].toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : Number(code.slice(1)),
        )
      : (entities[code] ?? match),
  );
/** Elements and attributes only: run configurations keep their values in attributes. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: "", attrs: {}, children: [] };
  const stack = [root];
  const tags =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (const [, closing, tag, attributes, selfClosing] of xml.matchAll(tags)) {
    if (!tag) continue;
    if (closing) {
      while (stack.length > 1 && stack.pop()!.tag !== tag);
      continue;
    }
    const node: XmlNode = { tag, attrs: {}, children: [] };
    for (const [, key, , double, single] of attributes.matchAll(
      /([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g,
    ))
      node.attrs[key] = decode(double ?? single);
    stack.at(-1)!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}
const find = (node: XmlNode, tag: string): XmlNode | undefined => {
  for (const child of node.children) {
    if (child.tag === tag) return child;
    const found = find(child, tag);
    if (found) return found;
  }
};
const findAll = (node: XmlNode, tag: string): XmlNode[] =>
  node.children.flatMap((child) => [
    ...(child.tag === tag ? [child] : []),
    ...findAll(child, tag),
  ]);
/** The `<option name=…>` value, or its `<list>` of values. */
const option = (node: XmlNode, name: string) =>
  node.children.find((c) => c.tag === "option" && c.attrs.name === name);
const value = (node: XmlNode, name: string) =>
  option(node, name)?.attrs.value ?? "";
const list = (node: XmlNode | undefined) =>
  node ? findAll(node, "option").map((o) => o.attrs.value ?? "") : [];
/** POSIX-style quoting that also reads correctly in PowerShell for plain arguments. */
export const quote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

/** A Gradle or Maven module somewhere below the repository root. */
export interface BuildModule {
  dir: string;
  kind: "gradle" | "maven";
  /** Directory of the Gradle build that owns the module (its settings file), or the module. */
  buildRoot: string;
  /** Gradle project path inside that build, such as `:app` or `:`. */
  gradlePath: string;
  /** IntelliJ's module name without the source-set suffix, such as `shop.app`. */
  ideName: string;
  android: boolean;
}
export interface RunContext {
  /** The IntelliJ project directory ($PROJECT_DIR$) that holds the configuration. */
  root: string;
  modules: BuildModule[];
  /** Gradle init script that adds the tasks running Application and Android configurations. */
  initScript: string;
  exists: (file: string) => boolean;
  env: Record<string, string | undefined>;
}
const context = (root: string, options: Partial<RunContext>): RunContext => ({
  root,
  modules: [],
  initScript: "changes-workbench-run.gradle",
  exists: existsSync,
  env: process.env,
  ...options,
});
const win = process.platform === "win32";
/** A wrapper script next to (or above) the build wins over the tool on PATH, as in IntelliJ. */
function wrapper(ctx: RunContext, start: string, name: string, tool: string) {
  for (let at = start; ; at = path.dirname(at)) {
    const script = path.join(at, win ? `${name}.bat` : name);
    if (ctx.exists(script))
      return at === start
        ? win
          ? `.\\${name}.bat`
          : `./${name}`
        : quote(script);
    if (at === ctx.root || path.dirname(at) === at) return tool;
  }
}
const inside = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};
/** The module an IntelliJ `<module name>` or a main class belongs to. */
function moduleFor(ctx: RunContext, ideModule = "", mainClass = "") {
  const candidates = ctx.modules.filter((m) => inside(ctx.root, m.dir));
  const name = ideModule.replace(
    /\.(main|test|unitTest|androidTest|testFixtures)$/,
    "",
  );
  const byName = candidates.find((m) => m.ideName === name);
  if (byName) return byName;
  if (mainClass) {
    const parts = mainClass.split(".");
    const simple = parts.pop()!.replace(/\$.*$/, "");
    const files = [
      `${simple}.java`,
      `${simple}.kt`,
      ...(simple.endsWith("Kt") ? [`${simple.slice(0, -2)}.kt`] : []),
    ];
    const byClass = candidates.find((m) =>
      ["main", "jvmMain"].some((set) =>
        ["java", "kotlin"].some((lang) =>
          files.some((f) =>
            ctx.exists(path.join(m.dir, "src", set, lang, ...parts, f)),
          ),
        ),
      ),
    );
    if (byClass) return byClass;
  }
  const jvm = candidates.filter((m) => !m.android);
  return jvm.length === 1 ? jvm[0] : undefined;
}
const gradleTask = (module: BuildModule, task: string) =>
  `${module.gradlePath === ":" ? "" : module.gradlePath}:${task}`;
/** Install a build variant, then launch it, as Android Studio's Run does. */
function androidRun(
  run: RunConfiguration,
  ctx: RunContext,
  module: BuildModule,
  activity = "",
  launch = true,
) {
  run.cwd = module.buildRoot;
  const gradle = [
    wrapper(ctx, module.buildRoot, "gradlew", "gradle"),
    "--init-script",
    quote(ctx.initScript),
    "--no-configuration-cache",
  ];
  const project = quote(`-PcwProject=${module.gradlePath}`);
  run.command = [
    ...gradle,
    gradleTask(module, "changesWorkbenchAndroidRun"),
    project,
    activity ? quote(`-PcwActivity=${activity}`) : "",
    launch ? "" : "-PcwLaunch=false",
  ]
    .filter(Boolean)
    .join(" ");
  // `assembleDebug` covers every flavor; a chosen variant narrows it (see `buildCommand`).
  run.build = `${gradle[0]} ${gradleTask(module, "assemble")}`;
  run.android = {
    module: module.dir,
    variants: [
      ...gradle,
      "-q",
      gradleTask(module, "changesWorkbenchVariants"),
      project,
    ].join(" "),
  };
}
/** The command that runs an Android configuration with a build variant such as `freeDebug`. */
export const withVariant = (run: RunConfiguration, variant?: string) =>
  run.android && variant
    ? `${run.command} ${quote(`-PcwVariant=${variant}`)}`
    : run.command;
/** The command that builds a configuration, for Android with its variant (`assembleFreeDebug`). */
export const buildCommand = (run: RunConfiguration, variant?: string) =>
  run.android && run.build
    ? `${run.build}${variant ? variant[0].toUpperCase() + variant.slice(1) : "Debug"}`
    : run.build;
/** Variant names from the output of `android.variants`. */
export const parseVariants = (output: string) =>
  [...output.matchAll(/^cw-variant (\S+)\s*$/gm)].map((m) => m[1]);
/** IntelliJ's default: `debug`, else the first debug variant, else the first one. */
export const defaultVariant = (variants: string[]) =>
  variants.includes("debug")
    ? "debug"
    : (variants.find((v) => v.endsWith("Debug")) ?? variants[0]);

/** Every configuration in an IntelliJ XML file, resolved into command lines. */
export function resolveRuns(
  xml: string,
  file: string,
  root: string,
  options: Partial<RunContext> = {},
): RunConfiguration[] {
  const ctx = context(root, options);
  const document = parseXml(xml);
  // workspace.xml keeps them in its RunManager component; templates are `default="true"`.
  const manager = findAll(document, "component").find(
    (c) => c.attrs.name === "RunManager",
  );
  return findAll(manager ?? document, "configuration")
    .filter((c) => c.attrs.name && c.attrs.default !== "true")
    .map((c) => resolveConfiguration(c, file, ctx));
}
/** The first configuration of a `.run` file. */
export function resolveRun(
  xml: string,
  file: string,
  root: string,
  options: Partial<RunContext> = {},
): RunConfiguration | undefined {
  return resolveRuns(xml, file, root, options)[0];
}
function resolveConfiguration(
  config: XmlNode,
  file: string,
  ctx: RunContext,
): RunConfiguration {
  const { root } = ctx;
  let moduleDir = root;
  const macros = (text: string) =>
    text
      .replace(/\$PROJECT_DIR\$/g, root)
      .replace(/\$(MODULE_DIR|MODULE_WORKING_DIR)\$/g, () => moduleDir)
      .replace(/\$USER_HOME\$/g, os.homedir());
  const dir = (text: string) =>
    text ? path.resolve(root, macros(text)) : root;
  const run: RunConfiguration = {
    name: config.attrs.name,
    type: config.attrs.type ?? "",
    file,
    cwd: root,
    env: {},
  };
  // `<envs><env name value/>` for most types; Gradle and Maven keep a `<map>` option.
  for (const env of findAll(config, "env"))
    if (env.attrs.name) run.env[env.attrs.name] = macros(env.attrs.value ?? "");
  for (const map of findAll(config, "option").filter((o) =>
    ["env", "environmentProperties"].includes(o.attrs.name),
  ))
    for (const entry of findAll(map, "entry"))
      if (entry.attrs.key)
        run.env[entry.attrs.key] = macros(entry.attrs.value ?? "");
  switch (run.type) {
    case "GradleRunConfiguration": {
      const settings = find(config, "ExternalSystemSettings") ?? config;
      run.cwd = dir(value(settings, "externalProjectPath"));
      run.command = [
        wrapper(ctx, run.cwd, "gradlew", "gradle"),
        ...list(option(settings, "taskNames")).map(quote),
        macros(value(settings, "scriptParameters")),
      ]
        .filter(Boolean)
        .join(" ");
      break;
    }
    case "MavenRunConfiguration": {
      const parameters = find(config, "MavenRunnerParameters") ?? config;
      run.cwd = dir(value(parameters, "workingDirPath"));
      const profiles = option(parameters, "profilesMap");
      const enabled = profiles
        ? findAll(profiles, "entry")
            .filter((e) => e.attrs.value !== "false")
            .map((e) => e.attrs.key)
        : [];
      run.command = [
        wrapper(ctx, run.cwd, "mvnw", "mvn"),
        ...list(option(parameters, "goals")).map(quote),
        enabled.length ? `-P ${quote(enabled.join(","))}` : "",
        macros(value(parameters, "cmdOptions")),
      ]
        .filter(Boolean)
        .join(" ");
      break;
    }
    case "ShConfigurationType": {
      run.cwd = dir(
        value(config, "SCRIPT_WORKING_DIRECTORY") ||
          value(config, "INDEPENDENT_SCRIPT_WORKING_DIRECTORY"),
      );
      if (value(config, "EXECUTE_SCRIPT_FILE") === "false")
        run.command = macros(value(config, "SCRIPT_TEXT"));
      else {
        const script = macros(value(config, "SCRIPT_PATH"));
        if (!script) break;
        run.command = [
          quote(macros(value(config, "INTERPRETER_PATH")) || "/bin/bash"),
          macros(value(config, "INTERPRETER_OPTIONS")),
          quote(path.resolve(root, script)),
          macros(value(config, "SCRIPT_OPTIONS")),
        ]
          .filter(Boolean)
          .join(" ");
      }
      break;
    }
    case "js.build_tools.npm": {
      const packageJson = find(config, "package-json")?.attrs.value;
      if (packageJson) run.cwd = path.dirname(dir(packageJson));
      const command = find(config, "command")?.attrs.value || "run";
      const scripts = findAll(config, "script").map((s) => s.attrs.value ?? "");
      const manager = find(config, "package-manager")?.attrs.value;
      run.command = [
        manager && /yarn|pnpm/.test(manager)
          ? manager.match(/yarn|pnpm/)![0]
          : "npm",
        command,
        ...scripts.filter(Boolean).map(quote),
        macros(find(config, "arguments")?.attrs.value ?? ""),
      ]
        .filter(Boolean)
        .join(" ");
      break;
    }
    case "PythonConfigurationType": {
      run.cwd = dir(value(config, "WORKING_DIRECTORY"));
      const script = macros(value(config, "SCRIPT_NAME"));
      if (!script) break;
      const module = value(config, "MODULE_MODE") === "true";
      run.command = [
        process.platform === "win32" ? "python" : "python3",
        macros(value(config, "INTERPRETER_OPTIONS")),
        module ? `-m ${quote(script)}` : quote(path.resolve(root, script)),
        macros(value(config, "PARAMETERS")),
      ]
        .filter(Boolean)
        .join(" ");
      break;
    }
    // Java/Kotlin main classes run on the module's runtime classpath, built by Gradle or Maven.
    case "Application":
    case "JetRunConfigurationType":
    case "SpringBootApplicationConfigurationType": {
      const mainClass =
        value(config, "MAIN_CLASS_NAME") ||
        value(config, "SPRING_BOOT_MAIN_CLASS");
      if (!mainClass) {
        run.reason = "The configuration has no main class.";
        break;
      }
      const module = moduleFor(
        ctx,
        find(config, "module")?.attrs.name,
        mainClass,
      );
      if (!module) {
        run.reason = `No Gradle or Maven module containing ${mainClass} was found.`;
        break;
      }
      moduleDir = module.dir;
      const workingDir = dir(
        value(config, "WORKING_DIRECTORY") || "$MODULE_WORKING_DIR$",
      );
      const programArgs = macros(value(config, "PROGRAM_PARAMETERS"));
      const vmArgs = macros(value(config, "VM_PARAMETERS"));
      if (module.kind === "maven") {
        run.cwd = module.dir;
        run.build = `${wrapper(ctx, module.dir, "mvnw", "mvn")} compile`;
        if (vmArgs) run.env.MAVEN_OPTS = vmArgs;
        run.command = [
          wrapper(ctx, module.dir, "mvnw", "mvn"),
          "compile exec:java",
          quote(`-Dexec.mainClass=${mainClass}`),
          programArgs ? quote(`-Dexec.args=${programArgs}`) : "",
          workingDir !== module.dir
            ? quote(`-Dexec.workingdir=${workingDir}`)
            : "",
        ]
          .filter(Boolean)
          .join(" ");
        break;
      }
      run.cwd = module.buildRoot;
      run.build = `${wrapper(ctx, module.buildRoot, "gradlew", "gradle")} ${gradleTask(module, "classes")}`;
      run.command = [
        wrapper(ctx, module.buildRoot, "gradlew", "gradle"),
        "--init-script",
        quote(ctx.initScript),
        "--no-configuration-cache",
        gradleTask(module, "changesWorkbenchRun"),
        quote(`-PcwProject=${module.gradlePath}`),
        quote(`-PcwMain=${mainClass}`),
        quote(`-PcwDir=${workingDir}`),
        programArgs ? quote(`-PcwArgs=${programArgs}`) : "",
        vmArgs ? quote(`-PcwJvmArgs=${vmArgs}`) : "",
      ]
        .filter(Boolean)
        .join(" ");
      break;
    }
    case "AndroidRunConfigurationType": {
      const module = ctx.modules.find(
        (m) =>
          m.android &&
          m.ideName ===
            (find(config, "module")?.attrs.name ?? "").replace(/\.main$/, ""),
      );
      if (!module) {
        run.reason = "Its Android app module was not found.";
        break;
      }
      const mode = value(config, "MODE");
      androidRun(
        run,
        ctx,
        module,
        mode === "specific_activity" ? value(config, "ACTIVITY_CLASS") : "",
        mode !== "do_nothing",
      );
      break;
    }
    case "CompoundRunConfigurationType":
      run.compound = findAll(config, "toRun")
        .map((t) => t.attrs.name)
        .filter(Boolean);
      break;
  }
  if (!run.command && !run.compound && !run.reason)
    run.reason = `${run.type || "This type"} only runs inside IntelliJ.`;
  return run;
}

const skipped = new Set([
  "build",
  "out",
  "target",
  "node_modules",
  "intermediates",
]);
/** Gradle and Maven modules below `root`, including separate builds in subfolders. */
export async function findModules(root: string): Promise<BuildModule[]> {
  const found: { dir: string; file: string; text: string }[] = [];
  const settings = new Map<string, string>();
  let queue = [root];
  let visited = 0;
  for (let depth = 0; depth <= 6 && queue.length && visited < 4000; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (++visited > 4000) break;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const names = new Set(entries.map((e) => e.name));
      for (const name of ["settings.gradle.kts", "settings.gradle"])
        if (names.has(name))
          settings.set(
            dir,
            await fs.readFile(path.join(dir, name), "utf8").catch(() => ""),
          );
      const build = ["build.gradle.kts", "build.gradle", "pom.xml"].find((n) =>
        names.has(n),
      );
      if (build)
        found.push({
          dir,
          file: build,
          text: await fs
            .readFile(path.join(dir, build), "utf8")
            .catch(() => ""),
        });
      for (const e of entries)
        if (e.isDirectory() && !e.name.startsWith(".") && !skipped.has(e.name))
          next.push(path.join(dir, e.name));
    }
    queue = next;
  }
  return found.map(({ dir, file, text }) => {
    let buildRoot = dir;
    for (let at = dir; inside(root, at); at = path.dirname(at)) {
      if (settings.has(at)) {
        buildRoot = at;
        break;
      }
      if (at === root) break;
    }
    const segments = path
      .relative(buildRoot, dir)
      .split(path.sep)
      .filter(Boolean);
    const rootName =
      /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(
        settings.get(buildRoot) ?? "",
      )?.[1] ?? path.basename(buildRoot);
    // The root build usually declares the plugin with `apply false` for its modules.
    const android =
      file !== "pom.xml" &&
      text
        .split("\n")
        .some(
          (line) =>
            /android[.-]?application/i.test(line) &&
            !/\bapply\s*\(?\s*false/.test(line),
        );
    return {
      dir,
      kind: file === "pom.xml" ? "maven" : "gradle",
      buildRoot,
      gradlePath: segments.length ? `:${segments.join(":")}` : ":",
      ideName: [rootName, ...segments].join("."),
      android,
    } satisfies BuildModule;
  });
}
/** The Gradle init script behind Application, Kotlin and Android configurations. */
export const INIT_SCRIPT = `// Changes Workbench: runs an IntelliJ Application configuration on a module's runtime classpath.
def props = gradle.startParameter.projectProperties
def split = { String text -> text ? (text =~ /"([^"]*)"|'([^']*)'|(\\S+)/).collect { it[1] ?: it[2] ?: it[3] } : [] }
allprojects { project ->
  if (project.path != props.cwProject) return
  project.afterEvaluate {
    def main = project.extensions.findByName('sourceSets')?.findByName('main')
    if (main == null) {
      project.tasks.register('changesWorkbenchRun') {
        doLast { throw new GradleException("\${project.path} has no JVM main source set to run \${props.cwMain}") }
      }
      return
    }
    project.tasks.register('changesWorkbenchRun', JavaExec) {
      group = 'application'
      description = 'Runs an IntelliJ Application run configuration.'
      classpath = main.runtimeClasspath
      mainClass.set(props.cwMain)
      if (props.cwDir) workingDir = props.cwDir
      args(split(props.cwArgs))
      jvmArgs(split(props.cwJvmArgs))
      standardInput = System.in
    }
  }
}
// Android app modules: list the build variants, or install one and launch it like Android Studio.
allprojects { project ->
  if (project.path != props.cwProject) return
  project.pluginManager.withPlugin('com.android.application') {
    def components = project.extensions.findByName('androidComponents')
    def ids = [:]
    if (components != null)
      components.onVariants(components.selector().all(), { variant -> ids[variant.name] = variant.applicationId } as Action)
    else
      project.android.applicationVariants.all { variant -> ids[variant.name] = project.provider { variant.applicationId } }
    def install = { String name -> 'install' + name.substring(0, 1).toUpperCase() + name.substring(1) }
    def installable = { ids.keySet().findAll { project.tasks.names.contains(install(it)) }.sort() }
    def chosen = { ->
      if (props.cwVariant) return props.cwVariant
      def names = installable()
      names.contains('debug') ? 'debug' : names.size() == 1 ? names[0] : null
    }
    project.tasks.register('changesWorkbenchVariants') {
      doLast { installable().each { logger.quiet("cw-variant \$it") } }
    }
    project.tasks.register('changesWorkbenchAndroidRun') {
      dependsOn { def name = chosen(); name && project.tasks.names.contains(install(name)) ? install(name) : [] }
      doLast {
        def name = chosen()
        if (!name || !project.tasks.names.contains(install(name)))
          throw new GradleException("Choose a build variant of \${project.path}: \${installable().join(', ')}")
        if (props.cwLaunch == 'false') return
        def id = ids[name].get()
        def adb = 'adb'
        try {
          adb = components != null ? components.sdkComponents.adb.get().asFile.path : project.android.adbExecutable.path
        } catch (ignored) {}
        def command = props.cwActivity
          ? [adb, 'shell', 'am', 'start', '-n', "\$id/\${props.cwActivity}".toString()]
          : [adb, 'shell', 'monkey', '--pct-syskeys', '0', '-p', id, '-c', 'android.intent.category.LAUNCHER', '1']
        logger.lifecycle("Launching \$id (\$name)")
        if (new ProcessBuilder(command*.toString()).inheritIO().start().waitFor() != 0)
          throw new GradleException("adb could not launch \$id")
      }
    }
  }
}
`;
/** Run configurations of the repository and of Gradle builds in its subfolders, by name. */
export async function loadRuns(
  root: string,
  initScript = "changes-workbench-run.gradle",
): Promise<RunConfiguration[]> {
  const modules = await findModules(root);
  const projects = [
    root,
    ...new Set(modules.map((m) => m.buildRoot).filter((d) => d !== root)),
  ].sort((a, b) => a.length - b.length);
  const runs: RunConfiguration[] = [];
  const add = (run: RunConfiguration, project: string) => {
    if (runs.some((r) => r.name === run.name)) {
      if (project === root) return;
      run.name = `${run.name} · ${path.relative(root, project)}`;
      if (runs.some((r) => r.name === run.name)) return;
    }
    runs.push(run);
  };
  const androidModules = new Set<string>();
  for (const project of projects) {
    const options = { modules, initScript };
    const files: string[] = [];
    for (const folder of [".run", ".idea/runConfigurations"])
      try {
        files.push(
          ...(await fs.readdir(path.join(project, folder)))
            .filter((n) => n.endsWith(".xml"))
            .sort()
            .map((n) => path.join(project, folder, n)),
        );
      } catch {}
    files.push(path.join(project, ".idea", "workspace.xml"));
    for (const file of files) {
      let xml: string;
      try {
        xml = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const run of resolveRuns(xml, file, project, options)) {
        if (run.android) androidModules.add(run.android.module);
        add(run, project);
      }
    }
  }
  // Android Studio creates a run configuration per app module; do the same when none is shared.
  for (const module of modules.filter((m) => m.android)) {
    const run: RunConfiguration = {
      name: path.basename(module.dir),
      type: "AndroidRunConfigurationType",
      file: path.join(module.dir, "build.gradle"),
      cwd: module.buildRoot,
      env: {},
    };
    if (androidModules.has(module.dir)) continue;
    androidRun(run, context(module.buildRoot, { modules, initScript }), module);
    if (runs.some((r) => r.name === run.name))
      run.name = path.relative(root, module.dir) || run.name;
    add(run, module.buildRoot);
  }
  return runs.sort((a, b) => a.name.localeCompare(b.name));
}
