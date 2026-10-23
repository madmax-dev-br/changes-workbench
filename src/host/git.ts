import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { run, Queue, type RunOptions } from "./process";
import {
  languageOf,
  type Change,
  type Scope,
  type Snapshot,
  type BlameLine,
} from "../shared";
export type Buffers = Map<string, { text: string; version: number }>;
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const queue = new Queue(2);
export function inside(root: string, file: string) {
  const rel = path.relative(root, file);
  return (
    rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
  );
}
export function parseStatus(data: Buffer): Change[] {
  const fields = data.toString("utf8").split("\0");
  const result: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i];
    if (!line) continue;
    if (line.startsWith("? ")) {
      result.push({
        path: line.slice(2),
        index: ".",
        worktree: "?",
        status: "?",
        dirty: false,
      });
      continue;
    }
    const kind = line[0];
    if (!["1", "2", "u"].includes(kind)) continue;
    const count = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    let cursor = 0;
    const parts: string[] = [];
    for (let j = 0; j < count; j++) {
      const end = line.indexOf(" ", cursor);
      parts.push(line.slice(cursor, end));
      cursor = end + 1;
    }
    const file = line.slice(cursor);
    const xy = parts[1];
    const oldPath = kind === "2" ? fields[++i] : undefined;
    const status =
      kind === "u"
        ? "U"
        : xy.includes("R")
          ? "R"
          : xy.includes("D")
            ? "D"
            : xy.includes("A")
              ? "A"
              : "M";
    result.push({
      path: file,
      oldPath,
      index: xy[0],
      worktree: xy[1],
      status,
      dirty: false,
    });
  }
  return result;
}
export class GitService {
  constructor(
    public root: string,
    private getBuffers: () => Buffers = () => new Map(),
  ) {}
  git(args: string[], options: RunOptions = {}) {
    return queue.use(() =>
      run(
        "git",
        ["--no-optional-locks", "--literal-pathspecs", ...args],
        this.root,
        {
          ...options,
          env: {
            LC_ALL: "C",
            GIT_TERMINAL_PROMPT: "0",
            GIT_PAGER: "cat",
            ...options.env,
          },
        },
      ),
    );
  }
  async head() {
    try {
      return (await this.git(["rev-parse", "--verify", "HEAD"]))
        .toString()
        .trim();
    } catch {
      return "";
    }
  }
  async branch() {
    try {
      return (await this.git(["symbolic-ref", "--short", "HEAD"]))
        .toString()
        .trim();
    } catch {
      return (await this.head()).slice(0, 8) || "No commits";
    }
  }
  validate(file: string) {
    if (
      !file ||
      file.includes("\0") ||
      path.isAbsolute(file) ||
      !inside(this.root, path.resolve(this.root, file))
    )
      throw new Error("File is outside the repository");
    return file;
  }
  async changes(scope: Scope = "all", signal?: AbortSignal): Promise<Change[]> {
    const list = parseStatus(
      await this.git(
        ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        { signal },
      ),
    );
    const map = new Map(list.map((c) => [c.path, c]));
    for (const [file] of this.getBuffers())
      if (inside(this.root, file)) {
        const relative = path
          .relative(this.root, file)
          .split(path.sep)
          .join("/");
        const existing = map.get(relative);
        if (existing) {
          existing.dirty = true;
          if (existing.worktree === ".") existing.worktree = "M";
        } else
          map.set(relative, {
            path: relative,
            index: ".",
            worktree: "M",
            status: "M",
            dirty: true,
          });
      }
    return [...map.values()]
      .filter(
        (c) =>
          scope === "all" ||
          (scope === "staged"
            ? c.index !== "."
            : c.worktree !== "." || c.dirty),
      )
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  async blob(ref: string, file: string, signal?: AbortSignal): Promise<Buffer> {
    this.validate(file);
    if (!ref) return Buffer.alloc(0);
    // A missing path is expected for additions/deletions; other Git errors must remain visible.
    try {
      // Read a blob explicitly: revision/path parsing in `show` can fall back
      // to commit output for a missing path on some Git versions.
      return await this.git(["cat-file", "blob", `${ref}:${file}`], {
        signal,
        maxBytes: 12 * 1024 * 1024,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = String(error);
      if (
        /does not exist|exists on disk, but not in|does not exist in|unknown revision|invalid object name|Not a valid object name|bad revision|not in the index/.test(
          message,
        )
      )
        return Buffer.alloc(0);
      throw error;
    }
  }
  async snapshot(
    file: string,
    scope: Scope = "all",
    signal?: AbortSignal,
    known?: Change,
  ): Promise<Snapshot> {
    this.validate(file);
    const change =
      known ?? (await this.changes("all", signal)).find((c) => c.path === file);
    const head = await this.head();
    const oldPath = scope === "unstaged" ? file : (change?.oldPath ?? file);
    const conflicted = change?.status === "U";
    const originalRef = scope === "unstaged" && !conflicted ? ":" : head;
    const original = await this.blob(
      originalRef === ":" ? "" : originalRef,
      oldPath,
      signal,
    );
    let base = original;
    if (scope === "unstaged" && !conflicted)
      base = await this.blobIndex(file, signal);
    let current: Buffer;
    let tooLarge = false;
    if (scope === "staged" && !conflicted)
      current = await this.blobIndex(file, signal);
    else {
      const buffer = this.getBuffers().get(path.resolve(this.root, file));
      if (buffer) current = Buffer.from(buffer.text);
      else
        try {
          const stat = await fs.lstat(path.join(this.root, file));
          if (stat.isSymbolicLink())
            current = Buffer.from(
              await fs.readlink(path.join(this.root, file)),
            );
          else if (stat.size > 5 * 1024 * 1024) {
            current = Buffer.alloc(0);
            tooLarge = true;
          } else current = await fs.readFile(path.join(this.root, file));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            current = Buffer.alloc(0);
          else throw error;
        }
    }
    tooLarge =
      tooLarge ||
      base.length > 5 * 1024 * 1024 ||
      current.length > 5 * 1024 * 1024;
    const binary =
      base.subarray(0, 8192).includes(0) ||
      current.subarray(0, 8192).includes(0);
    const originalText = binary || tooLarge ? "" : base.toString("utf8");
    const currentText = binary || tooLarge ? "" : current.toString("utf8");
    const fingerprint = hash(
      `${head}\0${scope}\0${oldPath}\0${file}\0${change?.index}\0${change?.worktree}\0${base.toString("base64")}\0${current.toString("base64")}`,
    );
    return {
      path: file,
      oldPath,
      original: originalText,
      current: currentText,
      originalRef,
      version: fingerprint,
      fingerprint,
      binary,
      tooLarge,
      scope,
      language: languageOf(file),
      conflicted: change?.status === "U",
    };
  }
  private async blobIndex(file: string, signal?: AbortSignal) {
    this.validate(file);
    try {
      return await this.git(["cat-file", "blob", `:${file}`], {
        signal,
        maxBytes: 12 * 1024 * 1024,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (
        /not in the index|does not exist|Not a valid object name|unmerged/.test(
          String(e),
        )
      )
        return Buffer.alloc(0);
      throw e;
    }
  }
  async blame(
    file: string,
    text: string,
    ref?: string,
    signal?: AbortSignal,
  ): Promise<BlameLine[]> {
    this.validate(file);
    const head = await this.head();
    if (!head) return localBlame(text, file);
    const args = ["blame", "--line-porcelain"];
    if (ref) {
      if (!/^[a-f0-9]{40,64}$/.test(ref)) throw new Error("Invalid revision");
      args.push(ref);
    } else args.push("--contents", "-");
    args.push("--", file);
    try {
      return parseBlame(
        (
          await this.git(args, {
            signal,
            input: ref ? undefined : text,
            timeout: 20000,
          })
        ).toString(),
      );
    } catch (e) {
      if (signal?.aborted) throw e;
      if (/no such path|no such file|does not exist|not in/.test(String(e)))
        return localBlame(text, file);
      throw e;
    }
  }
  async commitSnapshot(sha: string, file: string): Promise<Snapshot> {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Invalid commit");
    this.validate(file);
    const line = (await this.git(["rev-list", "--parents", "-n", "1", sha]))
      .toString()
      .trim()
      .split(" ");
    const original = (await this.blob(line[1] ?? "", file)).toString();
    const current = (await this.blob(sha, file)).toString();
    return {
      path: file,
      oldPath: file,
      original,
      current,
      originalRef: line[1] ?? "",
      version: sha,
      fingerprint: sha,
      binary: original.includes("\0") || current.includes("\0"),
      tooLarge: false,
      language: languageOf(file),
      scope: "all",
      conflicted: false,
    };
  }
}
export function localBlame(text: string, file: string): BlameLine[] {
  return text.split("\n").map((_, i) => ({
    line: i + 1,
    originalLine: i + 1,
    sha: "0".repeat(40),
    author: "You",
    time: 0,
    summary: "Uncommitted changes",
    path: file,
    local: true,
  }));
}
export function parseBlame(data: string): BlameLine[] {
  const result: BlameLine[] = [];
  let item: BlameLine | undefined;
  for (const line of data.split("\n")) {
    const match = /^([a-f0-9]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (match) {
      item = {
        sha: match[1],
        originalLine: +match[2],
        line: +match[3],
        author: "",
        time: 0,
        summary: "",
        path: "",
        local: /^0+$/.test(match[1]),
      };
      continue;
    }
    if (!item) continue;
    if (line.startsWith("author ")) item.author = line.slice(7);
    else if (line.startsWith("author-time ")) item.time = +line.slice(12);
    else if (line.startsWith("summary ")) item.summary = line.slice(8);
    else if (line.startsWith("filename ")) {
      const value = line.slice(9);
      try {
        item.path = value.startsWith('"') ? JSON.parse(value) : value;
      } catch {
        item.path = value;
      }
    } else if (line.startsWith("\t")) {
      if (item.local) {
        item.author = "You";
        item.summary = "Uncommitted changes";
      }
      result.push(item);
      item = undefined;
    }
  }
  return result;
}
