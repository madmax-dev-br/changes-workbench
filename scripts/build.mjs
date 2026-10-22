import { build } from "esbuild";
import fs from "node:fs/promises";
import "./themes.mjs";
await fs.mkdir("dist", { recursive: true });
await fs.mkdir("assets", { recursive: true });
await Promise.all([
  build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/host/parser-worker.ts"],
    outfile: "dist/parser-worker.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/web/main.tsx"],
    outfile: "dist/webview.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    loader: { ".ttf": "file" },
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({
    entryPoints: ["node_modules/monaco-editor/esm/vs/editor/editor.worker.js"],
    outfile: "dist/editor.worker.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    minify: true,
    target: "es2022",
  }),
]);
for (const language of ["java", "kotlin"])
  await fs.copyFile(
    `node_modules/tree-sitter-wasms/out/tree-sitter-${language}.wasm`,
    `assets/tree-sitter-${language}.wasm`,
  );
await fs.copyFile(
  "node_modules/web-tree-sitter/tree-sitter.wasm",
  "assets/tree-sitter.wasm",
);
console.log("Built extension, parser worker, and local Monaco assets.");
const notices = [];
for (const name of [
  "react",
  "react-dom",
  "scheduler",
  "monaco-editor",
  "web-tree-sitter",
  "tree-sitter-wasms",
  "vscode-jsonrpc",
]) {
  try {
    const pkg = JSON.parse(
      await fs.readFile(`node_modules/${name}/package.json`, "utf8"),
    );
    const text = await fs
      .readFile(`node_modules/${name}/LICENSE`, "utf8")
      .catch(() => fs.readFile(`node_modules/${name}/LICENSE.txt`, "utf8"));
    notices.push(`${name} ${pkg.version}\n${text}`);
  } catch (error) {
    console.warn("License notice:", name, String(error));
  }
}
await fs.writeFile(
  "assets/THIRD_PARTY_NOTICES.txt",
  notices.join("\n\n------------------------------\n\n"),
);
