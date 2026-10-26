import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  matchScore,
  parseDeclaration,
  rank,
  ripgrep,
  scanDeclarations,
  searchDeclarations,
  searchFiles,
  searchText,
} from "../src/host/search";

const rg = ripgrep(
  path.join(__dirname, "..", ".dev/cursor/Cursor.app/Contents/Resources/app"),
);
const hasRipgrep = existsSync(rg);

test("ranks like IntelliJ: exact, prefix, camel humps, then loose matches", () => {
  const names = [
    "CartRepositoryRemote",
    "CartRepository",
    "Cart",
    "RecentCartReader",
    "Checkout",
  ];
  assert.deepEqual(
    rank(names, "cart", (n) => n, 5),
    ["Cart", "CartRepository", "CartRepositoryRemote", "RecentCartReader"],
  );
  assert.deepEqual(
    rank(names, "CaRe", (n) => n, 2),
    ["CartRepository", "CartRepositoryRemote"],
  );
  assert.equal(matchScore("xyz", "Cart"), undefined);
  assert.deepEqual(
    rank(
      [
        "Changes: Choose IntelliJ Theme",
        "Changes: Open Workbench",
        "Theme: Choose",
      ],
      "choose theme",
      (n) => n,
      5,
    ).sort(),
    ["Changes: Choose IntelliJ Theme", "Theme: Choose"],
  );
  assert.ok(matchScore("crr", "CartRepositoryRemote")! > 0);
  // Letters scattered inside words do not match, as in IntelliJ.
  assert.equal(
    matchScore("PriCal", "Clone GitHub Pull Request in Container Volume"),
    undefined,
  );
  assert.ok(matchScore("ice", "PriceCalculator")! > 0);
});

test("finds files by name, or by path when the query has a slash", () => {
  const files = ["app/src/Cart.kt", "app/src/Checkout.kt", "docs/cart.md"];
  assert.deepEqual(
    searchFiles(files, "cart", 5)
      .map((h) => h.path)
      .sort(),
    ["app/src/Cart.kt", "docs/cart.md"],
  );
  assert.deepEqual(
    searchFiles(files, "src/check", 5).map((h) => [h.name, h.detail]),
    [["Checkout.kt", "app/src"]],
  );
});

test("reads declarations from ripgrep's only-matching output", () => {
  const parse = (text: string) => parseDeclaration(`a/B.kt\u000012:1:${text}`);
  assert.deepEqual(parse("    data class CartItem"), {
    name: "CartItem",
    keyword: "class",
    path: "a/B.kt",
    line: 11,
    column: 15,
    type: true,
  });
  assert.equal(parse("@Singleton internal object Store")?.name, "Store");
  assert.equal(parse("enum class Status")?.keyword, "class");
  assert.equal(parse("  suspend fun <T> List<T>.total(")?.name, "total");
  assert.equal(
    parse("  public static int calculateTotal(")?.name,
    "calculateTotal",
  );
  assert.equal(parse("func (s *Server) Start(")?.name, "Start");
  assert.equal(parse("export async function loadCart(")?.name, "loadCart");
  assert.equal(parse("// this class handles carts"), undefined);
});

test(
  "scans a repository for classes and functions, then searches text",
  { skip: !hasRipgrep },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "changes-search-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dir, "shop"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "shop/Cart.kt"),
      "package shop\n\n/** A class for carts. */\nclass CartRepository(val api: Api) {\n  fun calculateTotal(): Int = 0\n}\n",
    );
    await fs.writeFile(
      path.join(dir, "shop/Order.java"),
      "public class Order {\n  private int total = 0;\n  public int calculateTotal() { return total; }\n}\n",
    );
    const declarations = await scanDeclarations(rg, dir);
    assert.deepEqual(
      searchDeclarations(declarations, "CaRe", true, 5).map((h) => [
        h.name,
        h.detail,
        h.column,
      ]),
      [["CartRepository", "shop/Cart.kt:4", 6]],
    );
    assert.deepEqual(
      searchDeclarations(declarations, "calcTot", false, 5)
        .map((h) => h.detail)
        .sort(),
      ["shop/Cart.kt:5", "shop/Order.java:3"],
    );
    const text = await searchText(
      rg,
      dir,
      {
        query: "TOTAL",
        matchCase: false,
        words: true,
        regex: false,
        mask: "*.java",
      },
      100,
    );
    assert.deepEqual(
      text.hits.map((h) => [h.detail, h.ranges]),
      [
        ["shop/Order.java:2", [[14, 19]]],
        ["shop/Order.java:3", [[39, 44]]],
      ],
    );
    const regex = await searchText(
      rg,
      dir,
      {
        query: "calc\\w+\\(",
        matchCase: true,
        words: false,
        regex: true,
        mask: "",
      },
      1,
    );
    assert.equal(regex.hits.length, 1);
    assert.equal(regex.truncated, true);
    await assert.rejects(
      searchText(
        rg,
        dir,
        { query: "(", matchCase: false, words: false, regex: true, mask: "" },
        10,
      ),
      /regex|parse/i,
    );
  },
);
