import * as vscode from "vscode";
import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { randomBytes } from "node:crypto";
import { run } from "./host/process";
import { GitService, inside, type Buffers } from "./host/git";
import { Navigator } from "./host/navigation";
import { DeepManager } from "./host/deep";
import { ReviewStore } from "./host/reviews";
import { findExecutable } from "./host/dependencies";
import {
  languageOf,
  type Scope,
  type Snapshot,
  type ViewState,
  type RequestMessage,
  type Navigation,
  type BlameLine,
} from "./shared";
interface Services {
  git: GitService;
  navigation: Navigator;
  deep: DeepManager;
  watchers: FSWatcher[];
}
let workbench: Workbench | undefined;
export function activate(context: vscode.ExtensionContext) {
  workbench = new Workbench(context);
  context.subscriptions.push(workbench);
}
export async function deactivate() {
  await workbench?.stop();
}
class Workbench {
  private panel?: vscode.WebviewPanel;
  private services = new Map<string, Services>();
  private root = "";
  private scope: Scope = "all";
  private deepStatus = "Lightweight · on demand";
  private reviews: ReviewStore;
  private requests = new Map<number, AbortController>();
  private snapshots = new Map<string, Snapshot>();
  private allowedLocations = new Set<string>();
  private refreshTimer?: NodeJS.Timeout;
  private epoch = 0;
  private disposables: vscode.Disposable[] = [];
  private virtual = new Map<string, string>();
  private decompiled = new Map<string, { code: string; language: string }>();
  private nativeBlameCache = new Map<
    string,
    { key: string; lines: BlameLine[] }
  >();
  private log = vscode.window.createOutputChannel("Changes Workbench");
  private status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    9,
  );
  constructor(private context: vscode.ExtensionContext) {
    this.reviews = new ReviewStore(
      context.workspaceState.get("reviews", {}),
      (state) => context.workspaceState.update("reviews", state),
    );
    const command = (name: string, fn: (...args: any[]) => any) =>
      this.disposables.push(
        vscode.commands.registerCommand(`changesWorkbench.${name}`, fn),
      );
    command("open", () => this.open());
    for (const name of [
      "nextFile",
      "previousFile",
      "nextChange",
      "previousChange",
      "toggleBlame",
      "toggleReviewed",
    ])
      command(name, () => {
        if (!this.panel) return this.open();
        this.send("command", name);
      });
    command("definition", () =>
      this.panel?.active
        ? this.send("command", "definition")
        : this.nativeDefinition(),
    );
    command("openEditor", () => this.send("command", "openEditor"));
    command("quickDocumentation", () =>
      this.send("command", "quickDocumentation"),
    );
    command("chooseTheme", () => this.chooseTheme());
    command("startDeep", async () => {
      await this.ensureRoot();
      this.current.deep.enable();
      await this.refresh();
    });
    command("stopDeep", async () => {
      for (const s of this.services.values()) await s.deep.stop();
      await this.refresh();
    });
    command("configureDeep", () => this.configureDeep());
    command("openCommit", (sha: string, file: string, root?: string) =>
      this.openCommit(sha, file, root),
    );
    command("followDefinition", (file: string, line: number, column: number) =>
      this.openLocation(file, line, column),
    );
    this.status.text = "$(git-compare) Changes";
    this.status.command = "changesWorkbench.open";
    this.status.tooltip = "Open Changes Workbench";
    this.status.show();
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider("changes-commit", {
        provideTextDocumentContent: (uri) =>
          this.virtual.get(uri.toString()) ?? "",
      }),
    );
    // Deep definitions into libraries (such as kotlin-stdlib) point inside jars.
    const libraries: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri) => this.libraryText(uri),
    };
    for (const scheme of ["jar", "jrt"])
      this.disposables.push(
        vscode.workspace.registerTextDocumentContentProvider(scheme, libraries),
      );
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        const found = this.decompiled.get(document.uri.toString(true));
        if (found && document.languageId !== found.language)
          void vscode.languages
            .setTextDocumentLanguage(document, found.language)
            .then(undefined, () => {});
      }),
    );
    this.disposables.push(
      vscode.languages.registerHoverProvider(
        [
          { scheme: "file", language: "java" },
          { scheme: "file", language: "kotlin" },
        ],
        {
          provideHover: async (document, position, token) => {
            const controller = new AbortController();
            const sub = token.onCancellationRequested(() => controller.abort());
            try {
              const service = await this.serviceFor(document.uri.fsPath);
              if (!service) return;
              const file = path.relative(service.git.root, document.uri.fsPath);
              const nav = await this.navigate(
                service,
                file,
                document.getText(),
                position.line,
                position.character,
                controller.signal,
              );
              const md = this.navMarkdown(nav, service.git.root);
              const blame = await this.nativeBlame(service, document);
              const item = blame.find((b) => b.line === position.line + 1);
              if (item) {
                md.appendMarkdown("\n\n---\n\n");
                md.appendText(
                  `${item.author} · ${item.local ? "uncommitted" : new Date(item.time * 1000).toLocaleDateString()}\n${item.summary}`,
                );
                if (!item.local) {
                  const args = encodeURIComponent(
                    JSON.stringify([item.sha, item.path, service.git.root]),
                  );
                  md.appendMarkdown(
                    `\n\n[Open commit ${item.sha.slice(0, 7)}](command:changesWorkbench.openCommit?${args})`,
                  );
                }
              }
              return new vscode.Hover(md);
            } catch (e) {
              if (!controller.signal.aborted) this.log.appendLine(String(e));
            } finally {
              sub.dispose();
            }
          },
        },
      ),
    );
    this.disposables.push(
      vscode.languages.registerDefinitionProvider(
        [
          { scheme: "file", language: "java" },
          { scheme: "file", language: "kotlin" },
        ],
        {
          provideDefinition: async (document, position, token) => {
            const controller = new AbortController();
            const sub = token.onCancellationRequested(() => controller.abort());
            try {
              const service = await this.serviceFor(document.uri.fsPath);
              if (!service) return;
              const nav = await this.navigate(
                service,
                path.relative(service.git.root, document.uri.fsPath),
                document.getText(),
                position.line,
                position.character,
                controller.signal,
              );
              return nav.candidates.map(
                (s) =>
                  new vscode.Location(
                    this.locationUri(s.path, service.git.root),
                    new vscode.Position(s.line, s.column),
                  ),
              );
            } finally {
              sub.dispose();
            }
          },
        },
      ),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("changesWorkbench")) void this.refresh();
      }),
    );
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.changed(uri, 1)),
      watcher.onDidChange((uri) => this.changed(uri, 2)),
      watcher.onDidDelete((uri) => this.changed(uri, 3)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === "file") this.changed();
      }),
      vscode.workspace.onDidSaveTextDocument(() => this.changed()),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const document = editor?.document;
        if (document?.uri.scheme !== "file") return;
        void this.serviceFor(document.uri.fsPath).then((service) => {
          if (service)
            this.prioritize(
              service,
              path.relative(service.git.root, document.uri.fsPath),
              document.getText(),
            );
        });
      }),
      vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) this.changed();
      }),
    );
  }
  private buffers(): Buffers {
    const buffers: Buffers = new Map();
    for (const d of vscode.workspace.textDocuments)
      if (d.uri.scheme === "file" && d.isDirty)
        buffers.set(d.uri.fsPath, { text: d.getText(), version: d.version });
    return buffers;
  }
  private get current() {
    const current = this.services.get(this.root);
    if (!current) throw new Error("Open a Git repository first");
    return current;
  }
  private async ensureRoot() {
    if (this.root) return;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      try {
        const root = (
          await run("git", ["rev-parse", "--show-toplevel"], folder.uri.fsPath)
        )
          .toString()
          .trim();
        await this.addRoot(root);
      } catch {}
    }
    if (!this.services.size)
      throw new Error(
        "Open a folder containing a Git repository to review changes.",
      );
    this.root = this.services.keys().next().value!;
  }
  private async addRoot(root: string) {
    if (this.services.has(root)) return;
    const cfg = vscode.workspace.getConfiguration(
      "changesWorkbench",
      vscode.Uri.file(root),
    );
    const navigation = new Navigator(
      root,
      path.join(this.context.extensionPath, "dist"),
      path.join(this.context.extensionPath, "assets"),
      () => this.buffers(),
      cfg.get<number>("cacheMiB", 64) * 1024 * 1024,
    );
    const git = new GitService(root, () => this.buffers());
    const deep = new DeepManager(
      root,
      path.join(
        this.context.globalStorageUri.fsPath,
        Buffer.from(root).toString("hex"),
      ),
      (language) => {
        const c = vscode.workspace.getConfiguration(
          "changesWorkbench",
          vscode.Uri.file(root),
        );
        return {
          command: c.get<string>(
            `${language}.command`,
            language === "java" ? "jdtls" : "kotlin-lsp",
          ),
          args: c.get<string[]>(
            `${language}.args`,
            language === "java" ? [] : ["--stdio"],
          ),
        };
      },
      (message) => {
        this.deepStatus = message;
        this.status.tooltip = `Changes Workbench · ${message}`;
        // Only the status line changes: a full refresh would reset an open definition preview.
        this.send("status", {
          root,
          deepStatus: message,
          mode: deep.enabled ? "deep" : "light",
        });
      },
      cfg.get("deepIdleMinutes", 10),
      (message) => this.log.appendLine(message),
      () => navigation.listFiles(),
    );
    const service: Services = { git, navigation, deep, watchers: [] };
    this.services.set(root, service);
    try {
      const paths = await Promise.all(
        ["--absolute-git-dir", "--git-common-dir"].map((flag) =>
          git
            .git(["rev-parse", flag])
            .then((b) => path.resolve(root, b.toString().trim())),
        ),
      );
      for (const directory of new Set(paths)) {
        service.watchers.push(
          watch(directory, { persistent: false }, () => this.changed()),
        );
      }
    } catch {}
  }
  private async serviceFor(file: string) {
    await this.ensureRoot();
    const roots = [...this.services.keys()]
      .filter((r) => inside(r, file))
      .sort((a, b) => b.length - a.length);
    return roots.length ? this.services.get(roots[0]) : undefined;
  }
  private changed(uri?: vscode.Uri, type?: 1 | 2 | 3) {
    this.epoch++;
    this.snapshots.clear();
    this.nativeBlameCache.clear();
    for (const s of this.services.values()) {
      s.navigation.invalidateFiles();
      if (uri?.scheme === "file" && type) s.deep.fileChanged(uri.fsPath, type);
    }
    clearTimeout(this.refreshTimer);
    if (this.panel)
      this.refreshTimer = setTimeout(
        () =>
          void this.refresh().catch((e) =>
            this.send("state", { error: String(e) }),
          ),
        250,
      );
  }
  private async refresh() {
    if (!this.panel) return;
    await this.ensureRoot();
    const service = this.current;
    const epoch = this.epoch;
    const root = this.root,
      scope = this.scope;
    const changes = await service.git.changes(scope);
    for (const change of changes)
      if (this.reviews.has(root, scope, change.path)) {
        try {
          const snap = await service.git.snapshot(
            change.path,
            scope,
            undefined,
            change,
          );
          change.reviewed = this.reviews.matches(
            root,
            scope,
            change.path,
            snap.fingerprint,
          );
        } catch {
          change.reviewed = false;
        }
      }
    if (epoch !== this.epoch || root !== this.root || scope !== this.scope)
      return;
    const state: ViewState = {
      intellijKeymap: vscode.workspace
        .getConfiguration("changesWorkbench")
        .get("intellijKeymap", true),
      repos: [...this.services.keys()].map((root) => ({
        root,
        name: path.basename(root),
      })),
      repo: {
        root,
        name: path.basename(root),
        head: await service.git.head(),
        branch: await service.git.branch(),
        changes,
      },
      scope,
      mode: service.deep.enabled ? "deep" : "light",
      deepStatus: this.deepStatus,
      layout: this.context.workspaceState.get(
        "layout",
        vscode.workspace
          .getConfiguration("changesWorkbench")
          .get("diffLayout", "sideBySide"),
      ),
    };
    this.send("state", state);
    return state;
  }
  async open() {
    try {
      await this.ensureRoot();
      if (this.panel) {
        this.panel.reveal();
        await this.refresh();
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        "changesWorkbench",
        "Changes",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [
            vscode.Uri.joinPath(this.context.extensionUri, "dist"),
          ],
        },
      );
      this.panel = panel;
      void vscode.commands.executeCommand(
        "setContext",
        "changesWorkbench.active",
        panel.active,
      );
      panel.iconPath = new vscode.ThemeIcon("git-compare");
      const nonce = randomBytes(16).toString("hex");
      const uri = (file: string) =>
        panel.webview.asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, "dist", file),
        );
      panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; font-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}; worker-src blob: ${panel.webview.cspSource};"><link rel="stylesheet" href="${uri("webview.css")}"></head><body><div id="root"></div><script nonce="${nonce}">window.__WORKER_URL__=${JSON.stringify(uri("editor.worker.js").toString())};</script><script nonce="${nonce}" src="${uri("webview.js")}"></script></body></html>`;
      panel.webview.onDidReceiveMessage(
        (message) => void this.receive(message),
        undefined,
        this.disposables,
      );
      panel.onDidDispose(() => {
        this.panel = undefined;
        void vscode.commands.executeCommand(
          "setContext",
          "changesWorkbench.active",
          false,
        );
        for (const request of this.requests.values()) request.abort();
        this.requests.clear();
        this.snapshots.clear();
      });
      panel.onDidChangeViewState((e) => {
        void vscode.commands.executeCommand(
          "setContext",
          "changesWorkbench.active",
          e.webviewPanel.active,
        );
        if (e.webviewPanel.visible) void this.refresh();
      });
    } catch (e) {
      vscode.window.showErrorMessage(String(e));
    }
  }
  private send(event: string, data: unknown) {
    void this.panel?.webview.postMessage({ type: "event", event, data });
  }
  private async receive(message: any) {
    if (message?.type === "cancel" && Number.isInteger(message.id)) {
      this.requests.get(message.id)?.abort();
      return;
    }
    if (
      message?.type !== "request" ||
      !Number.isInteger(message.id) ||
      typeof message.method !== "string" ||
      !message.params ||
      typeof message.params !== "object"
    )
      return;
    const request = message as RequestMessage;
    const abort = new AbortController();
    this.requests.set(request.id, abort);
    try {
      const result = await this.handle(request, abort.signal);
      if (!abort.signal.aborted)
        await this.panel?.webview.postMessage({
          type: "response",
          id: request.id,
          result,
          version: request.version,
        });
    } catch (e) {
      if (!abort.signal.aborted)
        await this.panel?.webview.postMessage({
          type: "response",
          id: request.id,
          error: e instanceof Error ? e.message : String(e),
          version: request.version,
        });
    } finally {
      this.requests.delete(request.id);
    }
  }
  private async handle(
    request: RequestMessage,
    signal: AbortSignal,
  ): Promise<unknown> {
    const p = request.params;
    const str = (key: string) => {
      if (typeof p[key] !== "string") throw new Error(`Invalid ${key}`);
      return p[key] as string;
    };
    const number = (key: string) => {
      if (!Number.isInteger(p[key]) || Number(p[key]) < 0)
        throw new Error(`Invalid ${key}`);
      return Number(p[key]);
    };
    await this.ensureRoot();
    const service = this.current;
    switch (request.method) {
      case "refresh":
        return this.refresh();
      case "selectRepo": {
        const root = str("root");
        if (!this.services.has(root)) throw new Error("Unknown repository");
        this.root = root;
        this.snapshots.clear();
        return this.refresh();
      }
      case "scope": {
        const scope = str("scope");
        if (!["all", "staged", "unstaged"].includes(scope))
          throw new Error("Invalid scope");
        this.scope = scope as Scope;
        this.snapshots.clear();
        return this.refresh();
      }
      case "snapshot": {
        const file = str("path");
        const scope = this.scope;
        const snapshot = await service.git.snapshot(file, scope, signal);
        if (service !== this.current || scope !== this.scope)
          throw new Error("View changed");
        this.snapshots.set(file, snapshot);
        this.prioritize(service, file, snapshot.current);
        return snapshot;
      }
      case "blame": {
        const file = str("path");
        const snapshot = this.snapshots.get(file);
        if (!snapshot || snapshot.version !== request.version)
          throw new Error("File changed; refresh the view");
        return service.git.blame(file, snapshot.current, undefined, signal);
      }
      case "navigate": {
        const file = str("path");
        const snapshot = this.snapshots.get(file);
        if (!snapshot || snapshot.version !== request.version)
          throw new Error("File changed; refresh the view");
        const epoch = this.epoch;
        const result = await this.navigate(
          service,
          file,
          snapshot.current,
          number("line"),
          number("column"),
          signal,
        );
        if (
          epoch !== this.epoch ||
          service !== this.current ||
          this.snapshots.get(file)?.version !== request.version
        )
          throw new Error("File changed during navigation");
        for (const candidate of result.candidates)
          this.allowedLocations.add(candidate.path);
        return result;
      }
      case "openLocation":
        return this.openLocation(str("path"), number("line"), number("column"));
      case "review": {
        const file = str("path");
        const snapshot = await service.git.snapshot(file, this.scope, signal);
        if (snapshot.version !== request.version)
          throw new Error("File changed; review the updated diff first");
        if (snapshot.tooLarge)
          throw new Error("Review large files in the native editor.");
        await this.reviews.toggle(
          this.root,
          this.scope,
          file,
          snapshot.fingerprint,
        );
        return this.refresh();
      }
      case "openCommit":
        return this.openCommit(str("sha"), str("path"));
      case "deep":
        if (p.enabled === true) service.deep.enable();
        else await service.deep.stop();
        return this.refresh();
      case "chooseTheme":
        return this.chooseTheme();
      case "configureDeep":
        return this.configureDeep();
      case "layout": {
        const layout = str("layout");
        if (!["sideBySide", "unified"].includes(layout))
          throw new Error("Invalid layout");
        await this.context.workspaceState.update("layout", layout);
        return;
      }
      default:
        throw new Error("Unknown request");
    }
  }
  private async configureDeep() {
    const config = vscode.workspace.getConfiguration("changesWorkbench");
    const entries = await Promise.all(
      ["kotlin", "java"].map(async (language) => {
        const command = config.get<string>(
          `${language}.command`,
          language === "java" ? "jdtls" : "kotlin-lsp",
        );
        const executable = await findExecutable(command);
        return {
          label: `${executable ? "$(check)" : "$(warning)"} ${language === "java" ? "Eclipse JDT LS" : "Kotlin LSP"}`,
          description: executable ? "Detected" : "Missing launcher",
          detail: executable ?? command,
          setting: `changesWorkbench.${language}`,
        };
      }),
    );
    const java = await findExecutable(
      process.env.JAVA_HOME
        ? path.join(process.env.JAVA_HOME, "bin", "java")
        : "java",
    );
    const selected = await vscode.window.showQuickPick(entries, {
      title: "Language servers · no processes started",
      placeHolder: `Java launcher ${java ? "detected" : "not found"} · choose a server to configure its executable`,
    });
    if (selected)
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        selected.setting,
      );
  }
  private async chooseTheme() {
    const selected = await vscode.window.showQuickPick(
      ["Dark", "Darcula", "Light"].map((name) => ({
        label: `IntelliJ ${name}`,
        theme: `Changes: IntelliJ ${name}`,
      })),
      {
        title: "IntelliJ color scheme",
        placeHolder: "Apply to the editor and Changes review",
      },
    );
    if (selected)
      await vscode.workspace
        .getConfiguration("workbench")
        .update(
          "colorTheme",
          selected.theme,
          vscode.ConfigurationTarget.Global,
        );
  }
  private async navigate(
    service: Services,
    file: string,
    text: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<Navigation> {
    if (!["java", "kotlin"].includes(languageOf(file)))
      return {
        word: "",
        candidates: [],
        confidence: "none",
        note: "Lightweight navigation supports Kotlin and Java.",
      };
    let note: string | undefined;
    let light: Navigation | undefined;
    if (service.deep.enabled) {
      try {
        const language = languageOf(file);
        // While the index builds, the server resolves only what it has open: send the likely
        // definitions and the files they depend on first.
        let hints: string[] = [];
        if (service.deep.indexing(language)) {
          const quiet = <T>(work: Promise<T>) =>
            work.catch((e) => {
              if (signal?.aborted) throw e;
              return undefined;
            });
          light = await quiet(
            service.navigation.resolve(file, text, line, column, signal),
          );
          hints =
            (await quiet(
              service.navigation.relatedFiles(
                file,
                text,
                light?.candidates.map((c) => c.path) ?? [],
                signal,
              ),
            )) ?? [];
        }
        const result = await service.deep.navigate(
          language,
          file,
          text,
          line,
          column,
          signal,
          hints,
        );
        this.deepStatus = service.deep.statusText;
        if (result.candidates.length) return result;
        note = result.note;
      } catch (e) {
        if (signal?.aborted) throw e;
        this.deepStatus = `Deep unavailable · ${String(e).slice(0, 100)}`;
        this.log.appendLine(String(e));
      }
    }
    light ??= await service.navigation.resolve(
      file,
      text,
      line,
      column,
      signal,
    );
    return note ? { ...light, note: light.note ?? note } : light;
  }
  private async libraryText(uri: vscode.Uri) {
    const key = uri.toString(true);
    let found = this.decompiled.get(key);
    for (const service of this.services.values()) {
      if (found) break;
      found = await service.deep.decompile(key);
    }
    if (!found)
      return "// This library file is shown by the deep analysis server. Turn on deep analysis (On demand) and open the definition again.\n";
    this.decompiled.delete(key);
    this.decompiled.set(key, found);
    while (this.decompiled.size > 20)
      this.decompiled.delete(this.decompiled.keys().next().value!);
    return found.code;
  }
  /** Let the deep server analyze a file the user is looking at before the full index is done. */
  private prioritize(service: Services, file: string, text?: string) {
    const language = languageOf(file);
    if (!service.deep.enabled || !["java", "kotlin"].includes(language)) return;
    if (typeof text !== "string") return;
    void service.deep
      .prioritize(language, file, text)
      .catch((e) => this.log.appendLine(String(e)));
  }
  private locationUri(file: string, root = this.root) {
    return /^[a-z][\w+.-]*:\/\//i.test(file)
      ? vscode.Uri.parse(file)
      : vscode.Uri.file(path.resolve(root, file));
  }
  private async openLocation(file: string, line: number, column: number) {
    const uri = this.locationUri(file);
    if (
      uri.scheme === "file" &&
      !inside(this.root, uri.fsPath) &&
      !this.allowedLocations.has(file)
    )
      throw new Error("Location is outside the repository");
    if (uri.scheme !== "file" && !this.allowedLocations.has(file))
      throw new Error("Unsupported location");
    await vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(line, column, line, column),
      preview: true,
    });
  }
  private navMarkdown(nav: Navigation, root: string) {
    const md = new vscode.MarkdownString();
    md.isTrusted = {
      enabledCommands: [
        "changesWorkbench.followDefinition",
        "changesWorkbench.openCommit",
      ],
    };
    for (const s of nav.candidates.slice(0, 4)) {
      md.appendCodeblock(s.signature, "kotlin");
      if (s.documentation) md.appendText(s.documentation + "\n");
      const file = /^[a-z]+:\/\//.test(s.path)
        ? s.path
        : path.resolve(root, s.path);
      this.allowedLocations.add(file);
      md.appendMarkdown(
        `\n[Open definition](command:changesWorkbench.followDefinition?${encodeURIComponent(JSON.stringify([file, s.line, s.column]))})\n`,
      );
    }
    if (nav.confidence === "candidate")
      md.appendText(
        "\nMatching declarations; type resolution may require deep analysis.",
      );
    if (nav.note) md.appendText("\n" + nav.note);
    return md;
  }
  private async nativeDefinition() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const service = await this.serviceFor(editor.document.uri.fsPath);
    if (!service) return;
    const position = editor.selection.active;
    const nav = await this.navigate(
      service,
      path.relative(service.git.root, editor.document.uri.fsPath),
      editor.document.getText(),
      position.line,
      position.character,
    );
    if (!nav.candidates.length) {
      vscode.window.showInformationMessage(
        nav.note ?? "No definition found. Try deep analysis.",
      );
      return;
    }
    const picked =
      nav.candidates.length === 1 && nav.confidence !== "candidate"
        ? nav.candidates[0]
        : (
            await vscode.window.showQuickPick(
              nav.candidates.map((s) => ({
                label: s.name,
                description: `${s.path}:${s.line + 1}`,
                symbol: s,
              })),
            )
          )?.symbol;
    if (picked) {
      this.allowedLocations.add(picked.path);
      await this.openLocation(picked.path, picked.line, picked.column);
    }
  }
  private async nativeBlame(service: Services, document: vscode.TextDocument) {
    const key = `${document.version}:${await service.git.head()}`;
    const cache = this.nativeBlameCache.get(document.uri.fsPath);
    if (cache?.key === key) return cache.lines;
    const lines = await service.git.blame(
      path.relative(service.git.root, document.uri.fsPath),
      document.getText(),
    );
    if (this.nativeBlameCache.size >= 8)
      this.nativeBlameCache.delete(this.nativeBlameCache.keys().next().value!);
    this.nativeBlameCache.set(document.uri.fsPath, { key, lines });
    return lines;
  }
  private async openCommit(sha: string, file: string, root = this.root) {
    const service = this.services.get(root);
    if (!service) throw new Error("Unknown repository");
    const snap = await service.git.commitSnapshot(sha, file);
    if (snap.binary) throw new Error("Binary commit preview is not supported");
    const make = (side: string, text: string) => {
      const uri = vscode.Uri.parse(
        `changes-commit:/${sha}/${side}/${encodeURIComponent(file)}`,
      );
      this.virtual.set(uri.toString(), text);
      return uri;
    };
    while (this.virtual.size > 20)
      this.virtual.delete(this.virtual.keys().next().value!);
    await vscode.commands.executeCommand(
      "vscode.diff",
      make("before", snap.original),
      make("after", snap.current),
      `${path.basename(file)} · ${sha.slice(0, 7)}`,
      { preview: true },
    );
  }
  async stop() {
    for (const service of this.services.values()) {
      await service.deep.stop();
      service.navigation.dispose();
      for (const watcher of service.watchers) watcher.close();
    }
  }
  dispose() {
    void this.stop();
    clearTimeout(this.refreshTimer);
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
    this.status.dispose();
    this.log.dispose();
  }
}
