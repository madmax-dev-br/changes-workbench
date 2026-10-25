import { Worker } from "node:worker_threads";
import path from "node:path";
import * as fs from "node:fs/promises";
import { hash, inside, type Buffers } from "./git";
import { run } from "./process";
import type { ParsedFile, Navigation, SymbolInfo } from "../shared";
interface CacheEntry {
  digest: string;
  parsed: ParsedFile;
  bytes: number;
}
export class Navigator {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: ParsedFile) => void; reject: (e: Error) => void }
  >();
  private answers = new Map<string, Navigation>();
  private cache = new Map<string, CacheEntry>();
  private bytes = 0;
  private files?: Promise<string[]>;
  public stats = { parses: 0, hits: 0, filesListed: 0, searches: 0 };
  constructor(
    private root: string,
    private dist: string,
    private assets: string,
    private getBuffers: () => Buffers = () => new Map(),
    private limit = 64 * 1024 * 1024,
  ) {}
  private start() {
    if (this.worker) return;
    this.worker = new Worker(path.join(this.dist, "parser-worker.cjs"), {
      workerData: { assets: this.assets },
    });
    this.worker.on("message", ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      error ? request.reject(new Error(error)) : request.resolve(result);
    });
    this.worker.on("error", (error) => {
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      this.worker = undefined;
    });
  }
  async parse(
    file: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<ParsedFile> {
    if (signal?.aborted) throw new Error("Cancelled");
    const digest = hash(text),
      entry = this.cache.get(file);
    if (entry?.digest === digest) {
      this.stats.hits++;
      this.cache.delete(file);
      this.cache.set(file, entry);
      return entry.parsed;
    }
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error("File too large for lightweight navigation");
    this.start();
    const id = ++this.nextId;
    this.stats.parses++;
    const parsed = await new Promise<ParsedFile>((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id);
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", cancel);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", cancel);
          reject(e);
        },
      });
      this.worker!.postMessage({ id, file, text });
    });
    if (signal?.aborted) throw new Error("Cancelled");
    if (entry) {
      this.bytes -= entry.bytes;
      this.cache.delete(file);
    }
    const bytes = Buffer.byteLength(text) + JSON.stringify(parsed).length * 2;
    this.cache.set(file, { digest, parsed, bytes });
    this.bytes += bytes;
    while (this.bytes > this.limit && this.cache.size) {
      const key = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(key)!.bytes;
      this.cache.delete(key);
    }
    return parsed;
  }
  /** Repository files declaring the types a file imports, matched by file name and package path. */
  async importedFiles(file: string, text: string, signal?: AbortSignal) {
    const parsed = await this.parse(file, text, signal);
    const wanted = new Map<string, string>();
    for (const i of parsed.imports) {
      const parts = i.path.split(".");
      const name = parts.at(-1)!;
      if (name !== "*" && /^[A-Z]/.test(name))
        wanted.set(name, parts.slice(0, -1).join("/"));
    }
    if (!wanted.size) return [];
    const files = await this.listFiles();
    return files.filter((f) => {
      const name = path.basename(f).replace(/\.(kt|kts|java)$/, "");
      const pkg = wanted.get(name);
      return pkg !== undefined && path.dirname(f).endsWith(pkg);
    });
  }
  /**
   * Files a definition lookup in `file` depends on: the likely targets, then what the file and the
   * targets import or share a package with (their types pick overloads and member receivers).
   */
  async relatedFiles(
    file: string,
    text: string,
    targets: string[],
    signal?: AbortSignal,
  ) {
    const files = await this.listFiles();
    const siblings = (of: string) =>
      files
        .filter((f) => f !== of && path.dirname(f) === path.dirname(of))
        .slice(0, 8);
    const local = targets.filter((t) => !/^[a-z][\w+.-]*:/i.test(t));
    const related = [
      ...local,
      ...(await this.importedFiles(file, text, signal)),
      ...siblings(file),
    ];
    for (const target of local.slice(0, 4)) {
      if (signal?.aborted) throw new Error("Cancelled");
      const source = await this.read(target).catch(() => undefined);
      if (source === undefined) continue;
      related.push(
        ...(await this.importedFiles(target, source, signal).catch(() => [])),
        ...siblings(target),
      );
    }
    return [...new Set(related)].filter((f) => f !== file).slice(0, 24);
  }
  invalidateFiles() {
    this.files = undefined;
    this.answers.clear();
  }
  async listFiles() {
    this.files ??= run(
      "git",
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "*.kt",
        "*.kts",
        "*.java",
      ],
      this.root,
    )
      .then((b) => {
        const files = [...new Set(b.toString().split("\0").filter(Boolean))];
        this.stats.filesListed = files.length;
        return files;
      })
      .catch((e) => {
        this.files = undefined;
        throw e;
      });
    return this.files;
  }
  private async read(file: string) {
    const full = path.resolve(this.root, file);
    if (!inside(this.root, full)) throw new Error("Outside workspace");
    const buffer = this.getBuffers().get(full);
    if (buffer) return buffer.text;
    const real = await fs.realpath(full);
    if (!inside(await fs.realpath(this.root), real))
      throw new Error("Symlink outside workspace");
    const stat = await fs.stat(real);
    if (stat.size > 2 * 1024 * 1024) throw new Error("File too large");
    return fs.readFile(real, "utf8");
  }
  async resolve(
    file: string,
    text: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<Navigation> {
    if (signal?.aborted) throw new Error("Cancelled");
    const key = JSON.stringify([file, hash(text), line, column]);
    const cached = this.answers.get(key);
    if (cached) {
      this.stats.hits++;
      this.answers.delete(key);
      this.answers.set(key, cached);
      return cached;
    }
    const result = await this.resolveUncached(file, text, line, column, signal);
    if (signal?.aborted) throw new Error("Cancelled");
    this.answers.set(key, result);
    while (this.answers.size > 256)
      this.answers.delete(this.answers.keys().next().value!);
    return result;
  }
  private async resolveUncached(
    file: string,
    text: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<Navigation> {
    const lines = text.split("\n");
    const selected = lines[line] ?? "";
    const col = Math.min(column, selected.length);
    const left = selected.slice(0, col).match(/[\w$`]+$/)?.[0] ?? "";
    const right = selected.slice(col).match(/^[\w$`]+/)?.[0] ?? "";
    const word = (left + right).replace(/`/g, "");
    if (!word) return { word, candidates: [], confidence: "none" };
    const offset =
      lines.slice(0, line).reduce((n, s) => n + s.length + 1, 0) + col;
    const parsed = await this.parse(file, text, signal);
    const memberAccess = /\.\s*$/.test(selected.slice(0, col - left.length));
    const locals = parsed.symbols.filter(
      (s) =>
        s.name === word &&
        offset >= s.scopeStart &&
        offset <= s.scopeEnd &&
        (!["variable", "parameter", "formal_parameter"].includes(s.kind) ||
          s.start <= offset),
    );
    if (locals.length && !memberAccess) {
      const nearest = Math.min(...locals.map((s) => s.scopeEnd - s.scopeStart));
      const candidates = locals.filter(
        (s) => s.scopeEnd - s.scopeStart === nearest,
      );
      return {
        word,
        candidates,
        confidence: candidates.length === 1 ? "local" : "candidate",
      };
    }
    const imports = parsed.imports.filter(
      (i) =>
        i.alias === word ||
        i.path.endsWith("." + word) ||
        i.path.endsWith(".*"),
    );
    const wantedNames = new Set([
      word,
      ...imports.map((i) => i.path.split(".").at(-1)!).filter((n) => n !== "*"),
    ]);
    const files = await this.listFiles();
    let candidates = files.filter((f) =>
      wantedNames.has(path.basename(f).replace(/\.(kt|kts|java)$/, "")),
    );
    if (candidates.length < 16) {
      this.stats.searches++;
      try {
        const matches = (
          await run(
            "git",
            ["grep", "-l", "-z", "-F", word, "--", "*.kt", "*.kts", "*.java"],
            this.root,
            { signal, timeout: 2000, maxBytes: 1024 * 1024 },
          )
        )
          .toString()
          .split("\0")
          .filter(Boolean);
        candidates.push(...matches);
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
    candidates = [...new Set(candidates)].filter((f) => f !== file);
    candidates.sort(
      (a, b) =>
        Number(!a.startsWith(path.dirname(file))) -
        Number(!b.startsWith(path.dirname(file))),
    );
    const definitions: SymbolInfo[] = [];
    let imported: SymbolInfo[] = [];
    for (const other of candidates.slice(0, 24)) {
      if (signal?.aborted) throw new Error("Cancelled");
      try {
        const result = await this.parse(other, await this.read(other), signal);
        for (const symbol of result.symbols) {
          if (
            !wantedNames.has(symbol.name) ||
            ["variable", "parameter", "formal_parameter"].includes(symbol.kind)
          )
            continue;
          definitions.push(symbol);
          if (
            imports.some(
              (i) =>
                i.path === `${result.packageName}.${symbol.name}` ||
                i.path === `${result.packageName}.*`,
            )
          )
            imported.push(symbol);
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
    if (imported.length && !memberAccess)
      return {
        word,
        candidates: imported,
        confidence: imported.length === 1 ? "import" : "candidate",
      };
    return {
      word,
      candidates: [...locals, ...definitions].slice(0, 30),
      confidence: definitions.length || locals.length ? "candidate" : "none",
      note: memberAccess
        ? "Member types require deep analysis; these are matching declarations."
        : candidates.length > 24
          ? "Search limited to 24 candidate files. Use deep analysis for complete resolution."
          : undefined,
    };
  }
  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const p of this.pending.values()) p.reject(new Error("Disposed"));
    this.pending.clear();
    this.cache.clear();
    this.answers.clear();
    this.bytes = 0;
  }
}
