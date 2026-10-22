import React, {
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  language as kotlin,
  conf as kotlinConfiguration,
} from "monaco-editor/esm/vs/basic-languages/kotlin/kotlin";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import type { Snapshot, BlameLine, Navigation } from "../shared";
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
  onOriginal: (text: string, line: number) => void;
  onError: (message: string) => void;
  viewStates: Map<string, monaco.editor.IDiffEditorViewState>;
  theme: string;
  intellijKeymap: boolean;
}
export const Diff = forwardRef<DiffHandle, Props>((props, ref) => {
  const mount = useRef<HTMLDivElement>(null);
  const diff = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(
    undefined,
  );
  const latest = useRef(props);
  latest.current = props;
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
      contextmenu: true,
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
                value: `\`\`\`${language}\n${s.signature}\n\`\`\`\n${escapeMarkdown(s.documentation)}\n\n${escapeMarkdown(s.path)}:${s.line + 1}`,
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
    disposables.push(
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
                value: removed
                  ? "Deleted lines · click the gutter marker"
                  : added
                    ? "Added lines"
                    : "Modified lines · click the blue marker",
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
          const c = editor
            .getLineChanges()
            ?.find(
              (c) =>
                pos.lineNumber >= Math.max(1, c.modifiedStartLineNumber) &&
                pos.lineNumber <=
                  Math.max(
                    1,
                    c.modifiedEndLineNumber || c.modifiedStartLineNumber,
                  ),
            );
          const original = editor.getOriginalEditor().getModel();
          if (c && original) {
            const text =
              c.originalEndLineNumber === 0
                ? "New lines — nothing existed here in the base."
                : original.getValueInRange(
                    new monaco.Range(
                      Math.max(1, c.originalStartLineNumber),
                      1,
                      c.originalEndLineNumber,
                      original.getLineMaxColumn(c.originalEndLineNumber),
                    ),
                  );
            latest.current.onOriginal(text, c.originalStartLineNumber);
          }
        }
      }),
    );
    return () => {
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
    const model = diff.current?.getModifiedEditor().getModel();
    if (!model) return;
    annotations.current?.set(
      props.showBlame
        ? props.blame
            .filter((b) => b.line <= model.getLineCount())
            .map((b) => ({
              range: new monaco.Range(b.line, 1, b.line, 1),
              options: {
                showIfCollapsed: true,
                before: {
                  content: `${b.local ? "You" : b.author.slice(0, 16)} · ${b.local ? "local" : b.sha.slice(0, 7)}  `,
                  inlineClassName: "cw-blame-text",
                  cursorStops: monaco.editor.InjectedTextCursorStops.None,
                },
                hoverMessage: { value: escapeMarkdown(b.summary) },
              },
            }))
        : [],
    );
  }, [props.blame, props.showBlame, props.snapshot.version]);
  return <div ref={mount} className="diff-editor" data-testid="diff-editor" />;
});
function escapeMarkdown(text: string) {
  return text.replace(/[\\`*_{}\[\]()<>#+!|]/g, "\\$&");
}
