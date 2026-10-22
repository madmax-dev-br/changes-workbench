import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createFixture } from "./fixtures.mjs";
await fs.mkdir("test-results", { recursive: true });
const directory = path.resolve(".dev", `web-test-${Date.now()}`);
const fixture = await createFixture(directory);
const screenshots = path.resolve("docs/layout-review/shots");
await fs.mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const failures = [],
  checks = [];
page.on("pageerror", (e) => failures.push(String(e)));
const check = (name, fn) =>
  fn().then(() => {
    checks.push({ name, passed: true });
    console.log("PASS", name);
  });
async function command(name) {
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+a" : "Control+Shift+a",
  );
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible" });
  await input.fill(">" + name);
  await page.keyboard.press("Enter");
}
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out: " + label);
}
let frame;
try {
  await page.goto(
    `${process.env.WEB_URL ?? "http://127.0.0.1:8080"}/?folder=${encodeURIComponent(directory)}`,
  );
  await page
    .getByRole("button", { name: /Changes, Open Changes Workbench/ })
    .waitFor({ timeout: 60000 });
  await page
    .getByRole("button", { name: /Changes, Open Changes Workbench/ })
    .click();
  frame = await until(async () => {
    for (const f of page.frames()) {
      if (await f.locator(".workbench").count()) return f;
    }
  }, "extension webview");
  await until(
    async () =>
      await frame.getByRole("heading", { name: /Local changes 9/ }).count(),
    "nine changed files",
  );
  // Use the actual visibility of the native workbench parts; toolbar roles vary by VS Code version.
  if (await page.locator(".part.sidebar").isVisible())
    await command("View: Toggle Primary Side Bar Visibility");
  if (await page.locator(".part.auxiliarybar").isVisible())
    await command("View: Toggle Secondary Side Bar Visibility");
  const select = async (file) => {
    await frame.getByRole("textbox", { name: "Filter files" }).fill(file);
    await frame
      .getByRole("treeitem", { name: new RegExp(file.replace(".", "\\.")) })
      .click();
    await until(
      async () => !(await frame.locator(".loading-line").count()),
      "file loaded",
    );
  };
  await check("Changed files and compact tree load from real Git", async () => {
    assert.equal(
      await frame
        .getByRole("treeitem", { name: "app/src/main", exact: true })
        .count(),
      1,
    );
    assert.equal(await frame.locator(".error[role=alert]").count(), 0);
  });
  await select("CheckoutService.kt");
  await check("A single diff survives switching files", async () => {
    await frame.getByRole("textbox", { name: "Filter files" }).fill("");
    await frame.getByRole("button", { name: "Next file", exact: true }).click();
    await until(
      async () => !(await frame.locator(".loading-line").count()),
      "next file",
    );
    await select("CheckoutService.kt");
    assert.equal(await frame.locator(".monaco-diff-editor").count(), 1);
    assert.equal(await page.getByRole("tab", { name: /^Changes/ }).count(), 1);
  });
  await check(
    "Staged and unstaged comparisons use different bases",
    async () => {
      await frame.getByRole("tab", { name: "Staged", exact: true }).click();
      await until(
        async () =>
          (await frame
            .getByRole("tab", { name: "Staged", exact: true })
            .getAttribute("aria-selected")) === "true" &&
          !(await frame.locator(".loading-line").count()),
        "staged snapshot",
      );
      assert.ok(
        (await frame.locator(".comparison-label").innerText()).includes(
          "INDEX",
        ),
      );
      await frame.getByRole("tab", { name: "Unstaged", exact: true }).click();
      await until(
        async () =>
          (await frame
            .getByRole("tab", { name: "Unstaged", exact: true })
            .getAttribute("aria-selected")) === "true" &&
          !(await frame.locator(".loading-line").count()),
        "unstaged snapshot",
      );
      assert.ok(
        (await frame.locator(".comparison-label").innerText()).startsWith(
          "INDEX",
        ),
      );
      await frame
        .getByRole("tab", { name: "All changes", exact: true })
        .click();
      await until(
        async () => !(await frame.locator(".loading-line").count()),
        "all snapshot",
      );
    },
  );
  await check(
    "Reviewed state is invalidated by an external file change",
    async () => {
      await frame
        .getByRole("button", { name: "Mark reviewed", exact: true })
        .click();
      await frame
        .getByRole("button", { name: "Reviewed", exact: true })
        .waitFor();
      await fs.appendFile(
        path.join(directory, fixture.checkout),
        "\n// Review invalidation check\n",
      );
      await frame
        .getByRole("button", { name: "Mark reviewed", exact: true })
        .waitFor({ timeout: 15000 });
    },
  );
  await check("Unified diff and line blame annotations render", async () => {
    await frame.getByRole("button", { name: "Toggle unified diff" }).click();
    await until(
      async () =>
        await frame
          .getByRole("button", { name: "Toggle unified diff" })
          .getAttribute("class")
          .then((c) => c.includes("active")),
      "unified active",
    );
    await frame
      .getByRole("button", { name: "Toggle blame annotations" })
      .click();
    await frame.locator(".cw-blame-text").first().waitFor();
    await frame
      .getByRole("button", { name: "Toggle blame annotations" })
      .click();
    await frame.getByRole("button", { name: "Toggle unified diff" }).click();
  });
  await check(
    "Lightweight definition preview resolves an imported class",
    async () => {
      await frame
        .locator(".editor.modified .view-line")
        .filter({ hasText: "import dev.checkout.pricing.PriceCalculator" })
        .first()
        .click();
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+ArrowRight" : "End",
      );
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+b" : "Control+b",
      );
      await frame.locator(".definition-link").first().waitFor();
      assert.match(await frame.locator(".peek").innerText(), /PriceCalculator/);
      await frame
        .getByRole("button", { name: "Close definition preview" })
        .click();
    },
  );
  await check(
    "IntelliJ F7 and Alt+Right navigate the diff and files",
    async () => {
      await frame
        .locator(".editor.modified .view-line")
        .filter({hasText:"import dev.checkout.pricing.PriceCalculator"})
        .first()
        .click();
      await page.keyboard.press("F7");
      await until(
        async () =>
          !/Ln [1-6],/.test(await frame.locator(".line-position").innerText()),
        "F7 next difference",
      );
      const before = await frame.locator(".filepath").innerText();
      await frame.getByRole("textbox", { name: "Filter files" }).fill("");
      await frame
        .locator(".editor.modified .view-line")
        .filter({hasText:"import dev.checkout.pricing.PriceCalculator"})
        .first()
        .click();
      await page.keyboard.press("Alt+ArrowRight");
      await until(
        async () => (await frame.locator(".filepath").innerText()) !== before,
        "Alt+Right next file",
      );
      await select("CheckoutService.kt");
    },
  );
  await check("Clicking a gutter marker reveals original content", async () => {
    await frame.locator(".editor.modified .cw-modified").first().click();
    await frame.locator(".original-preview").waitFor();
    assert.match(
      await frame.locator(".original-preview").innerText(),
      /Original/,
    );
    await frame.getByRole("button", { name: "Close original preview" }).click();
  });
  await check(
    "Open native editor and return preserves the review",
    async () => {
      await frame.getByRole("button", { name: "Open in editor" }).click();
      await page.getByRole("tab", { name: /CheckoutService.kt/ }).waitFor();
      await page.getByRole("tab", { name: /^Changes/ }).click();
      frame = await until(async () => {
        for (const f of page.frames()) {
          if (await f.locator(".workbench").count()) return f;
        }
      }, "restored webview");
      await frame
        .getByRole("button", { name: "Mark reviewed", exact: true })
        .waitFor();
      assert.match(
        await frame.locator(".filepath").innerText(),
        /CheckoutService/,
      );
    },
  );
  await frame.getByRole("textbox", { name: "Filter files" }).fill("");
  const manifest = { generatedAt: new Date().toISOString(), screens: [] };
  const sizes = [
    { id: "small", width: 900, height: 650 },
    { id: "notebook", width: 1440, height: 900 },
    { id: "full-hd", width: 1920, height: 1080 },
  ];
  const buildHash = createHash("sha256")
    .update(await fs.readFile("dist/webview.js"))
    .update(await fs.readFile("dist/webview.css"))
    .digest("hex");
  for (const theme of ["dark", "darcula", "light"]) {
    await frame.getByRole("button", { name: "Theme", exact: true }).click();
    await page
      .locator(".quick-input-list")
      .getByText(`IntelliJ ${theme[0].toUpperCase() + theme.slice(1)}`, {
        exact: true,
      })
      .click();
    await until(
      async () => await frame.locator(`.workbench.${theme}`).count(),
      "theme " + theme,
    );
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await frame.locator(".diff-editor").waitFor();
      await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await frame.locator('.file-row.selected').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(screenshots, `${size.id}-${theme}.png`),
      });
      const metrics = await frame.evaluate(() => {
        const root = document
          .querySelector(".workbench")
          .getBoundingClientRect();
        const keys = [
          ".topbar",
          ".sidebar",
          ".review-area",
          ".filebar",
          ".diff-toolbar",
          "footer",
        ];
        return keys.map((selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return {
            selector,
            width: rect.width,
            height: rect.height,
            outside:
              rect.left < root.left - 1 ||
              rect.right > root.right + 1 ||
              rect.bottom > root.bottom + 1,
          };
        });
      });
      assert.ok(
        metrics.every((m) => !m.outside && m.width > 0 && m.height > 0),
        `layout bounds ${size.id}-${theme}`,
      );
      const file = `${size.id}-${theme}.png`;
      const imageHash = createHash("sha256")
        .update(await fs.readFile(path.join(screenshots, file)))
        .digest("hex");
      manifest.screens.push({
        id: `${size.id}-${theme}`,
        title: `Changes · ${size.width}×${size.height} · ${theme}`,
        file: `shots/${file}`,
        fingerprint: createHash("sha256")
          .update(buildHash + imageHash)
          .digest("hex"),
        buildHash,
        metrics,
      });
    }
  }
  await fs.writeFile(
    "docs/layout-review/manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
  assert.deepEqual(failures, [], "No uncaught browser errors");
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile(
    "test-results/web.json",
    JSON.stringify({ passed: true, checks, failures }, null, 2),
  );
  console.log(
    `Captured ${manifest.screens.length} layouts. Approval is pending the owner.`,
  );
} catch (error) {
  await page.screenshot({ path: "test-results/failure.png" }).catch(() => {});
  console.error(error);
  console.error("Browser errors:", failures);
  process.exitCode = 1;
} finally {
  await browser.close();
}
