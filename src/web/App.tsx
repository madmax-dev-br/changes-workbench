import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import type {
  ViewState,
  Snapshot,
  Change,
  Scope,
  BlameLine,
  Navigation,
  RunInfo,
  SearchHit,
} from "../shared";
import { displayPath } from "../shared";
import { Diff, type DiffHandle } from "./Diff";
import { FindInFiles, SearchEverywhere } from "./Search";
import { request, vscode } from "./rpc";
import type { editor } from "monaco-editor";
import palettes from "../palettes.json";
const detectTheme = () =>
  /darcula/i.test(
    document.body.dataset.vscodeThemeId ??
      document.body.dataset.vscodeThemeName ??
      "",
  )
    ? "darcula"
    : document.body.classList.contains("vscode-light")
      ? "light"
      : "dark";
type IconName =
  | "branch"
  | "search"
  | "check"
  | "close"
  | "refresh"
  | "arrow"
  | "code"
  | "file"
  | "folder"
  | "history"
  | "bolt"
  | "split"
  | "external"
  | "chevron"
  | "play"
  | "stop"
  | "rerun"
  | "build"
  | "attach";
const shapes: Record<IconName, React.ReactNode> = {
  branch: (
    <>
      <circle cx="6" cy="4" r="2" />
      <circle cx="6" cy="20" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M6 6v12M18 8c0 6-12 2-12 8" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 6a8 8 0 0 1 13 4M18 18A8 8 0 0 1 5 14" />
    </>
  ),
  arrow: <path d="m9 5 7 7-7 7" />,
  code: (
    <>
      <path d="m8 6-6 6 6 6M16 6l6 6-6 6m-3-17-2 22" />
    </>
  ),
  file: (
    <>
      <path d="M6 2h8l4 4v16H6zM14 2v5h4" />
      <path d="M9 12h6m-6 4h6" />
    </>
  ),
  folder: <path d="M2 6h8l2 2h10v12H2z" />,
  history: (
    <>
      <path d="M3 3v6h6" />
      <path d="M3 9a9 9 0 1 1 0 7M12 7v6l4 2" />
    </>
  ),
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7z" />,
  split: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7m0-7L10 14" />
      <path d="M10 3H3v18h18v-7" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" />,
  stop: (
    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
  ),
  rerun: (
    <>
      <path d="M19 12a7 7 0 1 1-2.1-5" />
      <path d="M17.5 2.5v4.5H13" />
    </>
  ),
  attach: (
    <>
      <path d="M9 9.5a3 3 0 0 1 6 0V15a3 3 0 0 1-6 0z" />
      <path d="M12 12v4M6.5 10.5H9M6.5 15H9M15 15h2M10 6.5 8.5 5M14 6.5 15.5 5" />
      <path d="M17 8.5h4.5M19.5 6.5l2 2-2 2" />
    </>
  ),
  build: (
    <>
      <path d="M12.5 4.5 15 2l7 7-2.5 2.5z" />
      <path d="m14 8-10.3 10.3a1.6 1.6 0 0 0 2.3 2.3L16.3 10.3" />
    </>
  ),
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  );
}
const labels: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  U: "Conflict",
  "?": "Untracked",
};
function Action({
  label,
  icon,
  onClick,
  active = false,
  children,
  disabled = false,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  active?: boolean;
  children?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className={`action ${active ? "active" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} />
      {children}
    </button>
  );
}
export default function App() {
  const persisted = useRef(vscode.getState() ?? {});
  const [state, setState] = useState<ViewState>();
  const [selected, setSelected] = useState<string>(
    persisted.current.selected ?? "",
  );
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [scope, setScope] = useState<Scope>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [unified, setUnified] = useState(false);
  const [blame, setBlame] = useState<BlameLine[]>([]);
  const [showBlame, setShowBlame] = useState<boolean>(
    persisted.current.showBlame ?? false,
  );
  const [position, setPosition] = useState({ line: 0, column: 0 });
  const [navigation, setNavigation] = useState<Navigation>();
  const [sidebar, setSidebar] = useState(persisted.current.sidebar ?? 290);
  const [theme, setTheme] = useState(detectTheme());
  const diff = useRef<DiffHandle>(null);
  const [popup, setPopup] = useState<{
    mode: "everywhere" | "find";
    initial: string;
  }>();
  const openSearch = (mode: "everywhere" | "find") =>
    setPopup((s) =>
      s?.mode === mode ? s : { mode, initial: diff.current?.selection() ?? "" },
    );
  const closeSearch = () => {
    setPopup(undefined);
    diff.current?.focus();
  };
  // IntelliJ's Search Everywhere: press Shift twice.
  useEffect(() => {
    let last = -1000;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || e.ctrlKey || e.metaKey || e.altKey) {
        last = -1000;
        return;
      }
      if (e.repeat) return;
      if (e.timeStamp - last < 400) {
        last = -1000;
        openSearch("everywhere");
      } else last = e.timeStamp;
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);
  const viewStates = useRef(
    new Map<string, editor.IDiffEditorViewState>(
      Object.entries(persisted.current.viewStates ?? {}),
    ),
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const refreshCounter = useRef(0);
  const [refreshId, setRefreshId] = useState(0);
  const report = useCallback(
    (message: string) => setError(message.replace(/^Error: /, "")),
    [],
  );
  const perform = useCallback(
    (
      method: Parameters<typeof request>[0],
      params: Record<string, unknown> = {},
      version?: string,
    ) => {
      setError("");
      if (method === "scope" || method === "selectRepo") {
        setLoading(true);
        setSnapshot(undefined);
        snapshotRef.current = undefined;
      }
      return request(method, params, version).catch((e) => {
        report(String(e));
      });
    },
    [report],
  );
  const changes = state?.repo.changes ?? [];
  const filtered = useMemo(
    () =>
      changes.filter(
        (c) =>
          c.path.toLowerCase().includes(search.toLowerCase()) &&
          (filter === "all" || filter === "pending"
            ? !c.reviewed || filter === "all"
            : c.status === filter),
      ),
    [changes, search, filter],
  );
  const selectedChange = changes.find((c) => c.path === selected);
  const reviewed = changes.filter((c) => c.reviewed).length;
  const switchFile = (direction: number) => {
    if (!filtered.length) return;
    const index = filtered.findIndex((c) => c.path === selectedRef.current);
    setSelected(
      filtered[(index + direction + filtered.length) % filtered.length].path,
    );
  };
  const mark = () => {
    const snap = snapshotRef.current;
    if (snap) void perform("review", { path: snap.path }, snap.version);
  };
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type !== "event") return;
      if (m.event === "state") {
        if (m.data?.error) {
          report(m.data.error);
          return;
        }
        const next = m.data as ViewState;
        if (!next?.repo) return;
        setState(next);
        setScope(next.scope);
        setUnified(next.layout === "unified");
        setRefreshId(++refreshCounter.current);
        if (!next.repo.changes.some((c) => c.path === selectedRef.current)) {
          setSelected(next.repo.changes[0]?.path ?? "");
        }
      }
      if (m.event === "refresh") void perform("refresh");
      if (m.event === "runs") {
        const { root, runs, selectedRun } = m.data as Pick<
          ViewState,
          "runs" | "selectedRun"
        > & { root: string };
        setState((s) =>
          s && s.repo.root === root ? { ...s, runs, selectedRun } : s,
        );
      }
      if (m.event === "status") {
        const { root, deepStatus, mode } = m.data as Pick<
          ViewState,
          "deepStatus" | "mode"
        > & { root: string };
        setState((s) =>
          s && s.repo.root === root ? { ...s, deepStatus, mode } : s,
        );
      }
      if (m.event === "command") {
        switch (m.data) {
          case "nextFile":
            document.dispatchEvent(new CustomEvent("cw-file", { detail: 1 }));
            break;
          case "previousFile":
            document.dispatchEvent(new CustomEvent("cw-file", { detail: -1 }));
            break;
          case "nextChange":
            diff.current?.next(1);
            break;
          case "previousChange":
            diff.current?.next(-1);
            break;
          case "definition":
            diff.current?.definitions();
            break;
          case "quickDocumentation":
            diff.current?.documentation();
            break;
          case "openEditor":
            document.dispatchEvent(new CustomEvent("cw-open"));
            break;
          case "toggleBlame":
            setShowBlame((v) => !v);
            break;
          case "toggleReviewed":
            mark();
            break;
          case "searchEverywhere":
            openSearch("everywhere");
            break;
          case "findInFiles":
            openSearch("find");
            break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    void perform("refresh");
    const observer = new MutationObserver(() => setTheme(detectTheme()));
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [
        "class",
        "data-vscode-theme-name",
        "data-vscode-theme-id",
      ],
    });
    return () => {
      window.removeEventListener("message", onMessage);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    const fn = (e: Event) => switchFile((e as CustomEvent).detail);
    document.addEventListener("cw-file", fn);
    return () => document.removeEventListener("cw-file", fn);
  }, [filtered]);
  useEffect(() => {
    vscode.setState({ ...vscode.getState(), selected, sidebar, showBlame });
  }, [selected, sidebar, showBlame]);
  useEffect(() => {
    if (!selected) {
      setSnapshot(undefined);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    if (
      snapshotRef.current?.path !== selected ||
      snapshotRef.current?.scope !== scope
    )
      setSnapshot(undefined);
    setNavigation(undefined);
    setError("");
    request<Snapshot>(
      "snapshot",
      { path: selected },
      undefined,
      controller.signal,
    )
      .then((s) => {
        if (!controller.signal.aborted) {
          setSnapshot((old) => (old?.version === s.version ? old : s));
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          report(String(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [selected, scope, refreshId, state?.repo.root]);
  useEffect(() => {
    setBlame([]);
    if (!snapshot || snapshot.binary || snapshot.tooLarge) return;
    const controller = new AbortController();
    request<BlameLine[]>(
      "blame",
      { path: snapshot.path },
      snapshot.version,
      controller.signal,
    )
      .then(setBlame)
      .catch((e) => {
        if (!controller.signal.aborted) report(String(e));
      });
    return () => controller.abort();
  }, [snapshot?.version]);
  const activeBlame = blame.find((b) => b.line === position.line + 1);
  const openFile = () => {
    if (snapshot)
      void perform("openLocation", {
        path: snapshot.path,
        ...(diff.current?.position() ?? { line: 0, column: 0 }),
      });
  };
  useEffect(() => {
    const open = () => openFile();
    const key = (e: KeyboardEvent) => {
      const mod = /Mac/i.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      // The search popups handle their own keys.
      if (document.querySelector(".cw-search")) return;
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        openSearch("find");
        return;
      }
      // Find bar: ⌘F / Ctrl+F, then F3 or ⌘G / Ctrl+G (with Shift for the previous match).
      if (
        mod &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "f" &&
        snapshot
      ) {
        e.preventDefault();
        e.stopPropagation();
        diff.current?.find();
        return;
      }
      if (
        snapshot &&
        (e.key === "F3" || (mod && !e.altKey && e.key.toLowerCase() === "g"))
      ) {
        e.preventDefault();
        e.stopPropagation();
        diff.current?.findNext(e.shiftKey ? -1 : 1);
        return;
      }
      if (!state?.intellijKeymap) return;
      if (e.key === "F7" && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        diff.current?.next(e.shiftKey ? -1 : 1);
      } else if (e.key === "F4" && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        openFile();
      } else if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.key === "ArrowRight" || e.key === "ArrowLeft")
      ) {
        e.preventDefault();
        e.stopPropagation();
        switchFile(e.key === "ArrowRight" ? 1 : -1);
      } else if (
        (/Mac/i.test(navigator.platform) ? e.metaKey : e.ctrlKey) &&
        e.key.toLowerCase() === "b" &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        diff.current?.definitions();
      } else if (e.key === "Escape") {
        setNavigation(undefined);
        diff.current?.focus();
      }
    };
    document.addEventListener("cw-open", open);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("cw-open", open);
      document.removeEventListener("keydown", key, true);
    };
  }, [snapshot, filtered, state?.intellijKeymap]);
  const openHit = (hit: SearchHit) => {
    setPopup(undefined);
    if (hit.kind === "action")
      void perform("runAction", { command: hit.command });
    else if (hit.path)
      void perform("openLocation", {
        path: hit.path,
        line: hit.line,
        column: hit.column,
      });
  };
  const resize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = event.clientX,
      width = sidebar;
    const target = event.currentTarget;
    const move = (e: Event) =>
      setSidebar(
        Math.min(
          window.innerWidth * 0.5,
          Math.max(210, width + (e as PointerEvent).clientX - start),
        ),
      );
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
  };
  return (
    <main
      className={`workbench ${theme}`}
      style={
        {
          ...Object.fromEntries(
            Object.entries(palettes[theme as keyof typeof palettes]).map(
              ([key, value]) => [`--${key}`, value],
            ),
          ),
          "--sidebar": `${sidebar}px`,
        } as React.CSSProperties
      }
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="code" size={19} />
          </span>
          <strong>CHANGES</strong>
          <span className="brand-sub">WORKBENCH</span>
        </div>
        <div className="repo-picker">
          <Icon name="folder" />
          {state?.repos.length! > 1 ? (
            <select
              aria-label="Repository"
              onChange={(e) =>
                void perform("selectRepo", { root: e.target.value })
              }
              value={state?.repo.root}
            >
              {state?.repos.map((r) => (
                <option key={r.root} value={r.root}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{state?.repo.name ?? "Opening repository"}</span>
          )}
          <span className="branch">
            <Icon name="branch" size={14} />
            {state?.repo.branch ?? "—"}
          </span>
        </div>
        <div className="top-actions">
          <RunWidget
            runs={state?.runs ?? []}
            selected={state?.selectedRun}
            perform={perform}
          />
          <button
            className={`mode ${state?.mode === "deep" ? "deep" : ""}`}
            onClick={() =>
              void perform("deep", { enabled: state?.mode !== "deep" })
            }
            title={state?.deepStatus}
          >
            <span className="status-dot" />
            {state?.mode === "deep" ? "Deep analysis" : "On demand"}
          </button>
          <Action
            label="Refresh changes"
            icon="refresh"
            onClick={() => void perform("refresh")}
          />
        </div>
      </header>
      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-title">
            <h1>
              Local changes <span>{changes.length}</span>
            </h1>
            <span className="tiny">{reviewed} reviewed</span>
          </div>
          <div className="scopes" role="tablist" aria-label="Comparison">
            <button
              role="tab"
              aria-selected={scope === "all"}
              onClick={() => void perform("scope", { scope: "all" })}
            >
              All changes
            </button>
            <button
              role="tab"
              aria-selected={scope === "staged"}
              onClick={() => void perform("scope", { scope: "staged" })}
            >
              Staged
            </button>
            <button
              role="tab"
              aria-selected={scope === "unstaged"}
              onClick={() => void perform("scope", { scope: "unstaged" })}
            >
              Unstaged
            </button>
          </div>
          <label className="search">
            <Icon name="search" size={15} />
            <input
              aria-label="Filter files"
              placeholder="Find a changed file…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <kbd>⌕</kbd>
          </label>
          <div className="tree-header">
            <span>FILES</span>
            <select
              aria-label="Filter status"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="pending">To review</option>
              {Object.entries(labels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <FileTree
            changes={filtered}
            submodules={state?.repo.submodules}
            selected={selected}
            onSelect={setSelected}
          />
          <div className="review-progress">
            <div>
              <span>Review progress</span>
              <strong>
                {reviewed} / {changes.length}
              </strong>
            </div>
            <div className="progress-track">
              <div
                style={{
                  width: `${changes.length ? (reviewed / changes.length) * 100 : 0}%`,
                }}
              />
            </div>
            <p>
              {changes.length === 0
                ? "Your working tree is clean."
                : reviewed === changes.length
                  ? "All changes reviewed."
                  : "Pick a file. Follow the changes."}
            </p>
          </div>
        </aside>
        <div
          className="resizer"
          role="separator"
          aria-label="Resize file tree"
          aria-orientation="vertical"
          onPointerDown={resize}
        />
        <section className="review-area" aria-label="Change review">
          <div className="filebar">
            <div className="file-heading">
              {snapshot ? (
                <>
                  <span
                    className={`file-badge ${selectedChange?.status === "?" ? "A" : (selectedChange?.status ?? "M")}`}
                  >
                    {selectedChange?.status === "?"
                      ? "A"
                      : (selectedChange?.status ?? "M")}
                  </span>
                  <span className="filepath" title={selected}>
                    {selected.split("/").slice(0, -1).join("/")}
                    <strong>
                      {selected.includes("/") ? "/" : ""}
                      {selected.split("/").at(-1)}
                    </strong>
                  </span>
                  {selectedChange?.dirty && (
                    <span className="dirty-badge">unsaved</span>
                  )}
                </>
              ) : (
                <span className="muted">Select a file to begin</span>
              )}
            </div>
            <div className="file-actions">
              <Action
                label="Previous file"
                icon="arrow"
                onClick={() => switchFile(-1)}
                disabled={!filtered.length}
              >
                <span className="sr-only">Previous</span>
              </Action>
              <span className="file-count">
                {Math.max(
                  0,
                  filtered.findIndex((c) => c.path === selected) + 1,
                )}{" "}
                / {filtered.length}
              </span>
              <Action
                label="Next file"
                icon="arrow"
                onClick={() => switchFile(1)}
                disabled={!filtered.length}
              />
              <span className="divider" />
              <Action
                label="Open in editor"
                icon="external"
                onClick={openFile}
                disabled={!snapshot}
              />
            </div>
          </div>
          <div className="diff-toolbar">
            <div className="comparison-label">
              <span>{scope === "unstaged" ? "INDEX" : "HEAD"}</span>
              <Icon name="arrow" size={12} />
              <span>{scope === "staged" ? "INDEX" : "WORKING TREE"}</span>
            </div>
            <div className="toolbar-actions">
              <Action
                label="Toggle unified diff"
                icon="split"
                active={unified}
                onClick={() => {
                  setUnified(!unified);
                  void perform("layout", {
                    layout: !unified ? "unified" : "sideBySide",
                  });
                }}
              />
              <Action
                label="Toggle blame annotations"
                icon="history"
                active={showBlame}
                onClick={() => setShowBlame(!showBlame)}
              />
              <Action
                label="Preview definition"
                icon="code"
                onClick={() => diff.current?.definitions()}
                disabled={!snapshot}
              />
              <span className="divider" />
              <Action
                label="Previous change"
                icon="arrow"
                onClick={() => diff.current?.next(-1)}
                disabled={!snapshot}
              />
              <Action
                label="Next change"
                icon="arrow"
                onClick={() => diff.current?.next(1)}
                disabled={!snapshot}
              />
              <button
                className={`review-button ${selectedChange?.reviewed ? "done" : ""}`}
                disabled={!snapshot || snapshot.tooLarge || loading}
                onClick={mark}
              >
                <Icon name="check" size={15} />
                {selectedChange?.reviewed ? "Reviewed" : "Mark reviewed"}
              </button>
            </div>
          </div>
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <Icon name="close" />
              </button>
            </div>
          )}
          {snapshot?.conflicted && (
            <div className="notice">
              Merge conflict · showing working content. Resolve the conflict in
              your editor.
            </div>
          )}
          <div className="editor-area">
            {loading && <div className="loading-line" />}
            {snapshot && !snapshot.binary && !snapshot.tooLarge ? (
              <Diff
                ref={diff}
                snapshot={snapshot}
                unified={unified}
                blame={blame}
                showBlame={showBlame}
                onPosition={(line, column) => setPosition({ line, column })}
                onDefinitions={setNavigation}
                onError={report}
                onToggleBlame={setShowBlame}
                viewStates={viewStates.current}
                theme={theme}
                intellijKeymap={state?.intellijKeymap ?? true}
                root={state?.repo.root ?? ""}
              />
            ) : (
              <div className="empty">
                <Icon name={snapshot ? "file" : "check"} size={36} />
                <h2>
                  {snapshot?.binary
                    ? "Binary file"
                    : snapshot?.tooLarge
                      ? "Large file"
                      : state && changes.length === 0
                        ? "All clear."
                        : "Your review starts here."}
                </h2>
                <p>
                  {snapshot?.binary
                    ? "Text comparison is unavailable for binary content."
                    : snapshot?.tooLarge
                      ? "Files over 5 MiB open in the native editor."
                      : "Select a changed file to see its story."}
                </p>
                {snapshot && (
                  <button className="review-button" onClick={openFile}>
                    Open in editor
                  </button>
                )}
              </div>
            )}
            {navigation && (
              <div className="peek">
                <div className="peek-heading">
                  <span>
                    <Icon name="code" /> Definition preview{" "}
                    <small>{navigation.confidence}</small>
                  </span>
                  <Action
                    label="Close definition preview"
                    icon="close"
                    onClick={() => setNavigation(undefined)}
                  />
                </div>
                {navigation.note && (
                  <p className="peek-note">{navigation.note}</p>
                )}
                {!navigation.candidates.length
                  ? !navigation.note && (
                      <p className="peek-note">
                        {state?.mode === "deep"
                          ? "No definition found."
                          : "No definition found locally. Enable deep analysis for type resolution."}
                      </p>
                    )
                  : navigation.candidates.map((s, i) => (
                      <article key={`${s.path}:${s.line}:${i}`}>
                        <button
                          className="definition-link"
                          onClick={() =>
                            void perform("openLocation", {
                              path: s.path,
                              line: s.line,
                              column: s.column,
                            })
                          }
                        >
                          <strong>{s.name}</strong>
                          <span title={s.path}>
                            {displayPath(s.path, state?.repo.root)}:{s.line + 1}
                          </span>
                          <Icon name="external" size={13} />
                        </button>
                        <pre>{s.preview ?? s.signature}</pre>
                        {s.documentation && <p>{s.documentation}</p>}
                      </article>
                    ))}
              </div>
            )}
          </div>
          <div className="blame-bar">
            <Icon name="history" size={14} />
            {activeBlame ? (
              <>
                <strong>{activeBlame.author}</strong>
                <span>
                  {activeBlame.local
                    ? "Uncommitted changes"
                    : activeBlame.summary}
                </span>
                {!activeBlame.local && (
                  <button
                    onClick={() =>
                      void perform("openCommit", {
                        sha: activeBlame.sha,
                        path: activeBlame.path,
                      })
                    }
                  >
                    {activeBlame.sha.slice(0, 7)}{" "}
                    <Icon name="external" size={12} />
                  </button>
                )}
              </>
            ) : (
              <span>Place the cursor on a line to see its history</span>
            )}
            <span className="line-position">
              Ln {position.line + 1}, Col {position.column + 1}
            </span>
          </div>
        </section>
      </div>
      <footer>
        <span>
          <span className="status-dot" />{" "}
          {state?.deepStatus ?? "Connecting to repository…"}
        </span>
        <div>
          <button onClick={() => void perform("chooseTheme")}>Theme</button>
          <button onClick={() => void perform("configureDeep")}>
            Configure analysis
          </button>
          <span className="footer-hint">⌘/Ctrl+B · definition</span>
        </div>
      </footer>
      {popup?.mode === "everywhere" && (
        <SearchEverywhere
          initial={popup.initial}
          onOpen={openHit}
          onClose={closeSearch}
        />
      )}
      {popup?.mode === "find" && (
        <FindInFiles
          initial={popup.initial}
          theme={theme}
          onOpen={openHit}
          onClose={closeSearch}
        />
      )}
    </main>
  );
}
const RELOAD_VARIANTS = "\0reload";
/** IntelliJ's run widget: configuration and build variant selectors, Run (or Rerun) and Stop. */
function RunWidget({
  runs,
  selected,
  perform,
}: {
  runs: RunInfo[];
  selected?: string;
  perform: (
    method: Parameters<typeof request>[0],
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
}) {
  if (!runs.length) return null;
  const run = runs.find((r) => r.name === selected);
  return (
    <div className="run-widget">
      <button
        className="build-button"
        aria-label={run ? `Build '${run.name}'` : "Build"}
        title={
          !run
            ? "Select a run configuration to build"
            : run.build
              ? `Build '${run.name}' (⌘F9)\n${run.build}`
              : `'${run.name}' has no separate build step`
        }
        disabled={!run?.build}
        onClick={() => run && void perform("build", { name: run.name })}
      >
        <Icon name="build" size={15} />
      </button>
      <select
        aria-label="Run configuration"
        title={run?.detail ?? "Select a run configuration"}
        value={run?.name ?? ""}
        onChange={(e) => void perform("selectRun", { name: e.target.value })}
      >
        <option value="">Select configuration…</option>
        {runs.map((r) => (
          <option key={r.name} value={r.name}>
            {r.running ? "● " : ""}
            {r.name}
            {r.runnable ? "" : " (IntelliJ only)"}
          </option>
        ))}
      </select>
      {run?.variants && (
        <select
          aria-label="Build variant"
          title={`Build variant of '${run.name}'`}
          value={run.variant ?? ""}
          onChange={(e) =>
            void (e.target.value === RELOAD_VARIANTS
              ? perform("reloadVariants", { name: run.name })
              : perform("selectVariant", {
                  name: run.name,
                  variant: e.target.value,
                }))
          }
        >
          {!run.variant && (
            <option value="">
              {run.loadingVariants ? "Loading variants…" : "No variants"}
            </option>
          )}
          {run.variants.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
          <option value={RELOAD_VARIANTS} disabled={run.loadingVariants}>
            {run.loadingVariants ? "Reading variants…" : "↻ Reload variants"}
          </option>
        </select>
      )}
      <button
        className="run-button"
        aria-label={
          run ? `${run.running ? "Rerun" : "Run"} '${run.name}'` : "Run"
        }
        title={
          !run
            ? "Select a run configuration"
            : run.runnable
              ? `${run.running ? "Rerun" : "Run"} '${run.name}'\n${run.detail}`
              : run.detail
        }
        disabled={!run?.runnable}
        onClick={() => run && void perform("run", { name: run.name })}
      >
        <Icon name={run?.running ? "rerun" : "play"} size={15} />
      </button>
      <button
        className="attach-button"
        aria-label="Attach Debugger to Process"
        title="Attach Debugger to Process (⌥⇧F5)"
        onClick={() => void perform("attachDebugger")}
      >
        <Icon name="attach" size={15} />
      </button>
      {run?.running && (
        <button
          className="stop-button"
          aria-label={`Stop '${run.name}'`}
          title={`Stop '${run.name}'`}
          onClick={() => void perform("stopRun", { name: run.name })}
        >
          <Icon name="stop" size={13} />
        </button>
      )}
    </div>
  );
}
interface TreeRow {
  key: string;
  label: string;
  depth: number;
  folder: boolean;
  change?: Change;
  count?: number;
  /** A Git submodule's folder. */
  submodule?: boolean;
}
function FileTree({
  changes,
  submodules = [],
  selected,
  onSelect,
}: {
  changes: Change[];
  submodules?: string[];
  selected: string;
  onSelect: (file: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(
    new Set(vscode.getState()?.collapsed ?? []),
  );
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver((entries) =>
      setHeight(entries[0].contentRect.height),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const rows = useMemo(() => {
    interface Node {
      key: string;
      label: string;
      children: Map<string, Node>;
      change?: Change;
      count: number;
    }
    const root: Node = { key: "", label: "", children: new Map(), count: 0 };
    for (const change of changes) {
      let node = root;
      const parts = change.path.split("/");
      for (let i = 0; i < parts.length; i++) {
        const label = parts[i],
          key = parts.slice(0, i + 1).join("/");
        let child = node.children.get(label);
        if (!child) {
          child = { key, label, children: new Map(), count: 0 };
          node.children.set(label, child);
        }
        child.count++;
        if (i === parts.length - 1) child.change = change;
        node = child;
      }
    }
    const result: TreeRow[] = [];
    const repos = new Set(submodules);
    function emit(node: Node, depth: number) {
      let label = node.label;
      // A submodule keeps its own row, so its files are not folded into the parent folder's.
      while (!node.change && node.children.size === 1 && !repos.has(node.key)) {
        const child = [...node.children.values()][0];
        if (child.change && !child.children.size) break;
        label += "/" + child.label;
        node = child;
      }
      const folder = node.children.size > 0;
      const submodule = repos.has(node.key) || Boolean(node.change?.submodule);
      result.push({
        key: node.key,
        label,
        depth,
        folder,
        change: folder ? undefined : node.change,
        count: node.count,
        submodule,
      });
      if (!folder || collapsed.has(node.key)) return;
      // A submodule that moved to another commit and also has edited files: the commit first.
      if (node.change)
        result.push({
          key: node.key,
          label: "Submodule commit",
          depth: depth + 1,
          folder: false,
          change: node.change,
          submodule: true,
        });
      for (const child of node.children.values()) emit(child, depth + 1);
    }
    for (const node of root.children.values()) emit(node, 0);
    return result;
  }, [changes, collapsed, submodules]);
  useEffect(() => {
    vscode.setState({ ...vscode.getState(), collapsed: [...collapsed] });
  }, [collapsed]);
  const rowHeight = 30;
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 6),
    end = Math.min(rows.length, Math.ceil((scroll + height) / rowHeight) + 6);
  useEffect(() => {
    const index = rows.findIndex((r) => r.key === selected && !r.folder);
    const el = ref.current;
    if (index >= 0 && el) {
      const top = index * rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + el.clientHeight)
        el.scrollTop = top + rowHeight - el.clientHeight;
    }
  }, [selected, height]);
  const toggle = (key: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const keyboard = (event: React.KeyboardEvent) => {
    const files = rows.filter((r) => !r.folder);
    const index = files.findIndex((r) => r.key === selected);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        files[
          Math.max(
            0,
            Math.min(
              files.length - 1,
              index + (event.key === "ArrowDown" ? 1 : -1),
            ),
          )
        ];
      if (next) onSelect(next.key);
    }
  };
  return (
    <div
      className="file-tree"
      ref={ref}
      role="tree"
      aria-label="Changed files"
      tabIndex={0}
      onKeyDown={keyboard}
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
    >
      <div style={{ height: rows.length * rowHeight, position: "relative" }}>
        {rows.slice(start, end).map((row, index) => (
          <button
            key={`${row.folder ? "folder" : "file"}:${row.key}`}
            className={`tree-row ${row.folder ? "folder-row" : "file-row"} ${!row.folder && selected === row.key ? "selected" : ""}`}
            role="treeitem"
            aria-selected={row.folder ? undefined : selected === row.key}
            aria-expanded={row.folder ? !collapsed.has(row.key) : undefined}
            aria-label={
              row.folder ? row.key : `${row.change?.status} ${row.key}`
            }
            style={{
              top: (start + index) * rowHeight,
              paddingLeft: 14 + row.depth * 15,
            }}
            onClick={() => (row.folder ? toggle(row.key) : onSelect(row.key))}
            title={
              row.change?.oldPath
                ? `${row.change.oldPath} → ${row.key}`
                : row.key
            }
          >
            {row.folder ? (
              <>
                <span
                  className={`folder-chevron ${collapsed.has(row.key) ? "closed" : ""}`}
                >
                  <Icon name="chevron" size={12} />
                </span>
                {row.submodule ? (
                  <span className="submodule-icon" title="Git submodule">
                    <Icon name="branch" size={15} />
                  </span>
                ) : (
                  <Icon name="folder" size={15} />
                )}
                <span className="tree-name">{row.label}</span>
                <span className="tree-count">{row.count}</span>
              </>
            ) : (
              <>
                {row.submodule ? (
                  <span className="submodule-icon" title="Git submodule">
                    <Icon name="branch" size={15} />
                  </span>
                ) : (
                  <span
                    className={`language-icon ${row.label.endsWith(".java") ? "java" : "kotlin"}`}
                  >
                    {row.label.endsWith(".kt")
                      ? "K"
                      : row.label.endsWith(".java")
                        ? "J"
                        : "·"}
                  </span>
                )}
                <span className="tree-name">{row.label}</span>
                {row.change?.dirty && (
                  <span className="dirty-dot" title="Unsaved" />
                )}
                {row.change?.reviewed ? (
                  <span className="reviewed-check">
                    <Icon name="check" size={13} />
                  </span>
                ) : (
                  <span
                    className={`tree-status ${row.change?.status === "?" ? "A" : row.change?.status}`}
                  >
                    {row.change?.status}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
      </div>
      {!rows.length && <p className="no-matches">No files match this view.</p>}
    </div>
  );
}
