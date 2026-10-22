import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const dir = path.resolve("docs/layout-review");
const port = Number(process.env.REVIEW_PORT ?? 8071);
await fs.mkdir(dir, { recursive: true });
try {
  await fs.access(path.join(dir, "approvals.json"));
} catch {
  await fs.writeFile(path.join(dir, "approvals.json"), "{}\n");
}
const read = async (file) =>
  JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const currentBuild = async () =>
  createHash("sha256")
    .update(await fs.readFile("dist/webview.js"))
    .update(await fs.readFile("dist/webview.css"))
    .digest("hex");
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      const manifest = await read("manifest.json"),
        approvals = await read("approvals.json"),
        build = await currentBuild();
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Changes Workbench · visual review</title><style>body{background:#171b21;color:#d9dee7;font:15px system-ui;margin:40px auto;max-width:1200px;padding:0 24px}h1{font-size:25px;font-weight:500}p{color:#99a3b4}article{border:1px solid #343d4a;border-radius:8px;padding:18px;margin:24px 0}header{display:flex;justify-content:space-between;gap:20px;align-items:center}img{width:100%;height:auto;margin-top:16px;border-radius:4px}label{color:#b6cbb9}input{margin-right:8px}small{color:#dba673}</style><h1>Changes Workbench · visual review</h1><p>Review each layout, then check the box yourself to approve it. New captures or UI changes invalidate the corresponding approval.</p>${manifest.screens
        .map((s) => {
          const stale = s.buildHash !== build;
          return `<article><header><strong>${escape(s.title)}</strong><label><input type="checkbox" data-id="${escape(s.id)}" data-fingerprint="${s.fingerprint}" ${!stale && approvals[s.id]?.fingerprint === s.fingerprint ? "checked" : ""} ${stale ? "disabled" : ""}>Approved by owner</label></header>${stale ? "<small>Layout changed. Capture this screen again before approval.</small>" : ""}<a href="/${s.file}"><img src="/${s.file}" alt="${escape(s.title)}"></a></article>`;
        })
        .join(
          "",
        )}<script>document.querySelectorAll('input').forEach(input=>input.addEventListener('change',async()=>{const r=await fetch('/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:input.dataset.id,fingerprint:input.dataset.fingerprint,approved:input.checked})});if(!r.ok){alert(await r.text());location.reload();}}));</script>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
      return;
    }
    if (req.method === "POST" && req.url === "/approve") {
      if (
        req.headers.origin !== `http://127.0.0.1:${port}` &&
        req.headers.origin !== `http://localhost:${port}`
      ) {
        res.writeHead(403);
        res.end("Invalid origin");
        return;
      }
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 4096) throw new Error("Request too large");
      }
      const input = JSON.parse(text),
        manifest = await read("manifest.json"),
        screen = manifest.screens.find((s) => s.id === input.id);
      if (
        !screen ||
        screen.fingerprint !== input.fingerprint ||
        screen.buildHash !== (await currentBuild())
      ) {
        res.writeHead(409);
        res.end("Capture changed; refresh before approving.");
        return;
      }
      const approvals = await read("approvals.json");
      if (input.approved === true)
        approvals[screen.id] = {
          fingerprint: screen.fingerprint,
          approvedAt: new Date().toISOString(),
        };
      else delete approvals[screen.id];
      await fs.writeFile(
        path.join(dir, "approvals.json"),
        JSON.stringify(approvals, null, 2) + "\n",
      );
      res.end("Saved");
      return;
    }
    if (
      req.method === "GET" &&
      /^\/shots\/[a-z0-9-]+\.png$/.test(req.url ?? "")
    ) {
      res.setHeader("Content-Type", "image/png");
      res.end(await fs.readFile(path.join(dir, req.url.slice(1))));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Owner visual review: http://127.0.0.1:${port}`),
);
