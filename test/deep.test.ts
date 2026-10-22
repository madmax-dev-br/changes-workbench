import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeepManager } from "../src/host/deep";
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
