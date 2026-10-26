import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A shared IntelliJ run configuration (`.run/*.run.xml` or `.idea/runConfigurations/*.xml`). */
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

/** Resolve the configuration into a command line, the way IntelliJ would launch it. */
export function resolveRun(
  xml: string,
  file: string,
  root: string,
  exists: (file: string) => boolean = existsSync,
): RunConfiguration | undefined {
  const config = find(parseXml(xml), "configuration");
  if (!config?.attrs.name) return;
  const macros = (text: string) =>
    text
      .replace(/\$(PROJECT_DIR|MODULE_DIR|MODULE_WORKING_DIR)\$/g, root)
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
  // A wrapper script next to the build file wins over the tool on PATH, as in IntelliJ.
  const wrapper = (start: string, name: string, tool: string) => {
    for (let at = start; ; at = path.dirname(at)) {
      const script = path.join(
        at,
        process.platform === "win32" ? `${name}.bat` : name,
      );
      if (exists(script))
        return at === start
          ? process.platform === "win32"
            ? `.\\${name}.bat`
            : `./${name}`
          : quote(script);
      if (at === root || path.dirname(at) === at) return tool;
    }
  };
  switch (run.type) {
    case "GradleRunConfiguration": {
      const settings = find(config, "ExternalSystemSettings") ?? config;
      run.cwd = dir(value(settings, "externalProjectPath"));
      run.command = [
        wrapper(run.cwd, "gradlew", "gradle"),
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
        wrapper(run.cwd, "mvnw", "mvn"),
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
    case "CompoundRunConfigurationType":
      run.compound = findAll(config, "toRun")
        .map((t) => t.attrs.name)
        .filter(Boolean);
      break;
  }
  if (!run.command && !run.compound)
    run.reason = `${run.type || "This type"} needs IntelliJ to build its classpath; run it there.`;
  return run;
}
/** Shared run configurations of the project, sorted by name. */
export async function loadRuns(root: string): Promise<RunConfiguration[]> {
  const runs: RunConfiguration[] = [];
  for (const folder of [".run", ".idea/runConfigurations"]) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(root, folder));
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".xml")).sort()) {
      const file = path.join(root, folder, name);
      try {
        const run = resolveRun(await fs.readFile(file, "utf8"), file, root);
        if (run && !runs.some((r) => r.name === run.name)) runs.push(run);
      } catch {}
    }
  }
  return runs.sort((a, b) => a.name.localeCompare(b.name));
}
