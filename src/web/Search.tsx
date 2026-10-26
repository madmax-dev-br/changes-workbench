import React, { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { SearchHit, SearchResult, SearchTab } from "../shared";
import { request } from "./rpc";

const tabs: { id: SearchTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "classes", label: "Classes" },
  { id: "files", label: "Files" },
  { id: "symbols", label: "Symbols" },
  { id: "actions", label: "Actions" },
  { id: "text", label: "Text" },
];
const groups: Record<SearchHit["kind"], string> = {
  class: "Classes",
  file: "Files",
  symbol: "Symbols",
  action: "Actions",
  text: "Text",
};
/** IntelliJ's one-letter node icons. */
const badge = (hit: SearchHit) => {
  if (hit.kind === "file") return { letter: "", kind: "file" };
  if (hit.kind === "action") return { letter: "", kind: "action" };
  if (hit.kind === "text") return { letter: "", kind: "text" };
  const letters: Record<string, string> = {
    class: "C",
    interface: "I",
    object: "O",
    enum: "E",
    record: "R",
    struct: "S",
    protocol: "I",
    trait: "T",
    typealias: "T",
    type: "T",
    extension: "X",
    mixin: "M",
    method: "m",
  };
  const letter = letters[hit.keyword ?? ""];
  return {
    letter: letter ?? "f",
    kind: letter && letter !== "m" ? "type" : "function",
  };
};
function Badge({ hit }: { hit: SearchHit }) {
  const { letter, kind } = badge(hit);
  return (
    <span className={`cw-search-badge ${kind}`} aria-hidden>
      {letter}
    </span>
  );
}
/** A text hit's line with its matches marked, without the indentation. */
function Line({ hit }: { hit: SearchHit }) {
  const indent = hit.name.length - hit.name.trimStart().length;
  const text = hit.name.slice(indent);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of hit.ranges ?? []) {
    const s = Math.max(start - indent, at),
      e = Math.max(end - indent, s);
    if (s > at) parts.push(text.slice(at, s));
    parts.push(<mark key={s}>{text.slice(s, e)}</mark>);
    at = e;
  }
  parts.push(text.slice(at));
  return <span className="cw-search-line">{parts}</span>;
}
/** Run `load` after `delay` ms once `key` stops changing, cancelling the previous run. */
function useDebounced<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
  delay: number,
) {
  const [state, setState] = useState<{
    result?: T;
    error?: string;
    loading: boolean;
  }>({ loading: false });
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      load(controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setState({ result, loading: false });
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setState({
              error: e instanceof Error ? e.message : String(e),
              loading: false,
            });
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  return state;
}
/** ↑/↓ move the selection; the selected row stays in view. */
function useSelection(count: number, reset: unknown) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [reset]);
  useEffect(() => {
    list.current
      ?.querySelector(".cw-search-row.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [active, reset]);
  const move = (delta: number) =>
    count && setActive((a) => Math.min(count - 1, Math.max(0, a + delta)));
  return {
    active: Math.min(active, Math.max(count - 1, 0)),
    setActive,
    move,
    list,
  };
}

interface PopupProps {
  initial: string;
  onOpen: (hit: SearchHit) => void;
  onClose: () => void;
}
/** IntelliJ's Search Everywhere (Shift Shift): classes, files, symbols, actions and text. */
export function SearchEverywhere({
  initial,
  initialTab = "all",
  onOpen,
  onClose,
}: PopupProps & { initialTab?: SearchTab }) {
  const [tab, setTab] = useState<SearchTab>(initialTab);
  const [query, setQuery] = useState(initial);
  const { result, error, loading } = useDebounced(
    (signal) =>
      request<SearchResult>(
        "searchEverywhere",
        { query, tab },
        undefined,
        signal,
      ),
    JSON.stringify([query, tab]),
    query ? 90 : 0,
  );
  const hits = query.trim() ? (result?.hits ?? []) : [];
  const { active, setActive, move, list } = useSelection(hits.length, result);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "Tab") {
      const i = tabs.findIndex((t) => t.id === tab);
      setTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
    } else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(10);
    else if (e.key === "PageUp") move(-10);
    else if (e.key === "Enter" && hits[active]) onOpen(hits[active]);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className="cw-search-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="cw-search everywhere"
        role="dialog"
        aria-label="Search Everywhere"
      >
        <div className="cw-search-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === tab}
              className={t.id === tab ? "on" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <span className="cw-search-hint">Tab to switch</span>
        </div>
        <div className="cw-search-field">
          <span className="cw-search-glass" aria-hidden />
          <input
            autoFocus
            aria-label="Search Everywhere"
            value={query}
            placeholder={
              tab === "text"
                ? "Search text in files"
                : "Type to search classes, files, symbols and actions"
            }
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={key}
          />
          {loading && <span className="cw-search-spinner" />}
        </div>
        <div className="cw-search-results" role="listbox" ref={list}>
          {hits.map((hit, i) => (
            <React.Fragment
              key={`${hit.kind}:${hit.path}:${hit.line}:${hit.column}:${hit.command}:${i}`}
            >
              {tab === "all" && (i === 0 || hits[i - 1].kind !== hit.kind) && (
                <div className="cw-search-group">{groups[hit.kind]}</div>
              )}
              <div
                role="option"
                aria-selected={i === active}
                className={`cw-search-row ${i === active ? "active" : ""}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => onOpen(hit)}
              >
                <Badge hit={hit} />
                {hit.kind === "text" ? (
                  <Line hit={hit} />
                ) : (
                  <span className="cw-search-name">{hit.name}</span>
                )}
                <span className="cw-search-detail">{hit.detail}</span>
              </div>
            </React.Fragment>
          ))}
          {query.trim() && !loading && !hits.length && (
            <div className="cw-search-empty">{error ?? "Nothing found"}</div>
          )}
        </div>
        <div className="cw-search-footer">
          ↑↓ to navigate · Enter to open · Esc to close
        </div>
      </div>
    </div>
  );
}

interface TextOptions {
  matchCase: boolean;
  words: boolean;
  regex: boolean;
}
/** IntelliJ's Find in Files (⌘⇧F / Ctrl+Shift+F): matches with a preview of the file below. */
export function FindInFiles({
  initial,
  theme,
  onOpen,
  onClose,
}: PopupProps & { theme: string }) {
  const [query, setQuery] = useState(initial);
  const [options, setOptions] = useState<TextOptions>({
    matchCase: false,
    words: false,
    regex: false,
  });
  const [mask, setMask] = useState("");
  const { result, error, loading } = useDebounced(
    (signal) =>
      request<SearchResult>(
        "findInFiles",
        { query, ...options, mask },
        undefined,
        signal,
      ),
    JSON.stringify([query, options, mask]),
    query ? 150 : 0,
  );
  const hits = query ? (result?.hits ?? []) : [];
  const { active, setActive, move, list } = useSelection(hits.length, result);
  const hit = hits[active];
  const preview = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(
    undefined,
  );
  const marks = useRef<monaco.editor.IEditorDecorationsCollection | undefined>(
    undefined,
  );
  const texts = useRef(
    new Map<string, Promise<{ text: string; language: string }>>(),
  );
  useEffect(() => {
    const e = monaco.editor.create(preview.current!, {
      readOnly: true,
      domReadOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineNumbersMinChars: 4,
      automaticLayout: true,
      theme: `changes-${theme}`,
      renderLineHighlight: "none",
      contextmenu: false,
      folding: false,
      glyphMargin: false,
      overviewRulerLanes: 0,
    });
    editor.current = e;
    marks.current = e.createDecorationsCollection();
    return () => {
      e.getModel()?.dispose();
      e.dispose();
    };
  }, []);
  useEffect(() => {
    const e = editor.current;
    if (!e) return;
    if (!hit?.path) {
      e.getModel()?.dispose();
      e.setModel(null);
      return;
    }
    let cancelled = false;
    let load = texts.current.get(hit.path);
    if (!load) {
      load = request("searchPreview", { path: hit.path });
      texts.current.set(hit.path, load);
      load.catch(() => texts.current.delete(hit.path!));
    }
    load
      .then(({ text, language }) => {
        if (cancelled) return;
        const uri = monaco.Uri.from({
          scheme: "cw-preview",
          path: `/${hit.path}`,
        });
        if (e.getModel()?.uri.toString() !== uri.toString()) {
          e.getModel()?.dispose();
          e.setModel(monaco.editor.createModel(text, language, uri));
        }
        marks.current!.set(
          hits
            .filter((h) => h.path === hit.path)
            .flatMap((h) =>
              (h.ranges ?? []).map((r) => ({
                range: new monaco.Range(
                  h.line + 1,
                  r[0] + 1,
                  h.line + 1,
                  r[1] + 1,
                ),
                options: {
                  inlineClassName:
                    h === hit ? "cw-find-current" : "cw-find-match",
                },
              })),
            ),
        );
        e.revealLineInCenter(hit.line + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hit, result]);
  const toggle = (name: keyof TextOptions) =>
    setOptions((o) => ({ ...o, [name]: !o[name] }));
  const key = (e: React.KeyboardEvent) => {
    // IntelliJ: ⌥C match case, ⌥W words, ⌥X regex.
    const option = e.altKey && !e.metaKey && !e.ctrlKey && e.code;
    if (e.key === "Escape") onClose();
    else if (option === "KeyC") toggle("matchCase");
    else if (option === "KeyW") toggle("words");
    else if (option === "KeyX") toggle("regex");
    else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(10);
    else if (e.key === "PageUp") move(-10);
    else if (e.key === "Enter" && hit) onOpen(hit);
    else return;
    e.preventDefault();
  };
  const files = new Set(hits.map((h) => h.path)).size;
  const fileName = (p = "") => p.slice(p.lastIndexOf("/") + 1);
  return (
    <div
      className="cw-search-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="cw-search find-in-files"
        role="dialog"
        aria-label="Find in Files"
        onKeyDown={key}
      >
        <div className="cw-search-title">
          <strong>Find in Files</strong>
          <span className="cw-search-count">
            {error ??
              (query && !loading
                ? `${hits.length}${result?.truncated ? "+" : ""} ${hits.length === 1 ? "match" : "matches"} in ${files} ${files === 1 ? "file" : "files"}`
                : "")}
          </span>
          <label className="cw-search-mask">
            File mask
            <input
              aria-label="File mask"
              value={mask}
              placeholder="*.kt, *.java"
              spellCheck={false}
              onChange={(e) => setMask(e.target.value)}
            />
          </label>
        </div>
        <div className="cw-search-field">
          <span className="cw-search-glass" aria-hidden />
          <input
            autoFocus
            aria-label="Text to find"
            value={query}
            placeholder="Text to find"
            spellCheck={false}
            className={error ? "invalid" : ""}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && <span className="cw-search-spinner" />}
          {(
            [
              ["matchCase", "Aa", "Match case (⌥C)"],
              ["words", "W", "Words (⌥W)"],
              ["regex", ".*", "Regex (⌥X)"],
            ] as const
          ).map(([name, label, title]) => (
            <button
              key={name}
              className={`cw-find-toggle ${options[name] ? "on" : ""}`}
              aria-label={title.replace(/ \(.*\)$/, "")}
              aria-pressed={options[name]}
              title={title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(name)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="cw-search-results" role="listbox" ref={list}>
          {hits.map((h, i) => (
            <div
              key={`${h.path}:${h.line}:${i}`}
              role="option"
              aria-selected={i === active}
              className={`cw-search-row ${i === active ? "active" : ""}`}
              onClick={() => setActive(i)}
              onDoubleClick={() => onOpen(h)}
              title={h.path}
            >
              <Line hit={h} />
              <span className="cw-search-detail">
                {fileName(h.path)} {h.line + 1}
              </span>
            </div>
          ))}
          {query && !loading && !hits.length && !error && (
            <div className="cw-search-empty">Nothing found</div>
          )}
        </div>
        <div className="cw-search-preview-title">
          {hit?.path ? `${hit.path}:${hit.line + 1}` : ""}
        </div>
        <div className="cw-search-preview" ref={preview} />
        <div className="cw-search-footer">
          ↑↓ to navigate · Enter to open in editor · Esc to close
        </div>
      </div>
    </div>
  );
}
