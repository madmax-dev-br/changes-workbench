import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DeepManager,
  cleanDocumentation,
  compareVersions,
  findKotlinStdlib,
  globToRegExp,
  sourceRoots,
} from "../src/host/deep";
import { displayPath } from "../src/shared";
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
test("missing server falls back with a note and remains stoppable", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "changes-deep-missing-"),
  );
  const statuses: string[] = [];
  const manager = new DeepManager(
    root,
    root,
    (language) => ({
      command:
        language === "java" ? path.join(root, "missing") : "/usr/bin/false",
      args: [],
    }),
    (s) => statuses.push(s),
  );
  t.after(async () => {
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  manager.enable();
  const result = await manager.navigate("java", "A.java", "class A {}", 0, 6);
  assert.equal(result.candidates.length, 0);
  assert.match(result.note ?? "", /No Java language server found/);
  assert.ok(!statuses.some((s) => /ENOENT|unavailable/.test(s)));
  // An installed launcher that fails still reports the failure.
  await assert.rejects(() =>
    manager.navigate("kotlin", "A.kt", "class A", 0, 6),
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
test("files opened during indexing are prioritized and watched files forwarded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changes-index-"));
  const server = path.join(root, "server.cjs"),
    trace = path.join(root, "trace.jsonl");
  // Like Kotlin LSP: before the import finishes, only files opened by the client resolve.
  await fs.writeFile(
    server,
    `
const fs=require('fs');let buffer=Buffer.alloc(0);const trace=${JSON.stringify(trace)};
const write=(m)=>{const json=JSON.stringify({jsonrpc:'2.0',...m});process.stdout.write('Content-Length: '+Buffer.byteLength(json)+'\\r\\n\\r\\n'+json);};
let ready=false;const open=new Set();
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);fs.appendFileSync(trace,JSON.stringify(message)+'\\n');
const target=message.params&&message.params.textDocument&&message.params.textDocument.uri.replace(/Main\\.kt$/,'Target.kt');
if(message.method==='initialize')write({id:message.id,result:{capabilities:{definitionProvider:true,experimental:{workspaceImport:true}}}});
else if(message.method==='initialized'){write({id:99,method:'client/registerCapability',params:{registrations:[{id:'w',method:'workspace/didChangeWatchedFiles',registerOptions:{watchers:[{globPattern:'**/*.kt'}]}}]}});setTimeout(()=>{ready=true;write({method:'intellij/workspaceImportState',params:{phase:'FINISHED'}});},1500);}
else if(message.method==='textDocument/didOpen')open.add(message.params.textDocument.uri);
else if(message.method==='textDocument/didClose')open.delete(message.params.textDocument.uri);
else if(message.method==='textDocument/definition')write({id:message.id,result:ready||open.has(target)?[{uri:target,range:{start:{line:1,character:6},end:{line:1,character:12}}}]:[]});
else if(message.method==='shutdown')write({id:message.id,result:null});else if(message.method==='exit')process.exit(0);}});`,
  );
  await fs.writeFile(
    path.join(root, "Main.kt"),
    "package app\nval t = Target()\n",
  );
  await fs.writeFile(
    path.join(root, "Target.kt"),
    "package app\nclass Target\n",
  );
  const statuses: string[] = [];
  const manager = new DeepManager(
    root,
    path.join(root, "storage"),
    () => ({ command: process.execPath, args: [server] }),
    (s) => statuses.push(s),
    1,
    () => {},
    async () => ["Main.kt", "Target.kt"],
    4000,
    async () => ({
      version: "2.1.21",
      classes: "/cache/kotlin-stdlib-2.1.21.jar",
      sources: "/cache/kotlin-stdlib-2.1.21-sources.jar",
    }),
  );
  t.after(async () => {
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const events = async () =>
    (await fs.readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  manager.enable();
  const text = "package app\nval t = Target()\n";
  const unresolved = await manager.navigate("kotlin", "Main.kt", text, 1, 10);
  assert.equal(unresolved.confidence, "none");
  assert.match(unresolved.note ?? "", /index is still building/);
  assert.ok(manager.indexing("kotlin"));
  const started = Date.now();
  const prioritized = await manager.navigate(
    "kotlin",
    "Main.kt",
    text,
    1,
    10,
    undefined,
    ["Target.kt", "Main.kt"],
  );
  assert.equal(
    prioritized.confidence,
    "deep",
    "resolved before the index finished",
  );
  assert.ok(prioritized.candidates[0].path.endsWith("/Target.kt"));
  assert.ok(Date.now() - started < 1000, "did not wait for the index");
  assert.ok(!statuses.includes("Deep · kotlin ready"));
  const trail = (await events()).map((e) =>
    e.method === "textDocument/didOpen"
      ? `open ${e.params.textDocument.uri.split("/").at(-1)}`
      : e.method,
  );
  assert.ok(
    trail.lastIndexOf("open Target.kt") <
      trail.lastIndexOf("textDocument/definition"),
  );
  assert.ok(
    trail.indexOf("initialized") <
      trail.findIndex((m) => m.startsWith("open ")),
    "documents are sent only after initialization",
  );
  for (let i = 0; i < 40 && manager.indexing("kotlin"); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(statuses.includes("Deep · kotlin ready"));
  assert.ok(statuses.some((s) => s.includes("kotlin indexing")));
  // A changed file stops overriding the disk, and watched changes are forwarded.
  manager.fileChanged(path.join(root, "Target.kt"), 2);
  manager.fileChanged(path.join(root, "New.kt"), 1);
  manager.fileChanged(path.join(root, "notes.txt"), 2);
  await new Promise((r) => setTimeout(r, 600));
  const all = await events();
  assert.ok(
    all.some(
      (e) =>
        e.method === "textDocument/didClose" &&
        e.params.textDocument.uri.endsWith("/Target.kt"),
    ),
  );
  const init = all.find((e) => e.method === "initialize");
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
  assert.deepEqual(workspace.libraries, [
    {
      name: "kotlin-stdlib:2.1.21",
      type: "COMPILE",
      roots: [
        { path: "/cache/kotlin-stdlib-2.1.21.jar" },
        { path: "/cache/kotlin-stdlib-2.1.21-sources.jar", type: "SOURCES" },
      ],
    },
  ]);
  assert.deepEqual(workspace.modules[0].dependencies, [
    { type: "moduleSource" },
    { type: "library", name: "kotlin-stdlib:2.1.21", scope: "compile" },
    { type: "inheritedSdk" },
  ]);
  const watched = all.filter(
    (e) => e.method === "workspace/didChangeWatchedFiles",
  );
  assert.equal(watched.length, 1);
  assert.deepEqual(
    watched[0].params.changes.map((c: any) => c.uri.split("/").at(-1)).sort(),
    ["New.kt", "Target.kt"],
  );
});
test("prioritized files are read only inside the repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changes-priority-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "changes-outside-"));
  const server = path.join(root, "server.cjs"),
    trace = path.join(root, "trace.jsonl");
  await fs.writeFile(
    server,
    `const fs=require('fs');let buffer=Buffer.alloc(0);const write=(m)=>{const json=JSON.stringify({jsonrpc:'2.0',...m});process.stdout.write('Content-Length: '+Buffer.byteLength(json)+'\\r\\n\\r\\n'+json);};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(message)+'\\n');
if(message.method==='initialize')write({id:message.id,result:{capabilities:{}}});else if(message.method==='shutdown')write({id:message.id,result:null});else if(message.method==='exit')process.exit(0);}});`,
  );
  await fs.writeFile(path.join(outside, "Secret.kt"), "class Secret\n");
  await fs.symlink(path.join(outside, "Secret.kt"), path.join(root, "Link.kt"));
  await fs.writeFile(path.join(root, "Ok.kt"), "class Ok\n");
  const manager = new DeepManager(
    root,
    path.join(root, "storage"),
    () => ({ command: process.execPath, args: [server] }),
    () => {},
    1,
    () => {},
    async () => ["Ok.kt"],
  );
  t.after(async () => {
    await manager.stop();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await manager.prioritize("kotlin", "Ok.kt");
  assert.equal(
    await fs.readFile(trace, "utf8").catch(() => ""),
    "",
    "nothing while disabled",
  );
  manager.enable();
  await manager.prioritize("kotlin", "Ok.kt");
  await manager.prioritize("kotlin", "Link.kt");
  await manager.prioritize("kotlin", "../outside.kt");
  await new Promise((r) => setTimeout(r, 200));
  const opened = (await fs.readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.method === "textDocument/didOpen")
    .map((e) => e.params.textDocument.uri.split("/").at(-1));
  assert.deepEqual(opened, ["Ok.kt"]);
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
test("server hover markdown becomes plain documentation", () => {
  assert.equal(
    cleanDocumentation(
      "Returns a greeting.\n````kotlin\nfun greeting(): String\n````\n",
    ),
    "Returns a greeting.",
  );
  assert.equal(
    cleanDocumentation("````kotlin\nfun cents(value: Double): Double\n````\n"),
    "",
  );
  assert.equal(
    cleanDocumentation(
      "String Demo.greeting()\n\nReturns a greeting.\n\nSource: *[changes-test](file:///repo/src/Demo.java#3)*",
      "String Demo.greeting()",
    ),
    "Returns a greeting.\n\nSource: changes-test",
  );
});
test("definition paths display relative to the repository", () => {
  assert.equal(
    displayPath("file:///Users/me/My%20Repo/app/src/A.kt", "/Users/me/My Repo"),
    "app/src/A.kt",
  );
  assert.equal(displayPath("app/src/A.kt", "/Users/me/repo"), "app/src/A.kt");
  assert.equal(
    displayPath("file:///opt/jdk/src/String.java", "/Users/me/repo"),
    "/opt/jdk/src/String.java",
  );
  assert.equal(
    displayPath("file:///C:/work/repo/A.java", "C:\\work\\repo"),
    "A.java",
  );
  assert.equal(
    displayPath("jar:file:///lib.jar!/A.class", "/repo"),
    "jar:file:///lib.jar!/A.class",
  );
});
test("kotlin-stdlib is found in the Gradle and Maven caches or KOTLIN_HOME", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "changes-stdlib-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const put = async (file: string) => {
    await fs.mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await fs.writeFile(path.join(home, file), "");
  };
  assert.equal(await findKotlinStdlib({}, home), undefined);
  await put("kotlin/lib/kotlin-stdlib.jar");
  assert.deepEqual(
    await findKotlinStdlib({ KOTLIN_HOME: path.join(home, "kotlin") }, home),
    {
      version: "KOTLIN_HOME",
      classes: path.join(home, "kotlin/lib/kotlin-stdlib.jar"),
      sources: undefined,
    },
  );
  const gradle =
    ".gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/";
  await put(gradle + "1.9.20/a1/kotlin-stdlib-1.9.20.jar");
  await put(gradle + "2.1.21/b2/kotlin-stdlib-2.1.21.jar");
  await put(gradle + "2.1.21/c3/kotlin-stdlib-2.1.21-sources.jar");
  await put(gradle + "2.2.0-RC/d4/kotlin-stdlib-2.2.0-RC.jar");
  await put(
    ".m2/repository/org/jetbrains/kotlin/kotlin-stdlib/2.0.0/kotlin-stdlib-2.0.0.jar",
  );
  assert.deepEqual(
    await findKotlinStdlib({ KOTLIN_HOME: path.join(home, "kotlin") }, home),
    {
      version: "2.2.0-RC",
      classes: path.join(
        home,
        gradle,
        "2.2.0-RC/d4/kotlin-stdlib-2.2.0-RC.jar",
      ),
      sources: undefined,
    },
    "the newest cached version wins over KOTLIN_HOME",
  );
  await put(gradle + "2.2.0/e5/kotlin-stdlib-2.2.0.jar");
  await put(gradle + "2.2.0/f6/kotlin-stdlib-2.2.0-sources.jar");
  assert.deepEqual(await findKotlinStdlib({}, home), {
    version: "2.2.0",
    classes: path.join(home, gradle, "2.2.0/e5/kotlin-stdlib-2.2.0.jar"),
    sources: path.join(
      home,
      gradle,
      "2.2.0/f6/kotlin-stdlib-2.2.0-sources.jar",
    ),
  });
  const custom = path.join(home, "custom-gradle");
  await fs.mkdir(
    path.join(
      custom,
      "caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/1.8.0/x",
    ),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      custom,
      "caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/1.8.0/x/kotlin-stdlib-1.8.0.jar",
    ),
    "",
  );
  assert.equal(
    (
      await findKotlinStdlib(
        { GRADLE_USER_HOME: custom },
        path.join(home, "nowhere"),
      )
    )?.version,
    "1.8.0",
  );
});
test("versions compare numerically with pre-releases first", () => {
  assert.ok(compareVersions("2.1.21", "2.1.3") > 0);
  assert.ok(compareVersions("2.2.0-RC", "2.2.0") < 0);
  assert.ok(compareVersions("2.2.0-RC", "2.1.21") > 0);
  assert.equal(compareVersions("1.9", "1.9.0"), 0);
});
test("library locations are decompiled by a server that supports it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changes-decompile-"));
  const server = (commands: string[]) =>
    `let buffer=Buffer.alloc(0);const write=(m)=>{const json=JSON.stringify({jsonrpc:'2.0',...m});process.stdout.write('Content-Length: '+Buffer.byteLength(json)+'\\r\\n\\r\\n'+json);};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=+buffer.subarray(0,end).toString().match(/Content-Length: (\\d+)/i)[1];if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);
if(message.method==='initialize')write({id:message.id,result:{capabilities:{executeCommandProvider:{commands:${JSON.stringify(commands)}}}}});
else if(message.method==='workspace/executeCommand')write({id:message.id,result:{code:'// '+message.params.arguments[0],language:'kotlin'}});
else if(message.method==='shutdown')write({id:message.id,result:null});else if(message.method==='exit')process.exit(0);}});`;
  await fs.writeFile(path.join(root, "with.cjs"), server(["decompile"]));
  await fs.writeFile(path.join(root, "without.cjs"), server([]));
  const make = (script: string) =>
    new DeepManager(
      root,
      path.join(root, "storage-" + script),
      () => ({ command: process.execPath, args: [path.join(root, script)] }),
      () => {},
      1,
      () => {},
      async () => ["A.kt"],
      4000,
      async () => undefined,
    );
  const capable = make("with.cjs"),
    plain = make("without.cjs");
  t.after(async () => {
    await capable.stop();
    await plain.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const uri =
    "jar:///cache/kotlin-stdlib.jar!/kotlin/collections/CollectionsKt.class";
  assert.equal(await capable.decompile(uri), undefined, "no server running");
  capable.enable();
  plain.enable();
  await capable.prioritize("kotlin", "A.kt", "class A");
  await plain.prioritize("kotlin", "A.kt", "class A");
  assert.deepEqual(await capable.decompile(uri), {
    code: `// ${uri}`,
    language: "kotlin",
  });
  assert.equal(await plain.decompile(uri), undefined);
});
