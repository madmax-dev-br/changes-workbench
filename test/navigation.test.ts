import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
