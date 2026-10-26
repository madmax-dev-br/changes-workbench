import React, {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  language as kotlin,
  conf as kotlinConfiguration,
} from "monaco-editor/esm/vs/basic-languages/kotlin/kotlin";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
// editor.api has no contributions; the hover one shows documentation and blame on mouse over.
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import type { Snapshot, BlameLine, Navigation, LineChange } from "../shared";
import { displayPath } from "../shared";
import { request, vscode } from "./rpc";
import palettes from "../palettes.json";
declare global {
  interface Window {
    __WORKER_URL__: string;
  }
}
window.MonacoEnvironment = {
  getWorker: () => {
    const url = URL.createObjectURL(
      new Blob([`importScripts(${JSON.stringify(window.__WORKER_URL__)});`], {
        type: "application/javascript",
      }),
    );
    const worker = new Worker(url);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return worker;
  },
};
monaco.languages.register({ id: "kotlin", extensions: [".kt", ".kts"] });
monaco.languages.setLanguageConfiguration("kotlin", kotlinConfiguration);
monaco.languages.setMonarchTokensProvider("kotlin", {
  ...kotlin,
  tokenizer: {
    ...kotlin.tokenizer,
    root: [
      [/\b(fun)(\s+)([\w`]+)/, ["keyword", "white", "function"]],
      ...kotlin.tokenizer.root,
    ],
  },
});
for (const [name, p] of Object.entries(palettes)) {
  monaco.editor.defineTheme(`changes-${name}`, {
    base: name === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: p.text.slice(1) },
      { token: "keyword", foreground: p.keyword.slice(1), fontStyle: "" },
      { token: "function", foreground: p.function.slice(1) },
      { token: "delimiter", foreground: p.text.slice(1) },
      { token: "string", foreground: p.string.slice(1) },
      { token: "comment", foreground: p.comment.slice(1) },
      { token: "number", foreground: p.number.slice(1) },
      { token: "type.identifier", foreground: p.text.slice(1) },
      { token: "annotation", foreground: p.annotation.slice(1) },
    ],
    colors: {
      "editor.background": p.bg,
      "editor.foreground": p.text,
      "editorGutter.background": p.bg,
      "editorLineNumber.foreground": p.lineNumber,
      "editor.lineHighlightBackground": p.line,
      "editor.selectionBackground": p.selection,
      "editorWidget.background": p.panel,
      "editorHoverWidget.background": p.panel,
      "editorHoverWidget.border": p.border,
      "diffEditor.insertedTextBackground": p.insert,
      "diffEditor.removedTextBackground": p.remove,
      "diffEditor.insertedLineBackground": p.insert + "90",
      "diffEditor.removedLineBackground": p.remove + "90",
    },
  });
}
export interface DiffHandle {
  next: (direction: number) => void;
  position: () => { line: number; column: number };
  focus: () => void;
  definitions: () => void;
  documentation: () => void;
}
interface Props {
  snapshot: Snapshot;
  unified: boolean;
  blame: BlameLine[];
  showBlame: boolean;
  onPosition: (line: number, column: number) => void;
  onDefinitions: (nav: Navigation) => void;
  onError: (message: string) => void;
  onToggleBlame: (show: boolean) => void;
  viewStates: Map<string, monaco.editor.IDiffEditorViewState>;
  theme: string;
  intellijKeymap: boolean;
  root: string;
}
export const Diff = forwardRef<DiffHandle, Props>((props, ref) => {
  const mount = useRef<HTMLDivElement>(null);
  const diff = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(
    undefined,
  );
  const latest = useRef(props);
  latest.current = props;
  const [menu, setMenu] = useState<
    { x: number; y: number; gutter: boolean } | undefined
  >();
  // IntelliJ's change popup: the original text of one hunk, with Rollback.
  const [hunk, setHunk] = useState<
    { change: LineChange; x: number; y: number } | undefined
  >();
  const popup = useRef<HTMLDivElement>(null);
  const currentKey = useRef("");
  const navigationRequest = useRef<AbortController | undefined>(undefined);
  const markers = useRef<
      monaco.editor.IEditorDecorationsCollection | undefined
    >(undefined),
    annotations = useRef<
      monaco.editor.IEditorDecorationsCollection | undefined
    >(undefined);

  const navigate = async (line?: number, column?: number) => {
    const p = latest.current;
    navigationRequest.current?.abort();
    const controller = new AbortController();
    navigationRequest.current = controller;
    const position = diff.current?.getModifiedEditor().getPosition();
    try {
      const nav = await request<Navigation>(
        "navigate",
        {
          path: p.snapshot.path,
          line: line ?? (position?.lineNumber ?? 1) - 1,
          column: column ?? (position?.column ?? 1) - 1,
        },
        p.snapshot.version,
        controller.signal,
      );
      if (
        !controller.signal.aborted &&
        latest.current.snapshot.version === p.snapshot.version
      )
        p.onDefinitions(nav);
    } catch (e) {
      if (!controller.signal.aborted) p.onError(String(e));
    }
  };
  const changeAt = (line: number) =>
    diff.current
      ?.getLineChanges()
      ?.find(
        (c) =>
          line >= Math.max(1, c.modifiedStartLineNumber) &&
          line <=
            Math.max(1, c.modifiedEndLineNumber || c.modifiedStartLineNumber),
      );
  const openHunk = (change: LineChange) => {
    const modified = diff.current?.getModifiedEditor();
    if (!modified) return;
    const line = Math.max(
      1,
      change.modifiedEndLineNumber || change.modifiedStartLineNumber,
    );
    modified.revealLineInCenterIfOutsideViewport(line);
    const at = modified.getScrolledVisiblePosition({
      lineNumber: line,
      column: 1,
    });
    const box = modified.getDomNode()?.getBoundingClientRect();
    if (!at || !box) return;
    setMenu(undefined);
    setHunk({ change, x: box.left + 4, y: box.top + at.top + at.height });
  };
  const rollback = async (change: LineChange) => {
    const p = latest.current;
    setHunk(undefined);
    try {
      await request(
        "rollback",
        { path: p.snapshot.path, change },
        p.snapshot.version,
      );
    } catch (e) {
      p.onError(String(e));
    }
  };
  const rollbackBlocked = () =>
    latest.current.snapshot.scope === "staged"
      ? "Rollback works on working tree changes"
      : latest.current.snapshot.conflicted
        ? "Resolve the conflict in the editor first"
        : "";
  useImperativeHandle(ref, () => ({
    next: (direction) => {
      const d = diff.current;
      if (!d) return;
      const changes = d.getLineChanges() ?? [];
      const editor = d.getModifiedEditor();
      const line = editor.getPosition()?.lineNumber ?? 1;
      const positions = changes.map((c) =>
        Math.max(1, c.modifiedStartLineNumber),
      );
      const target =
        direction > 0
          ? (positions.find((p) => p > line) ?? positions[0])
          : (positions.filter((p) => p < line).at(-1) ?? positions.at(-1));
      if (target) {
        editor.setPosition({ lineNumber: target, column: 1 });
        editor.revealLineInCenter(target);
        editor.focus();
      }
    },
    position: () => {
      const p = diff.current?.getModifiedEditor().getPosition();
      return { line: (p?.lineNumber ?? 1) - 1, column: (p?.column ?? 1) - 1 };
    },
    focus: () => diff.current?.getModifiedEditor().focus(),
    definitions: () => void navigate(),
    documentation: () => {
      void diff.current
        ?.getModifiedEditor()
        .getAction("editor.action.showHover")
        ?.run();
    },
  }));
  useEffect(() => {
    if (!mount.current) return;
    const editor = monaco.editor.createDiffEditor(mount.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: !latest.current.unified,
      minimap: { enabled: false },
      bracketPairColorization: { enabled: false },
      fontSize: 13,
      lineHeight: 22,
      fontFamily: '"SF Mono", Menlo, Consolas, monospace',
      scrollBeyondLastLine: false,
      renderIndicators: false,
      glyphMargin: true,
      folding: true,
      // Monaco's menu does not render inside VS Code webviews; the panel draws its own.
      contextmenu: false,
      wordWrap: "off",
      diffWordWrap: "off",
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      enableSplitViewResizing: true,
      hideUnchangedRegions: {
        enabled: true,
        contextLineCount: 5,
        minimumLineCount: 10,
      },
      padding: { top: 12, bottom: 20 },
      accessibilitySupport: "auto",
    });
    diff.current = editor;
    const modified = editor.getModifiedEditor();
    markers.current = modified.createDecorationsCollection();
    const originalMarkers = editor
      .getOriginalEditor()
      .createDecorationsCollection();
    annotations.current = modified.createDecorationsCollection();
    const disposables: monaco.IDisposable[] = [];
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    const persistView = () => {
      const state = editor.saveViewState();
      if (state && currentKey.current) {
        const states = latest.current.viewStates;
        states.set(currentKey.current, state);
        while (states.size > 50) states.delete(states.keys().next().value!);
        vscode.setState({
          ...vscode.getState(),
          viewStates: Object.fromEntries(states),
        });
      }
    };
    const schedulePersist = () => {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistView, 100);
    };
    disposables.push(
      modified.onDidScrollChange(schedulePersist),
      modified.onDidChangeCursorPosition(schedulePersist),
    );
    const visibility = () => {
      if (document.hidden) persistView();
    };
    document.addEventListener("visibilitychange", visibility);

    const addHover = (language: string) =>
      monaco.languages.registerHoverProvider(language, {
        provideHover: async (model, position, token) => {
          if (model !== editor.getModifiedEditor().getModel()) return;
          const p = latest.current;
          const controller = new AbortController();
          const listener = token.onCancellationRequested(() =>
            controller.abort(),
          );
          try {
            const nav = await request<Navigation>(
              "navigate",
              {
                path: p.snapshot.path,
                line: position.lineNumber - 1,
                column: position.column - 1,
              },
              p.snapshot.version,
              controller.signal,
            );
            const contents: monaco.IMarkdownString[] = [];
            for (const s of nav.candidates.slice(0, 3)) {
              contents.push({
                value: `\`\`\`${language}\n${s.signature}\n\`\`\`\n${escapeMarkdown(s.documentation)}\n\n${escapeMarkdown(displayPath(s.path, p.root))}:${s.line + 1}`,
              });
            }
            if (nav.note) contents.push({ value: escapeMarkdown(nav.note) });
            if (nav.candidates.length)
              contents.push({ value: "**⌘/Ctrl+B** · Preview definition" });
            const blame = p.blame.find((b) => b.line === position.lineNumber);
            if (blame)
              contents.push({
                value: `---\n${escapeMarkdown(blame.author)} · ${blame.local ? "Uncommitted" : blame.sha.slice(0, 7)}\n\n${escapeMarkdown(blame.summary)}`,
              });
            return contents.length ? { contents } : undefined;
          } catch {
            return undefined;
          } finally {
            listener.dispose();
          }
        },
      });
    disposables.push(addHover("kotlin"), addHover("java"));
    // IntelliJ-style annotations: right-click the gutter (or the text) to annotate or close.
    const gutter = [
      monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
      monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
      monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
    ];
    disposables.push(
      modified.onContextMenu((e) => {
        e.event.preventDefault();
        e.event.stopPropagation();
        if (e.target.position) modified.setPosition(e.target.position);
        modified.focus();
        setMenu({
          x: e.event.browserEvent.clientX,
          y: e.event.browserEvent.clientY,
          gutter: gutter.includes(e.target.type),
        });
      }),
      // Clicking an annotation opens that line's commit, as in IntelliJ.
      modified.onMouseDown((e) => {
        const p = latest.current;
        if (
          !p.showBlame ||
          e.event.rightButton ||
          e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        )
          return;
        const line = p.blame.find(
          (b) => b.line === e.target.position?.lineNumber,
        );
        if (line && !line.local)
          void request("openCommit", { sha: line.sha, path: line.path }).catch(
            (error) => latest.current.onError(String(error)),
          );
      }),
    );
    disposables.push(
      modified.onDidScrollChange(() => setHunk(undefined)),
      // IntelliJ's Rollback Lines (Ctrl+Alt+Z / ⌘⌥Z) for the change under the cursor.
      modified.addAction({
        id: "changes.rollbackLines",
        label: "Rollback Lines",
        keybindings: [
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyZ,
        ],
        run: () => {
          const c = changeAt(modified.getPosition()?.lineNumber ?? 0);
          if (c && !rollbackBlocked()) void rollback(c);
        },
      }),
      modified.addAction({
        id: "changes.previewDefinition",
        label: "Preview Definition",
        keybindings: [],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: () => navigate(),
      }),
    );
    disposables.push(
      modified.onDidChangeCursorPosition((e) =>
        latest.current.onPosition(
          e.position.lineNumber - 1,
          e.position.column - 1,
        ),
      ),
    );
    disposables.push(
      editor.onDidUpdateDiff(() => {
        const model = modified.getModel();
        const original = editor.getOriginalEditor().getModel();
        if (!model || !original) return;
        const decorations: monaco.editor.IModelDeltaDecoration[] = [];
        const baseDecorations: monaco.editor.IModelDeltaDecoration[] = [];
        for (const c of editor.getLineChanges() ?? []) {
          const added = c.originalEndLineNumber === 0;
          const removed = c.modifiedEndLineNumber === 0;
          const start = Math.min(
            model.getLineCount(),
            Math.max(1, c.modifiedStartLineNumber),
          );
          const end = removed
            ? start
            : Math.max(start, c.modifiedEndLineNumber);
          if (!added)
            baseDecorations.push({
              range: new monaco.Range(
                c.originalStartLineNumber,
                1,
                c.originalEndLineNumber,
                original.getLineMaxColumn(c.originalEndLineNumber),
              ),
              options: {
                isWholeLine: true,
                zIndex: 5,
                inlineClassName: removed ? undefined : "cw-modified-inline",
                className: removed
                  ? "cw-removed-background"
                  : "cw-modified-background",
              },
            });
          decorations.push({
            range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
            options: {
              isWholeLine: !removed,
              zIndex: 5,
              inlineClassName:
                !removed && !added ? "cw-modified-inline" : undefined,
              linesDecorationsClassName: removed
                ? "cw-deleted"
                : added
                  ? "cw-added"
                  : "cw-modified",
              className:
                !removed && !added ? "cw-modified-background" : undefined,
              hoverMessage: {
                value: `${removed ? "Deleted" : added ? "Added" : "Modified"} lines · click the marker to see the original or roll back`,
              },
            },
          });
        }
        originalMarkers.set(baseDecorations);
        markers.current?.set(decorations);
      }),
    );
    disposables.push(
      modified.onMouseDown((e) => {
        const pos = e.target.position;
        if (!pos) return;
        if (e.event.ctrlKey || e.event.metaKey) {
          void navigate(pos.lineNumber - 1, pos.column - 1);
          return;
        }
        if (
          [
            monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
            monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
          ].includes(e.target.type)
        ) {
          const c = changeAt(pos.lineNumber);
          if (c) openHunk(c);
        }
      }),
    );
    // IntelliJ link highlight: holding ⌘ (Ctrl elsewhere) underlines a navigable symbol.
    const link = modified.createDecorationsCollection();
    const mac = /Mac/i.test(navigator.platform);
    let pointer: monaco.editor.IMouseTarget | undefined;
    let linkKey = "";
    let linkRequest: AbortController | undefined;
    const clearLink = () => {
      linkKey = "";
      linkRequest?.abort();
      link.clear();
    };
    const showLink = async (held: boolean) => {
      const model = modified.getModel();
      const position =
        pointer?.type === monaco.editor.MouseTargetType.CONTENT_TEXT
          ? pointer.position
          : undefined;
      const word = position && model?.getWordAtPosition(position);
      if (!held || !position || !word || !/^[A-Za-z_$]/.test(word.word))
        return clearLink();
      const p = latest.current;
      const key = `${p.snapshot.version}:${position.lineNumber}:${word.startColumn}`;
      if (key === linkKey) return;
      clearLink();
      linkKey = key;
      const controller = new AbortController();
      linkRequest = controller;
      try {
        const nav = await request<Navigation>(
          "navigate",
          {
            path: p.snapshot.path,
            line: position.lineNumber - 1,
            column: word.startColumn - 1,
          },
          p.snapshot.version,
          controller.signal,
        );
        if (linkKey === key && nav.candidates.length)
          link.set([
            {
              range: new monaco.Range(
                position.lineNumber,
                word.startColumn,
                position.lineNumber,
                word.endColumn,
              ),
              options: { inlineClassName: "cw-link" },
            },
          ]);
      } catch {}
    };
    const held = (e: { metaKey: boolean; ctrlKey: boolean }) =>
      mac ? e.metaKey : e.ctrlKey;
    const linkKeys = (e: KeyboardEvent) => void showLink(held(e));
    window.addEventListener("keydown", linkKeys);
    window.addEventListener("keyup", linkKeys);
    window.addEventListener("blur", clearLink);
    disposables.push(
      modified.onMouseMove((e) => {
        pointer = e.target;
        void showLink(held(e.event));
      }),
      modified.onMouseLeave(() => {
        pointer = undefined;
        clearLink();
      }),
      modified.onDidChangeModel(clearLink),
    );
    return () => {
      window.removeEventListener("keydown", linkKeys);
      window.removeEventListener("keyup", linkKeys);
      window.removeEventListener("blur", clearLink);
      linkRequest?.abort();
      navigationRequest.current?.abort();
      clearTimeout(persistTimer);
      persistView();
      document.removeEventListener("visibilitychange", visibility);
      const state = editor.saveViewState();
      if (state && currentKey.current)
        latest.current.viewStates.set(currentKey.current, state);
      for (const d of disposables) d.dispose();
      const models = editor.getModel();
      editor.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
      editor.dispose();
      diff.current = undefined;
    };
  }, []);
  useEffect(() => {
    const editor = diff.current;
    if (!editor) return;
    navigationRequest.current?.abort();
    const snapshot = props.snapshot;
    const key = `${snapshot.scope}:${snapshot.path}`;
    const old = editor.getModel();
    const oldState = editor.saveViewState();
    if (oldState && currentKey.current)
      props.viewStates.set(currentKey.current, oldState);
    const original = monaco.editor.createModel(
      snapshot.original,
      snapshot.language,
      monaco.Uri.parse(
        `changes-base:/${encodeURIComponent(snapshot.path)}?${snapshot.version}`,
      ),
    );
    const current = monaco.editor.createModel(
      snapshot.current,
      snapshot.language,
      monaco.Uri.parse(
        `changes-live:/${encodeURIComponent(snapshot.path)}?${snapshot.version}`,
      ),
    );
    setHunk(undefined);
    editor.setModel({ original, modified: current });
    old?.original.dispose();
    old?.modified.dispose();
    currentKey.current = key;
    const saved = props.viewStates.get(key);
    if (saved) editor.restoreViewState(saved);
    else editor.getModifiedEditor().setPosition({ lineNumber: 1, column: 1 });
  }, [props.snapshot.version]);
  useEffect(() => {
    diff.current?.updateOptions({ renderSideBySide: !props.unified });
  }, [props.unified]);
  useEffect(() => {
    monaco.editor.setTheme(`changes-${props.theme}`);
  }, [props.theme]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);
  useEffect(() => {
    const modified = diff.current?.getModifiedEditor();
    const model = modified?.getModel();
    if (!modified || !model) return;
    if (!props.showBlame) {
      modified.updateOptions({ lineNumbers: "on", lineNumbersMinChars: 5 });
      annotations.current?.set([]);
      return;
    }
    const byLine = new Map(props.blame.map((b) => [b.line, b]));
    modified.updateOptions({
      lineNumbersMinChars: BLAME_WIDTH + 5,
      lineNumbers: (line) =>
        (byLine.has(line) ? blameLabel(byLine.get(line)!) : "").padEnd(
          BLAME_WIDTH,
        ) + String(line).padStart(5),
    });
    annotations.current?.set(
      props.blame
        .filter((b) => b.line <= model.getLineCount())
        .map((b) => ({
          range: new monaco.Range(b.line, 1, b.line, 1),
          options: {
            lineNumberClassName: b.local ? "cw-blame-local" : "cw-blame-line",
            lineNumberHoverMessage: {
              value: b.local
                ? "Not committed yet"
                : `**${escapeMarkdown(b.author)}** · ${b.sha.slice(0, 7)} · ${new Date(b.time * 1000).toLocaleString()}\n\n${escapeMarkdown(b.summary)}\n\nClick to open the commit.`,
            },
          },
        })),
    );
  }, [props.blame, props.showBlame, props.snapshot.version]);
  useEffect(() => {
    if (!hunk) return;
    const close = (e: Event) => {
      if (!popup.current?.contains(e.target as Node)) setHunk(undefined);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setHunk(undefined);
    // Capture: a click on another marker closes this popup before opening its own.
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key);
    };
  }, [hunk]);
  const hunkView = () => {
    if (!hunk) return;
    const { change } = hunk;
    const original = diff.current?.getOriginalEditor().getModel();
    const text =
      change.originalEndLineNumber && original
        ? original.getValueInRange(
            new monaco.Range(
              change.originalStartLineNumber,
              1,
              change.originalEndLineNumber,
              original.getLineMaxColumn(change.originalEndLineNumber),
            ),
          )
        : "";
    const changes = diff.current?.getLineChanges() ?? [];
    const index = changes.findIndex(
      (c) =>
        c.modifiedStartLineNumber === change.modifiedStartLineNumber &&
        c.originalStartLineNumber === change.originalStartLineNumber,
    );
    const step = (direction: number) => {
      const next =
        changes[(index + direction + changes.length) % changes.length];
      if (next) openHunk(next);
    };
    const blocked = rollbackBlocked();
    const tool = (
      label: string,
      icon: string,
      run: () => void,
      disabled = false,
      title = label,
    ) => (
      <button
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={run}
      >
        <span className={`codicon codicon-${icon}`} />
      </button>
    );
    return (
      <div
        ref={popup}
        className="cw-hunk"
        role="dialog"
        aria-label="Change"
        style={{
          left: Math.max(8, Math.min(hunk.x, window.innerWidth - 480)),
          top: Math.max(8, Math.min(hunk.y, window.innerHeight - 140)),
        }}
      >
        <div className="cw-hunk-toolbar">
          {tool(
            "Previous change",
            "arrow-up",
            () => step(-1),
            changes.length < 2,
          )}
          {tool("Next change", "arrow-down", () => step(1), changes.length < 2)}
          {tool(
            "Rollback",
            "discard",
            () => void rollback(change),
            Boolean(blocked),
            blocked || "Rollback (⌘⌥Z / Ctrl+Alt+Z)",
          )}
          {tool(
            "Copy original",
            "copy",
            () => void navigator.clipboard?.writeText(text),
            !text,
          )}
          <span className="cw-hunk-title">
            {!change.originalEndLineNumber
              ? "Added lines"
              : !change.modifiedEndLineNumber
                ? "Deleted lines"
                : "Modified lines"}
            {index >= 0 && changes.length > 1
              ? ` · ${index + 1} of ${changes.length}`
              : ""}
          </span>
          {tool("Close", "close", () => setHunk(undefined))}
        </div>
        {text ? (
          <pre>{text}</pre>
        ) : (
          <p>Nothing existed here in the base; Rollback removes these lines.</p>
        )}
      </div>
    );
  };
  const item = (label: string, run: () => void) => (
    <button
      role="menuitem"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        setMenu(undefined);
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <>
      <div ref={mount} className="diff-editor" data-testid="diff-editor" />
      {menu && (
        <div
          className="cw-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {props.showBlame
            ? item("Close Annotations", () => props.onToggleBlame(false))
            : item("Annotate with Git Blame", () => props.onToggleBlame(true))}
          {(() => {
            const c = changeAt(
              diff.current?.getModifiedEditor().getPosition()?.lineNumber ?? 0,
            );
            return (
              c &&
              !rollbackBlocked() && (
                <>
                  {item("Show Original…", () => openHunk(c))}
                  {item("Rollback Lines", () => void rollback(c))}
                </>
              )
            );
          })()}
          {!menu.gutter && item("Preview Definition", () => void navigate())}
        </div>
      )}
      {hunkView()}
    </>
  );
});
const BLAME_WIDTH = 24;
/** IntelliJ-style gutter annotation: short date and author. */
function blameLabel(b: BlameLine) {
  if (b.local) return "Not committed";
  const date = new Date(b.time * 1000).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
  return `${date} ${b.author}`.slice(0, BLAME_WIDTH - 1);
}
function escapeMarkdown(text: string) {
  return text.replace(/[\\`*_{}\[\]()<>#+!|]/g, "\\$&");
}
