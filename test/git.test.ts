import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitService, parseStatus, type Buffers } from "../src/host/git";
import { ReviewStore } from "../src/host/reviews";
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changes-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.name", "Test Author");
  git("config", "user.email", "test@example.test");
  return { root, git };
}
test("local, staged, unstaged and unsaved snapshots have distinct, correct bases", async (t) => {
  const { root, git } = await repo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const buffers: Buffers = new Map();
  const service = new GitService(root, () => buffers);
  await fs.writeFile(path.join(root, "Test.kt"), "fun value() = 1\n");
  git("add", ".");
  git("commit", "-m", "base");
  await fs.writeFile(path.join(root, "Test.kt"), "fun value() = 2\n");
  git("add", ".");
  await fs.writeFile(path.join(root, "Test.kt"), "fun value() = 3\n");
  buffers.set(path.join(root, "Test.kt"), {
    text: "fun value() = 4\n",
    version: 1,
  });
  const all = await service.snapshot("Test.kt");
  assert.equal(all.original, "fun value() = 1\n");
  assert.equal(all.current, "fun value() = 4\n");
  const staged = await service.snapshot("Test.kt", "staged");
  assert.equal(staged.current, "fun value() = 2\n");
  const unstaged = await service.snapshot("Test.kt", "unstaged");
  assert.equal(unstaged.original, "fun value() = 2\n");
  assert.equal(unstaged.current, all.current);
  assert.equal((await service.changes())[0].dirty, true);
});
test("new, deleted, renamed, binary and unusual paths are preserved", async (t) => {
  const { root, git } = await repo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of ["old name.kt", "delete.java", "binary.dat"])
    await fs.writeFile(
      path.join(root, file),
      file === "binary.dat" ? Buffer.from([1, 0, 2]) : "class Example {}\n",
    );
  git("add", ".");
  git("commit", "-m", "base");
  git("mv", "old name.kt", "new name.kt");
  await fs.unlink(path.join(root, "delete.java"));
  const unusual = "new\n[weird] ü.kt";
  await fs.writeFile(path.join(root, unusual), "fun added() = true\n");
  await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([2, 0, 3]));
  const service = new GitService(root);
  const changes = await service.changes();
  assert.equal(
    changes.find((c) => c.path === "new name.kt")?.oldPath,
    "old name.kt",
  );
  assert.equal(changes.find((c) => c.path === unusual)?.status, "?");
  assert.equal((await service.snapshot("delete.java")).current, "");
  assert.equal(
    (await service.snapshot("new name.kt")).original,
    "class Example {}\n",
  );
  assert.equal((await service.snapshot("binary.dat")).binary, true);
  assert.equal((await service.snapshot(unusual)).original, "");
  assert.equal((await service.snapshot(unusual, "unstaged")).original, "");
  git("add", "--", unusual);
  assert.equal(
    (await service.snapshot(unusual, "staged")).current,
    "fun added() = true\n",
  );
  git("commit", "-m", "commit unusual filename");
  await fs.writeFile(path.join(root, unusual), "fun added() = false\n");
  assert.equal(
    (await service.snapshot(unusual)).original,
    "fun added() = true\n",
  );
});
test("unborn repository and untracked blame are supported", async (t) => {
  const { root } = await repo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "new.kt"), "val number = 1\n");
  const git = new GitService(root);
  const snapshot = await git.snapshot("new.kt");
  assert.equal(snapshot.original, "");
  assert.equal(snapshot.current, "val number = 1\n");
  assert.ok(
    (await git.blame("new.kt", snapshot.current)).every((l) => l.local),
  );
});
test("blame maps committed and unsaved lines without claiming authorship", async (t) => {
  const { root, git } = await repo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "Test.kt"), "val one = 1\nval two = 2\n");
  git("add", ".");
  git("commit", "-m", "numbers");
  const service = new GitService(root);
  const blame = await service.blame("Test.kt", "val one = 1\nval two = 20\n");
  assert.equal(blame[0].author, "Test Author");
  assert.equal(blame[0].local, false);
  assert.equal(blame[1].local, true);
});
test("review fingerprint changes after content or base changes", async (t) => {
  const { root, git } = await repo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "a.kt"), "val x = 1\n");
  git("add", ".");
  git("commit", "-m", "base");
  await fs.writeFile(path.join(root, "a.kt"), "val x = 2\n");
  const service = new GitService(root);
  const a = await service.snapshot("a.kt");
  const store = new ReviewStore({}, async () => {});
  await store.toggle(root, "all", "a.kt", a.fingerprint);
  assert.equal(store.matches(root, "all", "a.kt", a.fingerprint), true);
  await fs.writeFile(path.join(root, "a.kt"), "val x = 3\n");
  const b = await service.snapshot("a.kt");
  assert.equal(store.matches(root, "all", "a.kt", b.fingerprint), false);
  git("add", ".");
  git("commit", "-m", "new base");
  assert.notEqual((await service.snapshot("a.kt")).fingerprint, b.fingerprint);
});
test("path traversal and invalid commit requests are rejected", async (t) => {
  const { root } = await repo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = new GitService(root);
  await assert.rejects(() => git.snapshot("../outside.kt"), /outside/);
  await assert.rejects(
    () => git.commitSnapshot("--all", "test.kt"),
    /Invalid commit/,
  );
});
test("merge conflict remains visible in each scope", async (t) => {
  const { root, git } = await repo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "conflict.kt"), "val x = 1\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "other");
  await fs.writeFile(path.join(root, "conflict.kt"), "val x = 2\n");
  git("commit", "-am", "other");
  git("checkout", "main");
  await fs.writeFile(path.join(root, "conflict.kt"), "val x = 3\n");
  git("commit", "-am", "main");
  try {
    git("merge", "other");
  } catch {}
  const service = new GitService(root);
  assert.equal((await service.changes())[0].status, "U");
  for (const scope of ["all", "staged", "unstaged"] as const) {
    const snap = await service.snapshot("conflict.kt", scope);
    assert.equal(snap.conflicted, true);
    assert.match(snap.current, /<<<<<<< HEAD/);
  }
});
test("large working file returns a bounded explanatory state", async (t) => {
  const { root } = await repo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "large.kt"), "x".repeat(6 * 1024 * 1024));
  const snap = await new GitService(root).snapshot("large.kt");
  assert.equal(snap.tooLarge, true);
  assert.equal(snap.current, "");
});
