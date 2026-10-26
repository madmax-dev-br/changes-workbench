import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./process";

/** A process the Java debugger can attach to, as listed by IntelliJ's Attach to Process. */
export interface DebugTarget {
  kind: "android" | "jvm";
  /** Package name for Android, main class or jar for a JVM. */
  name: string;
  pid: number;
  /** Android device serial and its display name. */
  serial?: string;
  device?: string;
  /** JDWP address of a JVM started with the debug agent. */
  host?: string;
  port?: number;
  /** One of this project's apps. */
  project?: boolean;
}

const win = process.platform === "win32";
/** adb from the SDK of one of the given builds, ANDROID_HOME, the default SDK, else PATH. */
export function findAdb(
  buildRoots: string[],
  env: Record<string, string | undefined> = process.env,
) {
  const sdks: (string | undefined)[] = [];
  for (const root of buildRoots)
    try {
      const local = readFileSync(path.join(root, "local.properties"), "utf8");
      const dir = /^sdk\.dir\s*=\s*(.+)$/m.exec(local)?.[1];
      if (dir) sdks.push(dir.trim().replace(/\\(.)/g, "$1"));
    } catch {}
  sdks.push(
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    win
      ? path.join(env.LOCALAPPDATA ?? "", "Android", "Sdk")
      : path.join(
          os.homedir(),
          process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk",
        ),
  );
  for (const sdk of sdks.filter(Boolean)) {
    const tool = path.join(sdk!, "platform-tools", win ? "adb.exe" : "adb");
    if (existsSync(tool)) return tool;
  }
  return "adb";
}

/** `adb devices -l`: serials of devices that are online, with a readable name. */
export function parseDevices(output: string) {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 2 && f[1] === "device")
    .map(([serial, , ...props]) => {
      const prop = (key: string) =>
        props.find((p) => p.startsWith(`${key}:`))?.slice(key.length + 1);
      return {
        serial,
        name: (prop("model") ?? prop("device") ?? serial).replace(/_/g, " "),
      };
    });
}
/** `ps -A -o PID,NAME` on the device: process names by pid. */
export function parseProcessNames(output: string) {
  const names = new Map<number, string>();
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (m) names.set(Number(m[1]), m[2]);
  }
  return names;
}
/** `adb jdwp` lists the debuggable pids and keeps running: read it briefly. */
function jdwpPids(adb: string, serial: string, ms = 1500) {
  return new Promise<number[]>((resolve) => {
    const child = spawn(adb, ["-s", serial, "jdwp"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    const done = () => {
      clearTimeout(timer);
      child.kill();
      resolve(
        out
          .split(/\s+/)
          .filter((p) => /^\d+$/.test(p))
          .map(Number),
      );
    };
    const timer = setTimeout(done, ms);
    child.on("error", done);
    child.on("close", done);
  });
}
/** Debuggable app processes on every connected device, this project's apps first. */
export async function androidTargets(
  adb: string,
  appIds: string[],
): Promise<DebugTarget[]> {
  let devices: { serial: string; name: string }[];
  try {
    devices = parseDevices(
      (
        await run(adb, ["devices", "-l"], os.homedir(), { timeout: 8000 })
      ).toString(),
    );
  } catch {
    return [];
  }
  const ids = new Set(appIds);
  const perDevice = await Promise.all(
    devices.map(async ({ serial, name }) => {
      const [pids, ps] = await Promise.all([
        jdwpPids(adb, serial),
        run(
          adb,
          ["-s", serial, "shell", "ps", "-A", "-o", "PID,NAME"],
          os.homedir(),
          {
            timeout: 8000,
          },
        )
          .then((b) => parseProcessNames(b.toString()))
          .catch(() => new Map<number, string>()),
      ]);
      return pids.map((pid): DebugTarget => {
        const process = ps.get(pid) ?? `pid ${pid}`;
        return {
          kind: "android",
          name: process,
          pid,
          serial,
          device: name,
          // `com.app:remote` is a second process of the same app.
          project: ids.has(process.split(":")[0]),
        };
      });
    }),
  );
  return perDevice
    .flat()
    .sort(
      (a, b) =>
        Number(!!b.project) - Number(!!a.project) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * A JVM command line started with the JDWP agent as a server
 * (`-agentlib:jdwp=transport=dt_socket,server=y,address=*:5005`).
 */
export function parseJvm(
  pid: number,
  command: string,
): DebugTarget | undefined {
  const agent = /(?:-agentlib:jdwp=|-Xrunjdwp:)(\S+)/.exec(command)?.[1];
  if (!agent) return;
  const options = Object.fromEntries(
    agent.split(",").map((o) => {
      const at = o.indexOf("=");
      return at < 0 ? [o, ""] : [o.slice(0, at), o.slice(at + 1)];
    }),
  );
  if (options.server !== "y" || !options.address) return;
  const address = /^(?:(.*):)?(\d+)$/.exec(options.address);
  if (!address) return;
  const host =
    !address[1] || address[1] === "*" || address[1] === "0.0.0.0"
      ? "localhost"
      : address[1];
  // `ps` loses the quoting of paths with spaces, so the main class is found by its shape: the
  // first fully qualified name that is neither an option nor part of a path.
  const tokens = command.split(/\s+/).slice(1);
  let name = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-jar" || t === "-m" || t === "--module") {
      name = path.basename(tokens[i + 1] ?? "");
      break;
    }
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(t)) {
      name = t;
      break;
    }
  }
  return {
    kind: "jvm",
    name: name || "java",
    pid,
    host,
    port: Number(address[2]),
  };
}
/** Local JVMs that accept a debugger. */
export async function jvmTargets(): Promise<DebugTarget[]> {
  try {
    const out = win
      ? await run(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            'Get-CimInstance Win32_Process -Filter "Name like \'java%\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
          ],
          os.homedir(),
          { timeout: 10000 },
        )
      : await run("ps", ["-axww", "-o", "pid=,command="], os.homedir(), {
          timeout: 10000,
        });
    return out
      .toString()
      .split("\n")
      .flatMap((line) => {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        const target = m && parseJvm(Number(m[1]), m[2]);
        return target ? [target] : [];
      });
  } catch {
    return [];
  }
}

/**
 * Source folders of every module (`src/main/java`, `src/pj/kotlin`…): the Java language server
 * does not import Android builds, so the debugger is told where the app's sources are.
 */
export async function sourcePaths(moduleDirs: string[]) {
  const found: string[] = [];
  for (const dir of moduleDirs) {
    let sets: string[];
    try {
      sets = await fs.readdir(path.join(dir, "src"));
    } catch {
      continue;
    }
    for (const set of sets)
      for (const language of ["java", "kotlin"]) {
        const folder = path.join(dir, "src", set, language);
        if (existsSync(folder)) found.push(folder);
      }
  }
  return found;
}
/** Forward a local port to an app's JDWP; adb picks the port (`tcp:0`). */
export async function forwardJdwp(adb: string, serial: string, pid: number) {
  const out = await run(
    adb,
    ["-s", serial, "forward", "tcp:0", `jdwp:${pid}`],
    os.homedir(),
    { timeout: 8000 },
  );
  const port = Number(out.toString().trim());
  if (!port)
    throw new Error(`adb could not forward the debugger port of ${pid}`);
  return port;
}
export function removeForward(adb: string, serial: string, port: number) {
  return run(
    adb,
    ["-s", serial, "forward", "--remove", `tcp:${port}`],
    os.homedir(),
    {
      timeout: 8000,
    },
  ).catch(() => undefined);
}
