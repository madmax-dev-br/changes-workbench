import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import Parser from "web-tree-sitter";
import type { ParsedFile, SymbolInfo } from "../shared";
let ready: Promise<void> | undefined;
const parsers = new Map<string, Parser>();
async function parse(file: string, source: string): Promise<ParsedFile> {
  ready ??= Parser.init({
    locateFile: () => path.join(workerData.assets, "tree-sitter.wasm"),
  });
  await ready;
  const language = file.endsWith(".java") ? "java" : "kotlin";
  let parser = parsers.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(
      await Parser.Language.load(
        path.join(workerData.assets, `tree-sitter-${language}.wasm`),
      ),
    );
    parsers.set(language, parser);
  }
  const tree = parser.parse(source);
  const symbols: SymbolInfo[] = [];
  const imports: ParsedFile["imports"] = [];
  let packageName = "";
  const declarations = new Set([
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "object_declaration",
    "type_alias",
    "function_declaration",
    "method_declaration",
    "constructor_declaration",
    "variable_declaration",
    "variable_declarator",
    "parameter",
    "formal_parameter",
    "enum_constant",
    "record_declaration",
  ]);
  const scopes = new Set([
    "block",
    "class_body",
    "function_body",
    "statements",
    "source_file",
    "program",
  ]);
  function visit(node: Parser.SyntaxNode) {
    if (node.type === "package_header" || node.type === "package_declaration")
      // Kotlin's package_header can extend over a following comment: keep only the name.
      packageName =
        /^package\s+([\w.`]+)/.exec(node.text)?.[1]?.replace(/`/g, "") ?? "";
    if (node.type === "import_header" || node.type === "import_declaration") {
      const clean = node.text
        .replace(/^import\s+(?:static\s+)?/, "")
        .replace(/;\s*$/, "")
        .split(/\s+as\s+/);
      const name = clean[0].match(/^[\w.*$]+/)?.[0];
      if (name)
        imports.push({ path: name, alias: clean[1]?.match(/^\w+/)?.[0] });
    }
    if (declarations.has(node.type)) {
      const name =
        node.childForFieldName("name") ??
        node.namedChildren.find((n) =>
          ["simple_identifier", "type_identifier", "identifier"].includes(
            n.type,
          ),
        );
      if (name) {
        let scope = node.parent;
        const isParam = node.type.includes("parameter");
        while (
          scope &&
          !(isParam
            ? [
                "function_declaration",
                "method_declaration",
                "constructor_declaration",
              ].includes(scope.type)
            : scopes.has(scope.type))
        )
          scope = scope.parent;
        // Kotlin keeps `val String.initials: String` in a property_declaration around the name.
        const owner =
          node.type === "variable_declaration" &&
          node.parent?.type === "property_declaration"
            ? node.parent
            : node;
        const before = source.slice(
          Math.max(0, owner.startIndex - 4000),
          owner.startIndex,
        );
        const docs =
          before
            .match(/\/\*\*([^]*?)\*\/\s*$/)?.[1]
            ?.replace(/^\s*\* ?/gm, "")
            .trim() ?? "";
        const body =
          node.childForFieldName("body") ??
          node.namedChildren.find((n) =>
            ["class_body", "function_body", "block"].includes(n.type),
          );
        const signature = source
          .slice(
            owner.startIndex,
            Math.min(
              body?.startIndex ?? owner.endIndex,
              owner.startIndex + 500,
            ),
          )
          .trim()
          .split("\n")
          .slice(0, 4)
          .join("\n");
        symbols.push({
          name: name.text.replace(/`/g, ""),
          // Top-level and member properties can be navigated to from other files; locals cannot.
          kind:
            owner !== node &&
            ["class_body", "source_file"].includes(scope?.type ?? "")
              ? "property"
              : node.type.replace(/_declaration|_declarator/g, ""),
          path: file,
          line: name.startPosition.row,
          column: name.startPosition.column,
          endLine: node.endPosition.row,
          start: name.startIndex,
          end: name.endIndex,
          scopeStart: scope?.startIndex ?? 0,
          scopeEnd: scope?.endIndex ?? source.length,
          signature,
          documentation: docs,
          preview: source
            .slice(
              owner.startIndex,
              Math.min(owner.endIndex, owner.startIndex + 1800),
            )
            .split("\n")
            .slice(0, 20)
            .join("\n"),
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  }
  try {
    visit(tree.rootNode);
    return {
      path: file,
      packageName,
      imports,
      symbols,
      errors: tree.rootNode.hasError,
    };
  } finally {
    tree.delete();
  }
}
let chain = Promise.resolve();
parentPort?.on("message", ({ id, file, text }) => {
  chain = chain.then(async () => {
    try {
      parentPort?.postMessage({ id, result: await parse(file, text) });
    } catch (e) {
      parentPort?.postMessage({ id, error: String(e) });
    }
  });
});
