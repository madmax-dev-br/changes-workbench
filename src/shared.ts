export type Scope = "all" | "staged" | "unstaged";
export type Mode = "light" | "deep";
export interface Change {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
  status: "M" | "A" | "D" | "R" | "U" | "?";
  dirty: boolean;
  reviewed?: boolean;
  /** A submodule's recorded commit (`Subproject commit …`), not a file. */
  submodule?: boolean;
}
export interface Snapshot {
  path: string;
  oldPath: string;
  original: string;
  current: string;
  originalRef: string;
  version: string;
  fingerprint: string;
  binary: boolean;
  tooLarge: boolean;
  language: string;
  scope: Scope;
  conflicted: boolean;
}
export interface BlameLine {
  line: number;
  originalLine: number;
  sha: string;
  author: string;
  time: number;
  summary: string;
  path: string;
  local: boolean;
}
export interface SymbolInfo {
  name: string;
  kind: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  start: number;
  end: number;
  scopeStart: number;
  scopeEnd: number;
  signature: string;
  documentation: string;
  preview?: string;
}
export interface ParsedFile {
  path: string;
  packageName: string;
  imports: { path: string; alias?: string }[];
  symbols: SymbolInfo[];
  errors: boolean;
}
export interface Navigation {
  word: string;
  candidates: SymbolInfo[];
  confidence: "local" | "import" | "candidate" | "deep" | "none";
  note?: string;
}
/** A Search Everywhere or Find in Files result; lines and columns are 0-based. */
export interface SearchHit {
  kind: "class" | "file" | "symbol" | "action" | "text";
  /** Class, file or symbol name, action title, or the matching line for text. */
  name: string;
  /** Folder, file and line, or action category. */
  detail: string;
  /** Repository-relative path. */
  path?: string;
  line: number;
  column: number;
  /** Declaration keyword such as `class`, `object` or `fun`. */
  keyword?: string;
  /** Text hits: matched ranges within `name`. */
  ranges?: [number, number][];
  /** Actions: the command to run. */
  command?: string;
}
export type SearchTab =
  "all" | "classes" | "files" | "symbols" | "actions" | "text";
export interface TextQuery {
  query: string;
  matchCase: boolean;
  words: boolean;
  regex: boolean;
  /** Comma-separated file masks such as `*.kt, *.java`. */
  mask: string;
}
export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}
export interface RepoState {
  root: string;
  name: string;
  branch: string;
  head: string;
  changes: Change[];
  /** Paths of the initialized submodules, nested ones included; their changes are listed below them. */
  submodules: string[];
}
/** A shared IntelliJ run configuration, as the panel shows it. */
export interface RunInfo {
  name: string;
  type: string;
  /** The command line that runs, or why it cannot run outside IntelliJ. */
  detail: string;
  runnable: boolean;
  running: boolean;
  /** The command Build runs, when the configuration can be compiled on its own. */
  build?: string;
  /** Android apps: the module's build variants (empty until Gradle has listed them). */
  variants?: string[];
  variant?: string;
  loadingVariants?: boolean;
}
export interface ViewState {
  intellijKeymap: boolean;
  runs: RunInfo[];
  selectedRun?: string;
  repos: { root: string; name: string }[];
  repo: RepoState;
  scope: Scope;
  mode: Mode;
  deepStatus: string;
  layout: "sideBySide" | "unified";
  error?: string;
}
export type RequestMethod =
  | "refresh"
  | "selectRepo"
  | "scope"
  | "snapshot"
  | "blame"
  | "navigate"
  | "openLocation"
  | "review"
  | "openCommit"
  | "deep"
  | "chooseTheme"
  | "configureDeep"
  | "layout"
  | "rollback"
  | "run"
  | "stopRun"
  | "build"
  | "attachDebugger"
  | "selectRun"
  | "selectVariant"
  | "reloadVariants"
  | "searchEverywhere"
  | "findInFiles"
  | "searchPreview"
  | "runAction";
export interface RequestMessage {
  type: "request";
  id: number;
  method: RequestMethod;
  params: Record<string, unknown>;
  version?: string;
}
export interface CancelMessage {
  type: "cancel";
  id: number;
}
export interface ResponseMessage {
  type: "response";
  id: number;
  result?: unknown;
  error?: string;
  version?: string;
}
export interface EventMessage {
  type: "event";
  event: "state" | "command" | "refresh" | "status" | "runs";
  data: unknown;
}
/** A definition location for display: relative to the repository when it lies inside it. */
export function displayPath(location: string, root = "") {
  let file = location;
  if (/^file:\/\//i.test(location))
    try {
      file = decodeURIComponent(new URL(location).pathname).replace(
        /^\/([A-Za-z]:)/,
        "$1",
      );
    } catch {}
  file = file.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/$/, "");
  return base && file.startsWith(`${base}/`)
    ? file.slice(base.length + 1)
    : file;
}
export const languageOf = (path: string) =>
  path.endsWith(".kt") || path.endsWith(".kts")
    ? "kotlin"
    : path.endsWith(".java")
      ? "java"
      : path.endsWith(".json")
        ? "json"
        : path.endsWith(".xml")
          ? "xml"
          : /\.[cm]?[jt]sx?$/.test(path)
            ? "typescript"
            : "plaintext";
/** One diff hunk in Monaco's line-change form: an end line of 0 marks a pure insertion or deletion. */
export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}
/** The current text with one hunk rolled back to the original, as IntelliJ's gutter Rollback does. */
export function revertChange(
  current: string,
  original: string,
  change: LineChange,
) {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  const base = original.split(/\r?\n/);
  const {
    originalStartLineNumber: oStart,
    originalEndLineNumber: oEnd,
    modifiedStartLineNumber: mStart,
    modifiedEndLineNumber: mEnd,
  } = change;
  const valid = (n: number) => Number.isInteger(n) && n >= 0;
  if (
    ![oStart, oEnd, mStart, mEnd].every(valid) ||
    (oEnd && (oStart < 1 || oEnd < oStart || oEnd > base.length)) ||
    (mEnd && (mStart < 1 || mEnd < mStart || mEnd > lines.length)) ||
    (!mEnd && mStart > lines.length) ||
    (!oEnd && !mEnd)
  )
    throw new Error("This change no longer matches the file; refresh the view");
  const restored = oEnd ? base.slice(oStart - 1, oEnd) : [];
  // A deletion (mEnd 0) re-inserts the lines after mStart; otherwise the hunk is replaced.
  lines.splice(
    mEnd ? mStart - 1 : mStart,
    mEnd ? mEnd - mStart + 1 : 0,
    ...restored,
  );
  return lines.join(eol);
}
