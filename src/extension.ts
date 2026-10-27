import * as vscode from "vscode";
import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { run } from "./host/process";
import { GitService, inside, type Buffers } from "./host/git";
import { Navigator } from "./host/navigation";
import { DeepManager } from "./host/deep";
import { ReviewStore } from "./host/reviews";
import { findExecutable } from "./host/dependencies";
import {
  androidTargets,
  findAdb,
  forwardJdwp,
  jvmTargets,
  removeForward,
  sourcePaths,
  type DebugTarget,
} from "./host/debug";
import {
  listFiles,
  rank,
  ripgrep,
  scanDeclarations,
  searchDeclarations,
  searchFiles,
  searchText,
  type Declaration,
} from "./host/search";
import {
  INIT_SCRIPT,
  buildCommand,
  findModules,
  defaultVariant,
  loadRuns,
  parseApplicationIds,
  parseVariants,
  withVariant,
  type RunConfiguration,
} from "./host/runs";
import {
  languageOf,
  revertChange,
  type LineChange,
  type RunInfo,
  type Scope,
  type Snapshot,
  type ViewState,
  type RequestMessage,
  type Navigation,
  type BlameLine,
  type SearchHit,
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
  /** Search Everywhere indexes per root, rebuilt on the next search after files change. */
  private searchIndex = new Map<
    string,
    { files?: Promise<string[]>; declarations?: Promise<Declaration[]> }
  >();
  private ripgrep = ripgrep(vscode.env.appRoot);
  /** A popup to open once the webview has loaded. */
  private pendingCommand?: string;
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
  private runStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    8,
  );
  /** Running run configurations, keyed by `root\0name`. */
  private executions = new Map<string, vscode.TaskExecution>();
  /** Run configurations per root; rereading walks the tree for Gradle/Maven modules. */
  private runCache = new Map<string, Promise<RunConfiguration[]>>();
  /** The last run configurations read per root, shown while a newer read is in progress. */
  private runResults = new Map<string, RunConfiguration[]>();
  /** The last view per root and scope, shown at once while the panel reloads. */
  private lastStates = new Map<string, ViewState>();
  /** Gradle reads of Android build variants in progress, and modules whose read failed, by module. */
  private variantLoads = new Map<string, Promise<string[]>>();
  private variantFailures = new Set<string>();
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
    command("run", () => this.runSelected());
    command("selectRun", () => this.pickRun());
    command("selectVariant", () => this.pickVariant());
    command("build", () => this.buildSelected());
    command("attachDebugger", () => this.attachDebugger());
    for (const name of ["searchEverywhere", "findInFiles"])
      command(name, async () => {
        // The webview is kept while hidden, so a revealed panel gets the command directly.
        if (this.panel) {
          this.panel.reveal();
          return this.send("command", name);
        }
        this.pendingCommand = name;
        await this.open();
      });
    this.runStatus.command = "changesWorkbench.run";
    // Run configurations launch as tasks, so the terminal panel shows and stops them.
    this.disposables.push(
      this.runStatus,
      vscode.tasks.onDidStartTask((e) => {
        const d = e.execution.task.definition;
        if (d.type !== "changesWorkbench") return;
        this.executions.set(`${d.root}\0${d.name}`, e.execution);
        void this.updateRuns();
      }),
      vscode.tasks.onDidEndTask((e) => {
        const d = e.execution.task.definition;
        if (d.type !== "changesWorkbench") return;
        const key = `${d.root}\0${d.name}`;
        if (this.executions.get(key) === e.execution)
          this.executions.delete(key);
        void this.updateRuns();
      }),
    );
    void this.updateRuns();
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
    navigation.ripgrep = this.ripgrep;
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
    if (
      uri &&
      /[\\/](\.run|runConfigurations)[\\/][^\\/]+\.xml$|[\\/]\.idea[\\/]workspace\.xml$|[\\/](build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|local\.properties)$/.test(
        uri.fsPath,
      )
    ) {
      this.runCache.clear();
      this.variantFailures.clear();
      void this.updateRuns();
    }
    this.epoch++;
    this.searchIndex.clear();
    this.snapshots.clear();
    this.nativeBlameCache.clear();
    for (const s of this.services.values()) {
      s.navigation.invalidateFiles();
      if (uri?.scheme === "file" && type) s.deep.fileChanged(uri.fsPath, type);
    }
    clearTimeout(this.refreshTimer);
    // A hidden panel refreshes when it is shown again.
    if (this.panel?.visible)
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
    await Promise.all(
      changes
        .filter((change) => this.reviews.has(root, scope, change.path))
        .map(async (change) => {
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
        }),
    );
    if (epoch !== this.epoch || root !== this.root || scope !== this.scope)
      return;
    // Run configurations come later through the `runs` event when they are not read yet:
    // walking a large repository for modules must not hold up the change list.
    const loaded = this.runResults.get(root);
    const runs = loaded ? this.runInfosFrom(root, loaded) : [];
    if (!loaded) void this.updateRuns();
    const state: ViewState = {
      intellijKeymap: vscode.workspace
        .getConfiguration("changesWorkbench")
        .get("intellijKeymap", true),
      runs,
      selectedRun: this.selectedRun(root, runs),
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
    this.lastStates.set(`${root}\0${scope}`, state);
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
          // Switching back to the tab should not reload the diff and the change tree.
          retainContextWhenHidden: true,
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
      case "refresh": {
        // Show the last view at once; the fresh one replaces it when Git answers.
        const last = this.lastStates.get(`${this.root}\0${this.scope}`);
        if (last) this.send("state", last);
        const state = await this.refresh();
        if (this.pendingCommand) this.send("command", this.pendingCommand);
        this.pendingCommand = undefined;
        return state;
      }
      case "searchEverywhere": {
        const tab = str("tab");
        const query = str("query").trim();
        if (!query) return { hits: [], truncated: false };
        const limit = tab === "all" ? 6 : 60;
        const hits = [];
        const index = this.searchIndex.get(this.root) ?? {};
        this.searchIndex.set(this.root, index);
        if (tab === "all" || tab === "classes" || tab === "symbols") {
          const root = this.root;
          index.declarations ??= scanDeclarations(this.ripgrep, root);
          index.declarations.catch(() => {
            if (this.searchIndex.get(root) === index)
              index.declarations = undefined;
          });
          const declarations = await index.declarations;
          if (tab !== "symbols")
            hits.push(...searchDeclarations(declarations, query, true, limit));
          if (tab !== "classes")
            hits.push(
              ...searchDeclarations(
                tab === "all"
                  ? declarations.filter((d) => !d.type)
                  : declarations,
                query,
                false,
                limit,
              ),
            );
        }
        if (tab === "all" || tab === "files") {
          index.files ??= listFiles(this.root);
          index.files.catch(() => (index.files = undefined));
          hits.push(...searchFiles(await index.files, query, limit));
        }
        if (tab === "all" || tab === "actions")
          hits.push(
            ...rank(
              this.actions(),
              query,
              (a) => a.name,
              limit,
              (a) => (a.detail ? 0 : 1),
            ),
          );
        if (tab === "text")
          return searchText(
            this.ripgrep,
            this.root,
            { query, matchCase: false, words: false, regex: false, mask: "" },
            200,
            signal,
          );
        return { hits, truncated: false };
      }
      case "findInFiles":
        if (!str("query")) return { hits: [], truncated: false };
        return searchText(
          this.ripgrep,
          this.root,
          {
            query: str("query"),
            matchCase: p.matchCase === true,
            words: p.words === true,
            regex: p.regex === true,
            mask: str("mask"),
          },
          1000,
          signal,
        );
      case "searchPreview":
        return this.preview(str("path"));
      case "runAction": {
        const action = this.actions().find((a) => a.command === str("command"));
        if (!action) throw new Error("Unknown action");
        await vscode.commands.executeCommand(action.command!);
        return;
      }
      case "selectRepo": {
        const root = str("root");
        if (!this.services.has(root)) throw new Error("Unknown repository");
        this.root = root;
        this.snapshots.clear();
        void this.updateRuns();
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
      case "rollback": {
        const file = str("path");
        const snapshot = this.snapshots.get(file);
        if (!snapshot || snapshot.version !== request.version)
          throw new Error("File changed; refresh the view");
        if (snapshot.scope === "staged" || snapshot.conflicted)
          throw new Error(
            snapshot.conflicted
              ? "Resolve the conflict in the editor first."
              : "Rollback works on working tree changes; switch to All changes or Unstaged.",
          );
        const c = (p.change ?? {}) as Record<string, unknown>;
        const change = Object.fromEntries(
          [
            "originalStartLineNumber",
            "originalEndLineNumber",
            "modifiedStartLineNumber",
            "modifiedEndLineNumber",
          ].map((key) => [key, Number(c[key])]),
        ) as unknown as LineChange;
        await this.writeWorkingFile(
          service.git.root,
          file,
          snapshot.current,
          revertChange(snapshot.current, snapshot.original, change),
        );
        return;
      }
      case "run":
        return this.startRun(this.root, str("name"));
      case "attachDebugger":
        return this.attachDebugger();
      case "build":
        return this.startBuild(this.root, str("name"));
      case "stopRun":
        this.executions.get(`${this.root}\0${str("name")}`)?.terminate();
        return;
      case "selectRun":
        await this.context.workspaceState.update(
          `selectedRun:${this.root}`,
          str("name"),
        );
        return this.updateRuns();
      case "selectVariant":
        await this.context.workspaceState.update(
          `variant:${this.root}\0${str("name")}`,
          str("variant"),
        );
        return this.updateRuns();
      case "reloadVariants": {
        const config = (await this.loadRuns(this.root)).find(
          (r) => r.name === str("name"),
        );
        if (config?.android?.variants) await this.loadVariants(config, true);
        return;
      }
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
  /** Replace the working copy (the open buffer when there is one) with `text`, as an undoable edit. */
  private async writeWorkingFile(
    root: string,
    file: string,
    expected: string,
    text: string,
  ) {
    const target = path.resolve(root, file);
    if (!inside(root, target)) throw new Error("Invalid path");
    const uri = vscode.Uri.file(target);
    const stat = await fs.lstat(target).catch(() => undefined);
    if (stat?.isSymbolicLink())
      throw new Error("Roll back symbolic links with Git.");
    if (!stat) {
      // A deleted file: rolling back recreates it.
      if (expected !== "") throw new Error("File changed; refresh the view");
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const old = document.getText();
    if (old !== expected.replace(/^\uFEFF/, ""))
      throw new Error("File changed; refresh the view");
    // Edit only the differing middle so cursors and folding elsewhere stay put.
    let start = 0;
    while (start < old.length && old[start] === text[start]) start++;
    let end = 0;
    while (
      end < old.length - start &&
      end < text.length - start &&
      old[old.length - 1 - end] === text[text.length - 1 - end]
    )
      end++;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        document.positionAt(start),
        document.positionAt(old.length - end),
      ),
      text.slice(start, text.length - end),
    );
    const dirty = document.isDirty;
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error("Could not roll back the change");
    if (!dirty) await document.save();
  }
  private async runInfos(root: string): Promise<RunInfo[]> {
    return this.runInfosFrom(root, await this.loadRuns(root));
  }
  private runInfosFrom(root: string, runs: RunConfiguration[]): RunInfo[] {
    return runs.map((r) => {
      const variant = this.variant(root, r);
      return {
        name: r.name,
        type: r.type,
        detail: r.compound
          ? `Compound: ${r.compound.join(", ")}`
          : (withVariant(r, variant) ?? r.reason ?? ""),
        runnable: Boolean(r.command || r.compound?.length),
        running: this.executions.has(`${root}\0${r.name}`),
        build: buildCommand(r, variant),
        ...(r.android?.variants && {
          variants: this.cachedVariants(r) ?? [],
          variant,
          loadingVariants: this.variantLoads.has(r.android.module),
        }),
      };
    });
  }
  /** Build variants of an Android run's module, as last read from Gradle. */
  private cachedVariants(run: RunConfiguration) {
    return run.android?.variants
      ? this.context.workspaceState.get<string[]>(
          `variants:${run.android.module}`,
        )
      : undefined;
  }
  /** The variant chosen for an Android run, or IntelliJ's default. */
  private variant(root: string, run: RunConfiguration) {
    const variants = this.cachedVariants(run);
    if (!variants) return undefined;
    const saved = this.context.workspaceState.get<string>(
      `variant:${root}\0${run.name}`,
    );
    return saved && variants.includes(saved) ? saved : defaultVariant(variants);
  }
  /** Ask Gradle for the module's installable variants (configuring the build can take a while). */
  private loadVariants(
    config: RunConfiguration,
    fresh = false,
  ): Promise<string[]> {
    const { module } = config.android!;
    const variants = config.android!.variants!;
    const cached = this.cachedVariants(config);
    if (cached && !fresh) return Promise.resolve(cached);
    let load = this.variantLoads.get(module);
    if (load) return load;
    this.variantFailures.delete(module);
    load = (async () => {
      await this.writeInitScript();
      const output = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `Reading build variants of ${config.name}`,
        },
        () =>
          run(
            process.platform === "win32" ? "cmd.exe" : "/bin/sh",
            process.platform === "win32"
              ? ["/d", "/s", "/c", variants]
              : ["-c", variants],
            config.cwd,
            { env: config.env, timeout: 15 * 60_000 },
          ),
      );
      const found = parseVariants(output.toString());
      await this.context.workspaceState.update(
        `variantIds:${module}`,
        parseApplicationIds(output.toString()),
      );
      await this.context.workspaceState.update(`variants:${module}`, found);
      return found;
    })();
    this.variantLoads.set(module, load);
    void load
      .catch((e) => {
        this.variantFailures.add(module);
        this.log.appendLine(`Build variants of ${config.name}: ${e}`);
        void vscode.window
          .showErrorMessage(
            `Could not read the build variants of '${config.name}'.`,
            "Show Log",
          )
          .then((choice) => choice && this.log.show());
      })
      .finally(() => {
        this.variantLoads.delete(module);
        void this.updateRuns();
      });
    void this.updateRuns();
    return load;
  }
  private async pickVariant(): Promise<void> {
    try {
      await this.ensureRoot();
      const root = this.root;
      const name = this.selectedRun(root, await this.runInfos(root));
      const run = (await this.loadRuns(root)).find((r) => r.name === name);
      if (!run?.android?.variants) {
        vscode.window.showInformationMessage(
          run?.android
            ? `'${run.name}' has no product flavors: it installs the debug build.`
            : "The selected run configuration is not an Android app.",
        );
        return;
      }
      const reload = "$(refresh) Reload build variants";
      const current = this.variant(root, run);
      const variants = await this.loadVariants(run);
      const picked = await vscode.window.showQuickPick(
        [
          ...variants.map((label) => ({
            label,
            description: label === current ? "selected" : undefined,
          })),
          { label: reload },
        ],
        { title: `Build variant of '${run.name}'` },
      );
      if (!picked) return;
      if (picked.label === reload) {
        await this.loadVariants(run, true);
        return this.pickVariant();
      }
      await this.context.workspaceState.update(
        `variant:${root}\0${run.name}`,
        picked.label,
      );
      await this.updateRuns();
    } catch (e) {
      vscode.window.showErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  private selectedRun(root: string, runs: RunInfo[]) {
    const saved = this.context.workspaceState.get<string>(
      `selectedRun:${root}`,
    );
    // Nothing is selected until the user picks a configuration: selecting one can be costly
    // (an Android app reads its build variants from Gradle).
    return runs.find((r) => r.name === saved)?.name;
  }
  /** Refresh the status bar run button and the panel's run widget. */
  private async updateRuns() {
    try {
      await this.ensureRoot();
      const root = this.root;
      const runs = await this.runInfos(root);
      const selected = runs.find(
        (r) => r.name === this.selectedRun(root, runs),
      );
      void vscode.commands.executeCommand(
        "setContext",
        "changesWorkbench.hasRuns",
        runs.length > 0,
      );
      void vscode.commands.executeCommand(
        "setContext",
        "changesWorkbench.androidRun",
        Boolean(selected?.variants),
      );
      // Android Studio knows the variants after a sync; read them once the app is selected.
      const config = (await this.loadRuns(root)).find(
        (r) => r.name === selected?.name,
      );
      if (
        config?.android?.variants &&
        !this.cachedVariants(config) &&
        !this.variantLoads.has(config.android.module) &&
        !this.variantFailures.has(config.android.module)
      )
        void this.loadVariants(config).catch(() => {});
      if (!selected && runs.length) {
        this.runStatus.text = "$(play) Select Run Configuration";
        this.runStatus.tooltip = "Choose a run configuration";
        this.runStatus.show();
      } else if (selected) {
        this.runStatus.text = `$(${selected.running ? "debug-restart" : "play"}) ${selected.name}${selected.variant ? ` · ${selected.variant}` : ""}`;
        this.runStatus.tooltip = `${selected.running ? "Rerun" : "Run"} '${selected.name}'\n${selected.detail}`;
        this.runStatus.show();
      } else this.runStatus.hide();
      this.send("runs", { root, runs, selectedRun: selected?.name });
    } catch {
      this.runStatus.hide();
    }
  }
  private async runSelected() {
    try {
      await this.ensureRoot();
      const runs = await this.runInfos(this.root);
      const name = this.selectedRun(this.root, runs);
      if (name) await this.startRun(this.root, name);
      else if (runs.length) await this.pickRun();
      else
        vscode.window.showInformationMessage(
          "No run configurations or Android app modules found.",
        );
    } catch (e) {
      vscode.window.showErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  /** Attach to Process, as in IntelliJ and Android Studio: debuggable apps on devices and JVMs. */
  private async attachDebugger() {
    try {
      await this.ensureRoot();
      if (!(await this.ensureJavaDebugger())) return;
      const root = this.root;
      const runs = await this.loadRuns(root).catch(() => []);
      const apps = runs.filter((r) => r.android);
      const adb = findAdb([...new Set(apps.map((r) => r.cwd))]);
      const appIds = apps.flatMap((r) => [
        ...(r.android!.applicationId ? [r.android!.applicationId] : []),
        ...(this.context.workspaceState.get<string[]>(
          `variantIds:${r.android!.module}`,
        ) ?? []),
      ]);
      type Item = vscode.QuickPickItem & {
        target?: DebugTarget;
        remote?: boolean;
      };
      const remote: Item = {
        label: "$(plug) Remote JVM…",
        description: "Attach to a JVM debug port (host:port)",
        remote: true,
      };
      const pick = vscode.window.createQuickPick<Item>();
      pick.title = "Attach to Process";
      pick.placeholder = "Choose a process to attach the debugger to";
      pick.matchOnDescription = true;
      pick.busy = true;
      pick.items = [remote];
      pick.show();
      const chosen = new Promise<Item | undefined>((resolve) => {
        pick.onDidAccept(() => resolve(pick.selectedItems[0]));
        pick.onDidHide(() => resolve(undefined));
      });
      void Promise.all([androidTargets(adb, appIds), jvmTargets()]).then(
        ([android, jvms]) => {
          const items: Item[] = [];
          let device = "";
          for (const target of android) {
            if (target.serial !== device) {
              device = target.serial!;
              items.push({
                label: `${target.device} (${target.serial})`,
                kind: vscode.QuickPickItemKind.Separator,
              });
            }
            items.push({
              label: `$(device-mobile) ${target.name}`,
              description: `pid ${target.pid}${target.project ? " · this project" : ""}`,
              target,
            });
          }
          if (jvms.length)
            items.push({
              label: "Java (local)",
              kind: vscode.QuickPickItemKind.Separator,
            });
          for (const target of jvms)
            items.push({
              label: `$(coffee) ${target.name}`,
              description: `pid ${target.pid} · ${target.host}:${target.port}`,
              target,
            });
          items.push(
            { label: "", kind: vscode.QuickPickItemKind.Separator },
            remote,
          );
          pick.items = items;
          pick.placeholder =
            android.length || jvms.length
              ? "Choose a process to attach the debugger to"
              : "No debuggable processes: start a debug build on a device, or a JVM with -agentlib:jdwp";
          pick.busy = false;
        },
      );
      const item = await chosen;
      pick.dispose();
      if (!item) return;
      if (item.remote) {
        const address = await vscode.window.showInputBox({
          title: "Attach to Remote JVM",
          value: "localhost:5005",
          prompt:
            "Host and port of a JVM started with -agentlib:jdwp=transport=dt_socket,server=y",
          validateInput: (v) =>
            /^[\w.-]+:\d+$/.test(v.trim()) ? undefined : "Use host:port",
        });
        if (!address) return;
        const [host, port] = address.trim().split(":");
        return this.attach(root, {
          kind: "jvm",
          name: address.trim(),
          pid: 0,
          host,
          port: Number(port),
        });
      }
      if (item.target) await this.attach(root, item.target, adb);
    } catch (e) {
      vscode.window.showErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  private async attach(root: string, target: DebugTarget, adb = "adb") {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    const config: vscode.DebugConfiguration = {
      type: "java",
      request: "attach",
      name:
        target.kind === "android"
          ? `${target.name} (${target.device})`
          : `${target.name}${target.pid ? ` (pid ${target.pid})` : ""}`,
      hostName: target.host ?? "localhost",
      port: target.port,
      timeout: 30000,
      sourcePaths: await sourcePaths(
        (await findModules(root)).map((m) => m.dir),
      ),
    };
    if (target.kind === "android") {
      // The app's JDWP is reached through a local port that adb forwards.
      const port = await forwardJdwp(adb, target.serial!, target.pid);
      config.port = port;
      const sub = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.configuration.port !== port) return;
        sub.dispose();
        void removeForward(adb, target.serial!, port);
      });
      if (!(await vscode.debug.startDebugging(folder, config))) {
        sub.dispose();
        await removeForward(adb, target.serial!, port);
      }
      return;
    }
    await vscode.debug.startDebugging(folder, config);
  }
  /** Attaching uses Microsoft's Java debugger, which needs Red Hat's Java language support. */
  private async ensureJavaDebugger() {
    const missing = ["vscjava.vscode-java-debug", "redhat.java"].filter(
      (id) => !vscode.extensions.getExtension(id),
    );
    if (!missing.length) return true;
    const choice = await vscode.window.showInformationMessage(
      "Attaching a debugger uses the Debugger for Java and Language Support for Java extensions.",
      "Install",
    );
    if (choice !== "Install") return false;
    for (const id of missing)
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        id,
      );
    return true;
  }
  private async buildSelected() {
    try {
      await this.ensureRoot();
      const name = this.selectedRun(this.root, await this.runInfos(this.root));
      if (!name) {
        vscode.window.showInformationMessage(
          "Select a run configuration to build.",
        );
        return;
      }
      await this.startBuild(this.root, name);
    } catch (e) {
      vscode.window.showErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  /** IntelliJ's Build: compile the module the configuration runs, in its own terminal. */
  private async startBuild(root: string, name: string) {
    const run = (await this.loadRuns(root, true)).find((r) => r.name === name);
    if (!run) throw new Error(`Run configuration '${name}' not found`);
    const command = buildCommand(run, this.variant(root, run));
    if (!command)
      throw new Error(`'${name}' has no separate build step; run it instead.`);
    await this.stopExecution(`${root}\0Build ${name}`);
    await vscode.tasks.executeTask(
      this.task(root, run, command, `Build ${name}`),
    );
  }
  private async pickRun() {
    try {
      await this.ensureRoot();
      const root = this.root;
      const runs = await this.runInfos(root);
      const picked = await vscode.window.showQuickPick(
        runs.map((r) => ({
          label: `$(${r.running ? "debug-restart" : r.runnable ? "play" : "circle-slash"}) ${r.name}`,
          description: r.type,
          detail: r.detail,
          name: r.name,
        })),
        {
          title: "Run configuration",
          placeHolder: runs.length
            ? "Choose a configuration to run"
            : "No run configurations or Android app modules found",
        },
      );
      if (!picked) return;
      await this.context.workspaceState.update(
        `selectedRun:${root}`,
        picked.name,
      );
      await this.startRun(root, picked.name);
    } catch (e) {
      vscode.window.showErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  /** Launch a configuration (re-read from disk, never from the webview) in its own terminal. */
  private get initScript() {
    return path.join(
      this.context.globalStorageUri.fsPath,
      "changes-workbench-run.gradle",
    );
  }
  private loadRuns(root: string, fresh = false) {
    let runs = this.runCache.get(root);
    if (!runs || fresh) {
      runs = loadRuns(root, this.initScript);
      this.runCache.set(root, runs);
      runs.then((r) => this.runResults.set(root, r)).catch(() => {});
      runs.catch(() => this.runCache.delete(root));
    }
    return runs;
  }
  private async startRun(root: string, name: string, seen = new Set<string>()) {
    const runs = await this.loadRuns(root, seen.size === 0);
    const run = runs.find((r) => r.name === name);
    if (!run) throw new Error(`Run configuration '${name}' not found`);
    await this.context.workspaceState.update(`selectedRun:${root}`, name);
    if (seen.has(name)) return;
    seen.add(name);
    if (run.compound) {
      for (const part of run.compound) await this.startRun(root, part, seen);
      void this.updateRuns();
      return;
    }
    if (!run.command) throw new Error(run.reason);
    if (run.android?.variants)
      // Without the variant list Gradle falls back to `debug` or names the variants to choose from.
      await this.loadVariants(run).catch(() => {});
    const command = withVariant(run, this.variant(root, run))!;
    if (command.includes(this.initScript)) await this.writeInitScript();
    // Like IntelliJ's Rerun: stop the running instance first.
    await this.stopExecution(`${root}\0${name}`);
    await vscode.tasks.executeTask(this.task(root, run, command));
  }
  /** Terminate a running task and wait (up to 3 s) for it to end. */
  private async stopExecution(key: string) {
    const running = this.executions.get(key);
    if (running) {
      const ended = new Promise<void>((resolve) => {
        const sub = vscode.tasks.onDidEndTask((e) => {
          if (e.execution === running) {
            sub.dispose();
            resolve();
          }
        });
        setTimeout(() => {
          sub.dispose();
          resolve();
        }, 3000);
      });
      running.terminate();
      await ended;
    }
  }
  private async writeInitScript() {
    await fs.mkdir(path.dirname(this.initScript), { recursive: true });
    await fs.writeFile(this.initScript, INIT_SCRIPT);
  }
  private task(
    root: string,
    run: RunConfiguration,
    command: string,
    name = run.name,
  ) {
    const task = new vscode.Task(
      { type: "changesWorkbench", name, root },
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) ??
        vscode.TaskScope.Workspace,
      name,
      "Run",
      new vscode.ShellExecution(command, {
        cwd: run.cwd,
        env: run.env,
      }),
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
      focus: false,
      showReuseMessage: false,
    };
    return task;
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
  /** Commands contributed by installed extensions, for Search Everywhere's Actions tab. */
  private actions(): SearchHit[] {
    const title = (t: unknown) =>
      typeof t === "string"
        ? t
        : typeof (t as { value?: unknown })?.value === "string"
          ? (t as { value: string }).value
          : "";
    return vscode.extensions.all.flatMap((extension) => {
      const commands = extension.packageJSON?.contributes?.commands;
      return (Array.isArray(commands) ? commands : [])
        .filter(
          (c) =>
            typeof c?.command === "string" &&
            title(c.title) &&
            !title(c.title).startsWith("%"),
        )
        .map((c): SearchHit => ({
          kind: "action",
          name: title(c.title),
          detail: title(c.category).startsWith("%") ? "" : title(c.category),
          line: 0,
          column: 0,
          command: c.command,
        }));
    });
  }
  /** A repository file's text for the Find in Files preview. */
  private async preview(file: string) {
    const full = path.resolve(this.root, file);
    if (!inside(this.root, full)) throw new Error("Outside the repository");
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === "file" && d.uri.fsPath === full,
    );
    if (open) return { text: open.getText(), language: languageOf(file) };
    const real = await fs.realpath(full);
    if (!inside(await fs.realpath(this.root), real))
      throw new Error("Outside the repository");
    if ((await fs.stat(real)).size > 2 * 1024 * 1024)
      return { text: "File too large to preview.", language: "plaintext" };
    return {
      text: await fs.readFile(real, "utf8"),
      language: languageOf(file),
    };
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
