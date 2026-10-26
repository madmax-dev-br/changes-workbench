import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Navigator } from "../src/host/navigation";
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changes-nav-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  const nav = new Navigator(root, path.resolve("dist"), path.resolve("assets"));
  return { root, nav };
}
test("parses Kotlin scopes and resolves parameters without enumerating workspace", async (t) => {
  const { root, nav } = await setup();
  t.after(async () => {
    nav.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const source =
    "package demo\nclass Greeter {\n fun greet(name: String): String {\n  val message = name\n  return message\n }\n}\n";
  const parsed = await nav.parse("Greeter.kt", source);
  assert.ok(parsed.symbols.some((s) => s.name === "greet"));
  const result = await nav.resolve("Greeter.kt", source, 4, 10);
  assert.equal(result.candidates[0].name, "message");
  assert.equal(result.confidence, "local");
  assert.equal(nav.stats.filesListed, 0);
  await nav.parse("Greeter.kt", source);
  assert.ok(nav.stats.hits >= 1);
});
test("Java imports and aliased Kotlin imports navigate across files", async (t) => {
  const { root, nav } = await setup();
  t.after(async () => {
    nav.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "models"));
  await fs.writeFile(
    path.join(root, "models/User.java"),
    "package demo.models;\n/** The account owner. */\npublic class User { public String name; }",
  );
  const source =
    "package demo\nimport demo.models.User as Person\nfun show(user: Person) = user\n";
  const result = await nav.resolve("Main.kt", source, 2, 17);
  assert.equal(result.confidence, "import");
  assert.equal(result.candidates[0].name, "User");
  assert.equal(result.candidates[0].path, "models/User.java");
});
test("overloads and member accesses stay candidates instead of false certainty", async (t) => {
  const { root, nav } = await setup();
  t.after(async () => {
    nav.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const source =
    "fun greet(x: Int) = x\nfun greet(x: String) = x\nfun main() { greet(1) }\n";
  const result = await nav.resolve("Main.kt", source, 2, 15);
  assert.equal(result.confidence, "candidate");
  assert.equal(result.candidates.length, 2);
  const member = await nav.resolve(
    "Main.kt",
    source + "fun test(other: Any) = other.greet(1)\n",
    3,
    30,
  );
  assert.notEqual(member.confidence, "local");
});
test("edited buffers invalidate parser cache and cancellation is respected", async (t) => {
  const { root, nav } = await setup();
  t.after(async () => {
    nav.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const a = await nav.parse("Main.kt", "class First");
  const b = await nav.parse("Main.kt", "class Second");
  assert.equal(a.symbols[0].name, "First");
  assert.equal(b.symbols[0].name, "Second");
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    () => nav.resolve("Main.kt", "class Third", 0, 8, abort.signal),
    /Cancelled/,
  );
});
test("imported files are found by name and package path", async (t) => {
  const { root, nav } = await setup();
  t.after(async () => {
    nav.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const put = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  await put(
    "src/main/kotlin/shop/model/Order.kt",
    "package shop.model\nclass Order\n",
  );
  await put("src/main/kotlin/other/Order.kt", "package other\nclass Order\n");
  await put(
    "src/main/java/shop/pay/Gateway.java",
    "package shop.pay;\npublic interface Gateway {}\n",
  );
  await put("src/main/kotlin/shop/Unused.kt", "package shop\nclass Unused\n");
  const source =
    "package shop.service\n\nimport shop.model.Order\nimport shop.pay.Gateway\nimport shop.util.*\nimport kotlin.math.max\n\nclass Service(val g: Gateway) { fun run(o: Order) = o }\n";
  assert.deepEqual(
    (
      await nav.importedFiles("src/main/kotlin/shop/service/Service.kt", source)
    ).sort(),
    [
      "src/main/java/shop/pay/Gateway.java",
      "src/main/kotlin/shop/model/Order.kt",
    ],
  );
});
test("related files cover targets, imports and packages in priority order", async (t) => {
  const { root, nav } = await setup();
  t.after(async () => {
    nav.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const put = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  const k = "src/main/kotlin/shop/";
  await put(k + "model/Order.kt", "package shop.model\nclass Order\n");
  await put(
    k + "pricing/Calculator.kt",
    "package shop.pricing\nimport shop.tax.Tax\nclass Calculator(val tax: Tax, val p: Policy)\n",
  );
  await put(
    k + "pricing/Policy.kt",
    "package shop.pricing\ninterface Policy\n",
  );
  await put(k + "tax/Tax.kt", "package shop.tax\nclass Tax\n");
  await put(k + "service/Helper.kt", "package shop.service\nclass Helper\n");
  const source =
    "package shop.service\nimport shop.model.Order\nclass Service { fun run(o: Order) = o }\n";
  await put(k + "service/Service.kt", source);
  const related = await nav.relatedFiles(k + "service/Service.kt", source, [
    k + "pricing/Calculator.kt",
    "file:///elsewhere/Lib.kt",
  ]);
  assert.deepEqual(related, [
    k + "pricing/Calculator.kt",
    k + "model/Order.kt",
    k + "service/Helper.kt",
    k + "tax/Tax.kt",
    k + "pricing/Policy.kt",
  ]);
});
test("member calls resolve to imported or same-package extension functions and properties", async (t) => {
  const { root, nav } = await setup();
  t.after(async () => {
    nav.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const rg = path.resolve(
    ".dev/cursor/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
  );
  if (existsSync(rg)) nav.ripgrep = rg;
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  await write(
    "core/src/demo/util/Money.kt",
    // The KDoc right after the package line once leaked into the package name.
    'package demo.util\n\n/** Formats an amount as money. */\nfun Double.toMoney(): String = "$" + this\n\nval String.initials: String get() = take(1)\n',
  );
  await write(
    "app/src/demo/app/Local.kt",
    "package demo.app\n\nfun Int.padded() = toString().padStart(3, '0')\n",
  );
  // A widely used extension: callers in the same folder must not crowd out its declaration.
  for (let i = 0; i < 40; i++)
    await write(
      `app/src/demo/app/Screen${i}.kt`,
      `package demo.app\n\nimport demo.util.toMoney\n\nfun screen${i}(v: Double) = v.toMoney()\n`,
    );
  const source =
    "package demo.app\n\nimport demo.util.toMoney\nimport demo.util.initials\n\nfun show(total: Double, name: String) {\n    println(total.toMoney() + name.initials + 7.padded())\n}\n";
  const line = source.split("\n")[6];
  for (const [word, target] of [
    ["toMoney", "core/src/demo/util/Money.kt:3"],
    ["initials", "core/src/demo/util/Money.kt:5"],
    ["padded", "app/src/demo/app/Local.kt:2"],
  ]) {
    const result = await nav.resolve(
      "app/src/demo/app/Show.kt",
      source,
      6,
      line.indexOf(word) + 1,
    );
    assert.equal(result.confidence, "import", word);
    assert.deepEqual(
      result.candidates.map((c) => `${c.path}:${c.line}`),
      [target],
      word,
    );
  }
});
