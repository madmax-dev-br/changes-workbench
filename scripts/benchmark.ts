import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Navigator } from "../src/host/navigation";
import { GitService } from "../src/host/git";
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "changes-bench-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const nav = new Navigator(root, path.resolve("dist"), path.resolve("assets"));
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Benchmark");
    git("config", "user.email", "bench@example.test");
    await fs.mkdir(path.join(root, "src"));
    for (let batch = 0; batch < 100; batch++)
      await Promise.all(
        Array.from({ length: 100 }, (_, i) => {
          const n = batch * 100 + i;
          return fs.writeFile(
            path.join(root, "src", `Type${n}.kt`),
            `package benchmark\n/** Benchmark declaration. */\nclass Type${n} { fun value() = ${n} }\n`,
          );
        }),
      );
    git("add", ".");
    git("commit", "-m", "10,000 source files");
    for (let n = 0; n < 500; n++)
      await fs.appendFile(
        path.join(root, "src", `Type${n}.kt`),
        "// Changed locally\n",
      );
    const memoryBefore = process.memoryUsage().rss;
    const start = performance.now();
    const changes = await new GitService(root).changes();
    const listingMs = performance.now() - start;
    const source =
      "package benchmark\nimport benchmark.Type4321\nfun use(input: Type4321) = input\n";
    const cold = performance.now();
    const result = await nav.resolve("Main.kt", source, 2, 18);
    const coldMs = performance.now() - cold;
    const timings: number[] = [];
    for (let n = 0; n < 30; n++) {
      const start = performance.now();
      await nav.resolve("Main.kt", source, 2, 18);
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const report = {
      date: new Date().toISOString(),
      platform: `${os.platform()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model,
      files: 10000,
      changed: changes.length,
      listMs: +listingMs.toFixed(2),
      coldNavigationMs: +coldMs.toFixed(2),
      warmP95Ms: +timings[Math.floor(timings.length * 0.95)].toFixed(2),
      rssDeltaMiB: +(
        (process.memoryUsage().rss - memoryBefore) /
        1048576
      ).toFixed(2),
      totalRssMiB: +(process.memoryUsage().rss / 1048576).toFixed(2),
      parsedFiles: nav.stats.parses,
      cacheHits: nav.stats.hits,
      candidates: result.candidates.length,
      scope:
        "Git + lightweight navigation worker; excludes VS Code, webview renderer and optional JVMs",
    };
    await fs.mkdir("docs", { recursive: true });
    await fs.writeFile(
      "docs/benchmark.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
    if (
      !result.candidates.length ||
      report.warmP95Ms >= 150 ||
      nav.stats.parses >= 10000
    )
      process.exitCode = 1;
  } finally {
    nav.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
