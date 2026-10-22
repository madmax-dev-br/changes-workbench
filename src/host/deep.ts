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
import { pathToFileURL } from "node:url";
import type { Navigation } from "../shared";
export interface DeepConfig {
  command: string;
  args: string[];
}
interface Session {
  connection: MessageConnection;
  child: ChildProcess;
  documents: Map<string, number>;
  language: string;
  supportsHover?: boolean;
}
export class DeepManager {
  private sessions = new Map<string, Session>();
  private starting = new Map<string, Promise<Session>>();
  private generation = 0;
  private idle?: NodeJS.Timeout;
  enabled = false;
  constructor(
    private root: string,
    private storage: string,
    private config: (language: string) => DeepConfig,
    private status: (message: string) => void,
    private idleMinutes = 10,
    private log: (message: string) => void = () => {},
  ) {}
  enable() {
    this.enabled = true;
    this.status("Deep · starts on next navigation");
    this.touch();
  }
  private touch() {
    clearTimeout(this.idle);
    if (this.enabled)
      this.idle = setTimeout(() => void this.stop(), this.idleMinutes * 60000);
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
    this.status(`Starting ${language} analysis…`);
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
    const session: Session = {
      connection,
      child,
      documents: new Map(),
      language,
    };
    this.sessions.set(language, session);
    child.stderr?.on("data", (b) => this.log(`[${language}] ${b}`));
    child.on("error", (e) => {
      this.status(`${language}: ${e.message}; using lightweight navigation`);
      connection.dispose();
      this.sessions.delete(language);
    });
    child.on("exit", () => {
      connection.dispose();
      if (this.sessions.get(language) === session)
        this.sessions.delete(language);
    });
    connection.onRequest("workspace/configuration", () => []);
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "Review mode is read-only",
    }));
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
            workspace: { configuration: true },
          },
          initializationOptions: {
            settings: { java: { autobuild: { enabled: false } } },
          },
        }),
        60000,
      );
      if (generation !== this.generation || !this.enabled)
        throw new Error("Deep analysis stopped");
      session.supportsHover = Boolean(initialized?.capabilities?.hoverProvider);
      await connection.sendNotification("initialized", {});
      this.status(`Deep · ${language} ready`);
      return session;
    } catch (error) {
      this.kill(session);
      if (this.sessions.get(language) === session)
        this.sessions.delete(language);
      throw error;
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
      const sourceLine = text.split("\n")[line] ?? "";
      const word =
        (sourceLine.slice(0, column).match(/[\w$]+$/)?.[0] ?? "") +
        (sourceLine.slice(column).match(/^[\w$]+/)?.[0] ?? "");
      const signature =
        documentation.match(/`{3,}[^\n]*\n([\s\S]*?)\n`{3,}/)?.[1] ??
        documentation.split("\n")[0] ??
        word;
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
            documentation,
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
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      try {
        await withTimeout(session.connection.sendRequest("shutdown"), 500);
        await session.connection.sendNotification("exit");
      } catch {}
      this.kill(session);
    }
    this.status("Lightweight · on demand");
  }
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
