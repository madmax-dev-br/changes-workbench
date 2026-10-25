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
export interface RepoState {
  root: string;
  name: string;
  branch: string;
  head: string;
  changes: Change[];
}
export interface ViewState {
  intellijKeymap: boolean;
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
  | "layout";
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
  event: "state" | "command" | "refresh";
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
