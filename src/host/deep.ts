import { spawn, type ChildProcess } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
  CancellationTokenSource,
} from "vscode-jsonrpc/node";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inside } from "./git";
import { findExecutable } from "./dependencies";
import { languageOf, type Navigation } from "../shared";
export interface DeepConfig {
  command: string;
  args: string[];
}
interface KotlinWorkspace {
  file: string;
  roots: string;
  options: unknown;
}
interface Session {
  connection: MessageConnection;
  child: ChildProcess;
  documents: Map<string, number>;
  language: string;
  supportsHover?: boolean;
  indexing: boolean;
  ready: Promise<void>;
  markReady: () => void;
  watchers: RegExp[];
  progress: Map<string | number, string>;
  workspace?: KotlinWorkspace;
}
/** Files that let Kotlin LSP import the project itself; otherwise a JSON workspace is generated. */
const BUILD_FILES = [
  "settings.gradle.kts",
  "settings.gradle",
  "build.gradle.kts",
  "build.gradle",
  "pom.xml",
  "workspace.json",
];
export class DeepManager {
  private sessions = new Map<string, Session>();
  private starting = new Map<string, Promise<Session>>();
  private generation = 0;
  private idle?: NodeJS.Timeout;
  private events = new Map<string, 1 | 2 | 3>();
  private eventTimer?: NodeJS.Timeout;
  private lastProgress = 0;
  statusText = "Lightweight · on demand";
  enabled = false;
  constructor(
    private root: string,
    private storage: string,
    private config: (language: string) => DeepConfig,
    private status: (message: string) => void,
    private idleMinutes = 10,
    private log: (message: string) => void = () => {},
    private listFiles: () => Promise<string[]> = async () => [],
    private indexWaitMs = 10000,
  ) {}
  private report(message: string) {
    this.statusText = message;
    this.status(message);
  }
  enable() {
    this.enabled = true;
    this.report("Deep · indexing workspace…");
    this.touch();
    void this.warm();
  }
  private touch() {
    clearTimeout(this.idle);
    if (this.enabled)
      this.idle = setTimeout(() => void this.stop(), this.idleMinutes * 60000);
  }
  /** Start the servers for the languages in the repository so indexing runs before navigation. */
  private async warm() {
    const generation = this.generation;
    let files: string[] = [];
    try {
      files = await this.listFiles();
    } catch {}
    const languages = new Set(
      files.map(languageOf).filter((l) => l === "kotlin" || l === "java"),
    );
    for (const language of languages) {
      if (generation !== this.generation || !this.enabled) return;
      // A server that is not installed is started (and reported) only when navigation needs it.
      const command = this.config(language).command;
      if (!command || !(await findExecutable(command))) {
        this.log(
          `[${language}] ${command || "launcher"} not found; skipping warm-up`,
        );
        continue;
      }
      try {
        await this.session(language);
      } catch (e) {
        if (generation !== this.generation || !this.enabled) return;
        this.log(`[${language}] ${e}`);
        this.report(
          `${language}: ${e instanceof Error ? e.message : e}; using lightweight navigation`,
        );
      }
    }
    if (generation === this.generation && this.enabled && !this.sessions.size)
      this.report("Deep · starts on next navigation");
  }
  private async session(language: string): Promise<Session> {
    if (!this.enabled) throw new Error("Deep analysis is disabled");
    const running = this.sessions.get(language);
    if (running) return running;
    const existing = this.starting.get(language);
    if (existing) return existing;
    const generation = this.generation;
    const promise = this.launch(language, generation).finally(() => {
      if (this.starting.get(language) === promise)
        this.starting.delete(language);
    });
    this.starting.set(language, promise);
    return promise;
  }
  private async launch(language: string, generation: number): Promise<Session> {
    const cfg = this.config(language);
    if (!cfg.command)
      throw new Error(`Configure the ${language} server executable first`);
    const directory = path.join(this.storage, language);
    await fs.mkdir(directory, { recursive: true });
    const args = [...cfg.args];
    if (language === "java" && !args.includes("-data"))
      args.push("-data", path.join(directory, "workspace"));
    const workspace =
      language === "kotlin"
        ? await this.kotlinWorkspace(directory).catch((e) => {
            this.log(`[kotlin] workspace generation failed: ${e}`);
            return undefined;
          })
        : undefined;
    this.report(`Starting ${language} analysis…`);
    const child = spawn(cfg.command, args, {
      cwd: this.root,
      env: { ...process.env, GRADLE_USER_HOME: path.join(directory, "gradle") },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        child.removeListener("error", reject);
        resolve();
      });
    });
    if (generation !== this.generation || !this.enabled) {
      child.kill();
      throw new Error("Deep analysis stopped");
    }
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!),
    );
    let markReady = () => {};
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    const session: Session = {
      connection,
      child,
      documents: new Map(),
      language,
      indexing: true,
      ready,
      markReady: () => {
        if (!session.indexing) return;
        session.indexing = false;
        markReady();
        if (this.sessions.get(language) === session)
          this.report(`Deep · ${language} ready`);
      },
      watchers: [],
      progress: new Map(),
      workspace,
    };
    this.sessions.set(language, session);
    child.stderr?.on("data", (b) => this.log(`[${language}] ${b}`));
    child.on("error", (e) => {
      this.report(`${language}: ${e.message}; using lightweight navigation`);
      connection.dispose();
      this.sessions.delete(language);
    });
    child.on("exit", () => {
      connection.dispose();
      if (this.sessions.get(language) === session)
        this.sessions.delete(language);
    });
    connection.onRequest("workspace/configuration", (params: any) =>
      (params?.items ?? []).map(() => null),
    );
    connection.onRequest("client/registerCapability", (params: any) => {
      for (const registration of params?.registrations ?? [])
        if (registration.method === "workspace/didChangeWatchedFiles")
          for (const watcher of registration.registerOptions?.watchers ?? [])
            session.watchers.push(globToRegExp(watcher.globPattern));
      return null;
    });
    connection.onRequest("client/unregisterCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "Review mode is read-only",
    }));
    // Kotlin LSP reports the end of each project import cycle.
    connection.onNotification("intellij/workspaceImportState", (p: any) => {
      if (p?.phase === "IN_PROGRESS") return;
      if (p?.phase === "FAILED")
        this.log(`[${language}] workspace import failed`);
      session.markReady();
    });
    // Eclipse JDT LS reports readiness and progress with its own notifications.
    connection.onNotification("language/status", (p: any) => {
      if (p?.type === "ServiceReady") session.markReady();
    });
    connection.onNotification("language/progressReport", (p: any) => {
      if (p?.complete) session.progress.delete(p.id);
      else session.progress.set(p.id, `${p.task ?? ""} ${p.status ?? ""}`);
      this.indexingStatus(session);
    });
    const titles = new Map<string | number, string>();
    connection.onNotification("$/progress", (p: any) => {
      const value = p?.value;
      if (value?.kind === "begin") titles.set(p.token, value.title ?? "");
      if (value?.kind === "end") {
        session.progress.delete(p.token);
        titles.delete(p.token);
      } else if (value)
        session.progress.set(
          p.token,
          [
            titles.get(p.token),
            value.message,
            value.percentage !== undefined &&
            !String(value.message ?? "").includes(`${value.percentage}%`)
              ? `${value.percentage}%`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      this.indexingStatus(session);
    });
    connection.listen();
    try {
      const initialized = await withTimeout(
        connection.sendRequest<any>("initialize", {
          processId: process.pid,
          rootUri: pathToFileURL(this.root).toString(),
          workspaceFolders: [
            {
              uri: pathToFileURL(this.root).toString(),
              name: path.basename(this.root),
            },
          ],
          capabilities: {
            textDocument: {
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
            },
            workspace: {
              configuration: true,
              didChangeWatchedFiles: { dynamicRegistration: true },
            },
            window: { workDoneProgress: true },
          },
          initializationOptions:
            language === "kotlin"
              ? (workspace?.options ?? {})
              : {
                  settings: { java: { autobuild: { enabled: false } } },
                  extendedClientCapabilities: { progressReportProvider: true },
                },
        }),
        60000,
      );
      if (generation !== this.generation || !this.enabled)
        throw new Error("Deep analysis stopped");
      session.supportsHover = Boolean(initialized?.capabilities?.hoverProvider);
      await connection.sendNotification("initialized", {});
      const importsWorkspace = Boolean(
        initialized?.capabilities?.experimental?.workspaceImport,
      );
      const jdt = /JDT/i.test(initialized?.serverInfo?.name ?? "");
      if (!importsWorkspace && !jdt) session.markReady();
      else {
        this.report(`Deep · ${language} indexing…`);
        // Never leave navigation waiting on a server that misses its ready signal.
        setTimeout(() => session.markReady(), 10 * 60000).unref();
      }
      return session;
    } catch (error) {
      this.kill(session);
      if (this.sessions.get(language) === session)
        this.sessions.delete(language);
      throw error;
    }
  }
  private indexingStatus(session: Session) {
    if (!session.indexing || this.sessions.get(session.language) !== session)
      return;
    const now = Date.now();
    if (now - this.lastProgress < 1500) return;
    this.lastProgress = now;
    const detail = [...session.progress.values()].at(-1)?.trim();
    this.report(
      `Deep · ${session.language} indexing…${detail ? ` ${detail.slice(0, 60)}` : ""}`,
    );
  }
  /** Describe the repository's source roots for Kotlin LSP when it has no build the server can import. */
  private async kotlinWorkspace(
    directory: string,
  ): Promise<KotlinWorkspace | undefined> {
    for (const name of BUILD_FILES)
      if (await exists(path.join(this.root, name))) return;
    const settings = await fs
      .readFile(path.join(this.root, ".vscode", "settings.json"), "utf8")
      .catch(() => "");
    if (settings.includes('"intellij.projects"')) return;
    const file = path.join(directory, "workspace.json");
    const roots = await this.writeKotlinWorkspace(file);
    if (!roots) return;
    return {
      file,
      roots,
      options: {
        projects: [{ type: "json", path: pathToFileURL(file).toString() }],
      },
    };
  }
  private async writeKotlinWorkspace(file: string) {
    const roots = await sourceRoots(this.root, await this.listFiles());
    if (!roots.length) return "";
    const workspace = {
      modules: [
        {
          name: path.basename(this.root),
          dependencies: [{ type: "moduleSource" }, { type: "inheritedSdk" }],
          contentRoots: [
            {
              path: this.root,
              sourceRoots: roots.map((r) => ({
                path: path.join(this.root, r.path),
                type: r.test ? "java-test" : "java-source",
              })),
            },
          ],
        },
      ],
    };
    await fs.writeFile(file, JSON.stringify(workspace, null, 2));
    return JSON.stringify(roots);
  }
  /** Forward a file system change to the servers that asked for it and follow new source roots. */
  fileChanged(file: string, type: 1 | 2 | 3) {
    if (!this.enabled || !this.sessions.size || !inside(this.root, file))
      return;
    if (/[\\/]\.git[\\/]/.test(file)) return;
    this.events.set(file, type);
    clearTimeout(this.eventTimer);
    this.eventTimer = setTimeout(() => void this.flushEvents(), 300);
  }
  private async flushEvents() {
    const events = [...this.events];
    this.events.clear();
    for (const session of this.sessions.values()) {
      const changes = events
        .filter(([file]) =>
          session.watchers.some((w) => w.test(file.split(path.sep).join("/"))),
        )
        .map(([file, type]) => ({ uri: pathToFileURL(file).toString(), type }));
      if (changes.length)
        try {
          await session.connection.sendNotification(
            "workspace/didChangeWatchedFiles",
            { changes },
          );
        } catch {}
    }
    const kotlin = this.sessions.get("kotlin");
    if (
      kotlin?.workspace &&
      events.some(([file, type]) => type !== 2 && /\.(kt|kts|java)$/.test(file))
    ) {
      try {
        const roots = await this.writeKotlinWorkspace(kotlin.workspace.file);
        if (!roots || roots === kotlin.workspace.roots) return;
        kotlin.workspace.roots = roots;
        this.log("[kotlin] source roots changed; reloading workspace");
        await kotlin.connection.sendRequest("intellij/reloadWorkspace", {
          initializationOptions: kotlin.workspace.options,
        });
      } catch (e) {
        this.log(`[kotlin] workspace reload failed: ${e}`);
      }
    }
  }
  async navigate(
    language: string,
    file: string,
    text: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<Navigation> {
    this.touch();
    const session = await this.session(language);
    if (signal?.aborted) throw new Error("Cancelled");
    const sourceLine = text.split("\n")[line] ?? "";
    const word =
      (sourceLine.slice(0, column).match(/[\w$]+$/)?.[0] ?? "") +
      (sourceLine.slice(column).match(/^[\w$]+/)?.[0] ?? "");
    if (
      session.indexing &&
      !(await settles(session.ready, this.indexWaitMs, signal))
    ) {
      if (signal?.aborted) throw new Error("Cancelled");
      return {
        word,
        candidates: [],
        confidence: "none",
        note: `The ${language} index is still building; showing lightweight results.`,
      };
    }
    const uri = pathToFileURL(path.resolve(this.root, file)).toString();
    const version = (session.documents.get(uri) ?? 0) + 1;
    if (session.documents.has(uri))
      await session.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    else
      await session.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: language, version, text },
      });
    session.documents.delete(uri);
    session.documents.set(uri, version);
    while (session.documents.size > 32) {
      const oldest = session.documents.keys().next().value!;
      session.documents.delete(oldest);
      await session.connection.sendNotification("textDocument/didClose", {
        textDocument: { uri: oldest },
      });
    }
    const token = new CancellationTokenSource();
    const cancel = () => token.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const hoverRequest = session.supportsHover
        ? withTimeout(
            session.connection.sendRequest<any>(
              "textDocument/hover",
              { textDocument: { uri }, position: { line, character: column } },
              token.token,
            ),
            2500,
          ).catch(() => undefined)
        : Promise.resolve(undefined);
      const locations = await withTimeout(
        session.connection.sendRequest<any>(
          "textDocument/definition",
          { textDocument: { uri }, position: { line, character: column } },
          token.token,
        ),
        8000,
      );
      const hover = await hoverRequest;
      const content = hover?.contents;
      const documentation = (
        Array.isArray(content) ? content : content ? [content] : []
      )
        .map((item: any) =>
          typeof item === "string" ? item : (item.value ?? ""),
        )
        .join("\n\n");
      if (signal?.aborted || !this.enabled) throw new Error("Cancelled");
      const result = Array.isArray(locations)
        ? locations
        : locations
          ? [locations]
          : [];
      const fenced = documentation.match(/`{3,}[^\n]*\n([\s\S]*?)\n`{3,}/)?.[1];
      const signature = fenced ?? documentation.split("\n")[0] ?? word;
      const prose = cleanDocumentation(
        documentation,
        fenced ? undefined : signature,
      );
      return {
        word,
        confidence: result.length ? "deep" : "none",
        candidates: result.map((l: any) => {
          const uri = l.targetUri ?? l.uri;
          const range = l.targetSelectionRange ?? l.range;
          return {
            name: word || "Definition",
            kind: "definition",
            path: uri,
            line: range.start.line,
            column: range.start.character,
            endLine: range.end.line,
            start: 0,
            end: 0,
            scopeStart: 0,
            scopeEnd: 0,
            signature: signature || uri,
            documentation: prose,
          };
        }),
      };
    } finally {
      signal?.removeEventListener("abort", cancel);
      token.cancel();
      token.dispose();
    }
  }
  private kill(session: Session) {
    session.connection.dispose();
    try {
      if (process.platform !== "win32" && session.child.pid)
        process.kill(-session.child.pid, "SIGTERM");
      else session.child.kill();
    } catch {}
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && session.child.pid)
          process.kill(-session.child.pid, "SIGKILL");
        else session.child.kill("SIGKILL");
      } catch {}
    }, 2000);
    timer.unref();
  }
  async stop() {
    this.enabled = false;
    this.generation++;
    this.starting.clear();
    clearTimeout(this.idle);
    clearTimeout(this.eventTimer);
    this.events.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      try {
        await withTimeout(session.connection.sendRequest("shutdown"), 500);
        await session.connection.sendNotification("exit");
      } catch {}
      this.kill(session);
    }
    this.report("Lightweight · on demand");
  }
}
export interface SourceRoot {
  path: string;
  test: boolean;
}
/**
 * Derive source roots from tracked Kotlin/Java files: Gradle/Maven layouts by path, anything else
 * from the package declaration of one file per directory.
 */
export async function sourceRoots(
  root: string,
  files: string[],
  head: (file: string) => Promise<string> = (file) =>
    readHead(path.join(root, file)),
): Promise<SourceRoot[]> {
  const directories = new Map<string, string>();
  for (const file of files) {
    if (!/\.(kt|java)$/.test(file)) continue;
    const directory = path.posix.dirname(file.split(path.sep).join("/"));
    if (!directories.has(directory)) directories.set(directory, file);
  }
  const roots = new Set<string>();
  let reads = 0;
  for (const [directory, file] of directories) {
    const layout = `${directory}/`.match(
      /^(.*?)\bsrc\/[^/]+\/(?:kotlin|java)\//,
    );
    if (layout) {
      roots.add(layout[0].slice(0, -1));
      continue;
    }
    if (++reads > 4000) continue;
    const name = (await head(file).catch(() => ""))
      .match(/^\s*package\s+([\w.`]+)/m)?.[1]
      ?.replace(/`/g, "");
    const suffix = name?.split(".").join("/");
    const current = directory === "." ? "" : directory;
    if (suffix && current === suffix) roots.add(".");
    else if (suffix && current.endsWith(`/${suffix}`))
      roots.add(current.slice(0, -suffix.length - 1));
    else roots.add(current || ".");
  }
  return [...roots].sort().map((r) => ({
    path: r,
    test: /(^|\/)(test|tests|androidTest|testFixtures)(\/|$)|(^|\/)src\/[^/]*[tT]est[^/]*\//.test(
      r + "/",
    ),
  }));
}
/**
 * Plain prose from server hover markdown: code blocks (shown as the signature) and a repeated
 * signature line are dropped, links keep their text.
 */
export function cleanDocumentation(markdown: string, signature?: string) {
  let lines = markdown
    .replace(/(`{3,})[^\n]*\n[\s\S]*?\n\1`*/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*{1,2}|_{1,2})([^*_\n]+)\1/g, "$2")
    .split("\n");
  if (signature && lines[0]?.trim() === signature.trim())
    lines = lines.slice(1);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
async function readHead(file: string) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
/** Convert an LSP watcher glob (string or relative pattern) to a regular expression on `/` paths. */
export function globToRegExp(glob: unknown): RegExp {
  let pattern = "";
  let base = "";
  if (typeof glob === "string") pattern = glob;
  else if (glob && typeof glob === "object") {
    const g = glob as { baseUri?: unknown; pattern?: unknown };
    pattern = typeof g.pattern === "string" ? g.pattern : "";
    const uri =
      typeof g.baseUri === "string"
        ? g.baseUri
        : (g.baseUri as { uri?: string } | undefined)?.uri;
    if (uri?.startsWith("file:"))
      base = fileURLToPath(uri).split(path.sep).join("/").replace(/\/$/, "");
  }
  if (!pattern) return /$^/;
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "{") source += "(?:";
    else if (c === "}") source += ")";
    else if (c === ",") source += "|";
    else source += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  const prefix = base
    ? base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/"
    : pattern.startsWith("/")
      ? ""
      : "(?:.*/)?";
  return new RegExp(`^${prefix}${source}$`);
}
async function exists(file: string) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}
/** Wait for a promise up to `ms`; false when it did not settle in time or the request was cancelled. */
function settles(
  promise: Promise<unknown>,
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => done(false);
    const timer = setTimeout(() => done(false), ms);
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      () => done(true),
      () => done(false),
    );
  });
}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Language server timeout")),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
