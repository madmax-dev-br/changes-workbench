import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { run } from "./process";
import type { SearchHit, SearchResult, TextQuery } from "../shared";

/** The ripgrep that ships with VS Code and Cursor, else `rg` on PATH. */
export function ripgrep(appRoot: string) {
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  for (const dir of ["node_modules", "node_modules.asar.unpacked"])
    for (const pkg of ["@vscode/ripgrep", "vscode-ripgrep"]) {
      const file = path.join(appRoot, dir, pkg, "bin", exe);
      if (existsSync(file)) return file;
    }
  return "rg";
}

const word = (text: string, i: number) =>
  i === 0 ||
  !/[A-Za-z0-9]/.test(text[i - 1]) ||
  (/[A-Z]/.test(text[i]) && /[a-z0-9]/.test(text[i - 1]));
/**
 * IntelliJ-style matching: exact and prefix matches first, then camel humps (`CaRe` finds
 * `CartRepository`), then substrings. Higher is better; undefined is no match.
 */
export function matchScore(query: string, text: string): number | undefined {
  // Several words (`choose theme`) must each match, in any order.
  const words = query.trim().split(/\s+/);
  if (words.length > 1) {
    let total = 0;
    for (const w of words) {
      const score = matchScore(w, text);
      if (score === undefined) return undefined;
      total += score;
    }
    return total;
  }
  const q = query.replace(/[\s*]/g, "").toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t === q) return 100000 - text.length;
  if (t.startsWith(q)) return 80000 - text.length;
  const humps = query.replace(/[\s*]/g, "");
  let score = 0,
    from = 0,
    previous = -2;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    // An uppercase query letter starts a new hump (`CaRe`), so it skips to a word start.
    const hump = i > 0 && /[A-Z]/.test(humps[i]);
    let found = !hump && t[from] === c && previous === from - 1 ? from : -1;
    if (found < 0)
      for (let j = from; j < t.length; j++)
        if (t[j] === c && word(text, j)) {
          found = j;
          break;
        }
    // Like IntelliJ, letters must continue a word or start one; otherwise only a plain
    // substring matches (`ice` in `PriceCalculator`).
    if (found < 0) {
      const at = t.indexOf(q);
      return at < 0
        ? undefined
        : 20000 + (word(text, at) ? 500 : 0) - text.length;
    }
    score += found === previous + 1 ? 15 : 12;
    if (i === 0 && found === 0) score += 20;
    previous = found;
    from = found + 1;
  }
  return score * 100 + (t.includes(q) ? 20000 : 0) - text.length;
}
/** The best `limit` items by score, then by shorter label. */
export function rank<T>(
  items: Iterable<T>,
  query: string,
  label: (item: T) => string,
  limit: number,
  extra: (item: T) => number = () => 0,
) {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = matchScore(query, label(item));
    if (score !== undefined) scored.push({ item, score: score + extra(item) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}

/** Repository files Git knows or would add (ignored files are left out). */
export async function listFiles(root: string, signal?: AbortSignal) {
  const out = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    root,
    { signal, timeout: 60000, maxBytes: 256 * 1024 * 1024 },
  );
  return [...new Set(out.toString().split("\0").filter(Boolean))];
}
export function searchFiles(files: string[], query: string, limit: number) {
  const byPath = /[\\/]/.test(query);
  return rank(
    files,
    query,
    (f) => (byPath ? f : path.posix.basename(f)),
    limit,
  ).map((f): SearchHit => ({
    kind: "file",
    name: path.posix.basename(f),
    detail: path.posix.dirname(f) === "." ? "" : path.posix.dirname(f),
    path: f,
    line: 0,
    column: 0,
  }));
}

export interface Declaration {
  name: string;
  keyword: string;
  path: string;
  line: number;
  column: number;
  type: boolean;
}
const sources = [
  "kt",
  "kts",
  "java",
  "scala",
  "groovy",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "swift",
  "dart",
  "rs",
  "cs",
  "rb",
  "php",
];
const annotations = String.raw`(?:@[\w.]+(?:\([^)]*\))?\s+)*`;
/** Declarations at the start of a line, so mentions in comments and strings are skipped. */
const declarationPatterns = [
  // Types: Kotlin, Java, Scala, TypeScript, Swift, Rust, C#, Python, Dart…
  String.raw`^\s*${annotations}(?:(?:public|private|protected|internal|open|abstract|sealed|data|final|static|inner|enum|annotation|value|inline|export|default|partial|case|actual|expect|declare|readonly|pub(?:\([^)]*\))?)\s+)*(class|interface|object|enum|record|struct|protocol|trait|typealias|type|extension|mixin)\s+([A-Z]\w*)`,
  // Functions: Kotlin fun, JS function, Python def, Go func, Swift func, Rust fn.
  String.raw`^\s*${annotations}(?:(?:public|private|protected|internal|open|abstract|override|final|static|suspend|inline|operator|infix|tailrec|external|async|export|default|actual|expect|synchronized|native|pub(?:\([^)]*\))?)\s+)*(fun|function\*?|def|func|fn)\b\s*(?:<[^>]*>\s*)?(?:\([^)]*\)\s*)?(?:[\w.]+(?:<[^>]*>)?\??\.)?(\w+)\s*[(<]`,
  // Java and C# methods, which need at least one modifier to tell them from calls.
  String.raw`^\s*${annotations}(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|override|virtual|async)\s+)+(?:<[^>]*>\s*)?[\w.\[\]?]+(?:<[^()]*>)?(?:\[\])?\s+(\w+)\s*\(`,
];
const typeRegex = new RegExp(declarationPatterns[0]);
const functionRegex = new RegExp(declarationPatterns[1]);
const methodRegex = new RegExp(declarationPatterns[2]);
/** Parse one `path\0line:column:text` line of `rg --null --line-number --column -o`. */
export function parseDeclaration(record: string): Declaration | undefined {
  const nul = record.indexOf("\0");
  if (nul < 0) return;
  const file = record.slice(0, nul);
  const rest = /^(\d+):(\d+):(.*)$/.exec(record.slice(nul + 1));
  if (!rest) return;
  const text = rest[3];
  const type = typeRegex.exec(text);
  const fn = type ? null : (functionRegex.exec(text) ?? methodRegex.exec(text));
  const match = type ?? fn;
  if (!match) return;
  const name = match[2] ?? match[1];
  if (!name || name === "constructor") return;
  const end = match.index + match[0].length;
  const column = Math.max(text.lastIndexOf(name, end), 0);
  return {
    name,
    keyword: match[2] ? match[1] : "method",
    path: file.replace(/\\/g, "/").replace(/^\.\//, ""),
    line: Number(rest[1]) - 1,
    column: Number(rest[2]) - 1 + column,
    type: Boolean(type),
  };
}
/** Classes and functions of the repository's source files, found with one ripgrep pass. */
export async function scanDeclarations(
  rg: string,
  root: string,
  signal?: AbortSignal,
) {
  const out = await run(
    rg,
    [
      "--null",
      "--line-number",
      "--column",
      "--only-matching",
      "--no-messages",
      "--max-filesize",
      "1M",
      ...sources.flatMap((ext) => ["-g", `*.${ext}`]),
      ...declarationPatterns.flatMap((p) => ["-e", p]),
      "./",
    ],
    root,
    { signal, timeout: 120000, maxBytes: 512 * 1024 * 1024 },
  ).catch((e: Error) => {
    // Exit code 1 only means nothing matched.
    if (/exited 1$/.test(e.message)) return Buffer.alloc(0);
    throw e;
  });
  const result: Declaration[] = [];
  for (const record of out.toString().split("\n")) {
    const d = parseDeclaration(record);
    if (d) result.push(d);
  }
  return result;
}
export function searchDeclarations(
  declarations: Declaration[],
  query: string,
  types: boolean,
  limit: number,
) {
  return rank(
    declarations.filter((d) => !types || d.type),
    query,
    (d) => d.name,
    limit,
    // Types before functions of the same name, as in IntelliJ's Symbols tab.
    (d) => (d.type ? 1 : 0),
  ).map((d): SearchHit => ({
    kind: types ? "class" : "symbol",
    name: d.name,
    detail: `${d.path}:${d.line + 1}`,
    path: d.path,
    line: d.line,
    column: d.column,
    keyword: d.keyword,
  }));
}

/** Byte offsets from ripgrep's JSON to string indexes. */
const charIndex = (text: string, bytes: number) =>
  Buffer.from(text).subarray(0, bytes).toString().length;
/** Find in Files with ripgrep: case-insensitive by default, like IntelliJ. */
export function searchText(
  rg: string,
  root: string,
  query: TextQuery,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const masks = query.mask
    .split(/[,;]/)
    .map((m) => m.trim())
    .filter(Boolean);
  const args = [
    "--json",
    "--no-messages",
    "--max-filesize",
    "4M",
    "--max-columns",
    "1000",
    query.matchCase ? "--case-sensitive" : "--ignore-case",
    ...(query.words ? ["--word-regexp"] : []),
    ...(query.regex ? [] : ["--fixed-strings"]),
    ...masks.flatMap((m) => ["-g", m]),
    "-e",
    query.query,
    "./",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { cwd: root, windowsHide: true });
    const hits: SearchHit[] = [];
    let buffered = "",
      errors = "",
      truncated = false,
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve({ hits, truncated });
    };
    const abort = () => {
      child.kill();
      finish(new Error("Cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    const line = (json: string) => {
      if (!json.startsWith('{"type":"match"')) return;
      const data = JSON.parse(json).data;
      const file = data.path?.text;
      const text: string | undefined = data.lines?.text;
      if (!file || text === undefined) return;
      const lineText = text.replace(/\r?\n$/, "");
      const ranges = (data.submatches as { start: number; end: number }[]).map(
        (m): [number, number] => [
          charIndex(lineText, m.start),
          charIndex(lineText, m.end),
        ],
      );
      const relative = file.replace(/\\/g, "/").replace(/^\.\//, "");
      hits.push({
        kind: "text",
        name: lineText,
        detail: `${relative}:${data.line_number}`,
        path: relative,
        line: data.line_number - 1,
        column: ranges[0]?.[0] ?? 0,
        ranges,
      });
      if (hits.length >= limit) {
        truncated = true;
        child.kill();
        finish();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const l of lines) if (!done) line(l);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 4096) errors += chunk.toString();
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      if (buffered && !done) line(buffered);
      // 1: no match. 2: some files could not be read, or the pattern is invalid.
      if (code === 2 && !hits.length && errors.trim())
        finish(new Error(errors.trim().replace(/\s+/g, " ").slice(0, 300)));
      else finish();
    });
  });
}
