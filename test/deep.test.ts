import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeepManager, globToRegExp, sourceRoots } from "../src/host/deep";
test("deep analysis is explicit, syncs buffers and stops its owned server", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changes-deep-"));
  const server = path.join(root, "server.cjs"),
    trace = path.join(root, "trace.jsonl");
  await fs.writeFile(
    server,
    `
const fs=require('fs');let buffer=Buffer.alloc(0);const trace=${JSON.stringify(trace)};
const send=(id,result)=>{const json=JSON.stringify({jsonrpc:'2.0',id,result});process.stdout.write('Content-Length: '+Buffer.byteLength(json)+'\\r\\n\\r\\n'+json);};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);fs.appendFileSync(trace,JSON.stringify(message)+'\\n');if(message.method==='initialize')send(message.id,{capabilities:{definitionProvider:true,textDocumentSync:1}});else if(message.method==='textDocument/definition')send(message.id,[{uri:message.params.textDocument.uri,range:{start:{line:1,character:0},end:{line:1,character:5}}}]);else if(message.method==='shutdown')send(message.id,null);else if(message.method==='exit')process.exit(0);}});`,
  );
  const manager = new DeepManager(
    root,
    path.join(root, "storage"),
    () => ({ command: process.execPath, args: [server] }),
    () => {},
  );
  t.after(async () => {
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(manager.enabled, false);
  await assert.rejects(
    () => manager.navigate("kotlin", "Main.kt", "class Test", 0, 5),
    /disabled/,
  );
  manager.enable();
  const result = await manager.navigate(
    "kotlin",
    "Main.kt",
    "class Test",
    0,
    5,
  );
  assert.equal(result.confidence, "deep");
  await manager.navigate("kotlin", "Main.kt", "class Updated", 0, 5);
  await manager.stop();
  const events = (await fs.readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.method === "initialize").length, 1);
  assert.equal(
    events.find((e) => e.method === "textDocument/didChange").params
      .contentChanges[0].text,
    "class Updated",
  );
  assert.ok(events.some((e) => e.method === "shutdown"));
  assert.equal(manager.enabled, false);
});
test("missing server fails cleanly and remains stoppable", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "changes-deep-missing-"),
  );
  const manager = new DeepManager(
    root,
    root,
    () => ({ command: path.join(root, "missing"), args: [] }),
    () => {},
  );
  t.after(async () => {
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  manager.enable();
  await assert.rejects(() =>
    manager.navigate("java", "A.java", "class A {}", 0, 6),
  );
  await manager.stop();
  assert.equal(manager.enabled, false);
});
test("source roots follow build layouts and package declarations", async () => {
  const heads: Record<string, string> = {
    "lib/com/acme/Util.kt": "package com.acme\n",
    "Main.kt": "package app\n",
    "scripts/Tool.java": "// no package\nclass Tool {}\n",
  };
  const roots = await sourceRoots(
    "/repo",
    [
      "app/src/main/kotlin/dev/a/A.kt",
      "app/src/main/kotlin/dev/b/B.kt",
      "app/src/test/kotlin/dev/a/ATest.kt",
      "app/src/main/java/dev/c/C.java",
      ...Object.keys(heads),
    ],
    async (file) => heads[file],
  );
  assert.deepEqual(roots, [
    { path: ".", test: false },
    { path: "app/src/main/java", test: false },
    { path: "app/src/main/kotlin", test: false },
    { path: "app/src/test/kotlin", test: true },
    { path: "lib", test: false },
    { path: "scripts", test: false },
  ]);
});
test("watcher globs match LSP patterns", () => {
  assert.ok(globToRegExp("**/*.java").test("/repo/src/A.java"));
  assert.ok(!globToRegExp("**/*.java").test("/repo/src/A.kt"));
  assert.ok(
    globToRegExp("**/{pom.xml,*.gradle}").test("/repo/app/build.gradle"),
  );
  assert.ok(
    globToRegExp({
      baseUri: "file:///repo/app",
      pattern: "**/.classpath",
    }).test("/repo/app/.classpath"),
  );
  assert.ok(
    !globToRegExp({ baseUri: "file:///repo/app", pattern: "*.xml" }).test(
      "/repo/pom.xml",
    ),
  );
});
test("deep navigation waits for indexing and forwards watched files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changes-index-"));
  const server = path.join(root, "server.cjs"),
    trace = path.join(root, "trace.jsonl");
  await fs.writeFile(
    server,
    `
const fs=require('fs');let buffer=Buffer.alloc(0);const trace=${JSON.stringify(trace)};
const write=(m)=>{const json=JSON.stringify({jsonrpc:'2.0',...m});process.stdout.write('Content-Length: '+Buffer.byteLength(json)+'\\r\\n\\r\\n'+json);};
let ready=false;
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);fs.appendFileSync(trace,JSON.stringify(message)+'\\n');
if(message.method==='initialize')write({id:message.id,result:{capabilities:{definitionProvider:true,experimental:{workspaceImport:true}}}});
else if(message.method==='initialized'){write({id:99,method:'client/registerCapability',params:{registrations:[{id:'w',method:'workspace/didChangeWatchedFiles',registerOptions:{watchers:[{globPattern:'**/*.kt'}]}}]}});setTimeout(()=>{ready=true;write({method:'intellij/workspaceImportState',params:{phase:'FINISHED'}});},400);}
else if(message.method==='textDocument/definition')write({id:message.id,result:ready?[{uri:message.params.textDocument.uri,range:{start:{line:0,character:0},end:{line:0,character:1}}}]:[]});
else if(message.method==='shutdown')write({id:message.id,result:null});else if(message.method==='exit')process.exit(0);}});`,
  );
  await fs.writeFile(path.join(root, "Main.kt"), "package app\nclass Main\n");
  const statuses: string[] = [];
  const manager = new DeepManager(
    root,
    path.join(root, "storage"),
    () => ({ command: process.execPath, args: [server] }),
    (s) => statuses.push(s),
    1,
    () => {},
    async () => ["Main.kt"],
  );
  t.after(async () => {
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  manager.enable();
  const result = await manager.navigate(
    "kotlin",
    "Main.kt",
    "class Main",
    0,
    7,
  );
  assert.equal(result.confidence, "deep", "waited for the import to finish");
  assert.ok(statuses.some((s) => s.includes("kotlin indexing")));
  assert.ok(statuses.includes("Deep · kotlin ready"));
  manager.fileChanged(path.join(root, "New.kt"), 1);
  manager.fileChanged(path.join(root, "notes.txt"), 2);
  await new Promise((r) => setTimeout(r, 600));
  const events = (await fs.readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const init = events.find((e) => e.method === "initialize");
  assert.equal(init.params.capabilities.window.workDoneProgress, true);
  assert.equal(
    init.params.initializationOptions.projects[0].type,
    "json",
    "generated workspace for a repository without a build",
  );
  const workspace = JSON.parse(
    await fs.readFile(path.join(root, "storage/kotlin/workspace.json"), "utf8"),
  );
  assert.deepEqual(
    workspace.modules[0].contentRoots[0].sourceRoots.map((r: any) => r.path),
    [root],
  );
  const watched = events.filter(
    (e) => e.method === "workspace/didChangeWatchedFiles",
  );
  assert.equal(watched.length, 1);
  assert.deepEqual(
    watched[0].params.changes.map((c: any) => c.uri.split("/").at(-1)),
    ["New.kt"],
  );
});
test("navigation falls back with a note while the index is building", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changes-slow-"));
  const server = path.join(root, "server.cjs");
  await fs.writeFile(
    server,
    `let buffer=Buffer.alloc(0);const write=(m)=>{const json=JSON.stringify({jsonrpc:'2.0',...m});process.stdout.write('Content-Length: '+Buffer.byteLength(json)+'\\r\\n\\r\\n'+json);};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);
if(message.method==='initialize')write({id:message.id,result:{serverInfo:{name:'JDT Language Server'},capabilities:{definitionProvider:true}}});
else if(message.method==='shutdown')write({id:message.id,result:null});else if(message.method==='exit')process.exit(0);}});`,
  );
  const manager = new DeepManager(
    root,
    path.join(root, "storage"),
    () => ({ command: process.execPath, args: [server] }),
    () => {},
    1,
    () => {},
    async () => [],
    200,
  );
  t.after(async () => {
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  manager.enable();
  const result = await manager.navigate("java", "A.java", "class A {}", 0, 6);
  assert.equal(result.candidates.length, 0);
  assert.match(result.note ?? "", /java index is still building/);
});
