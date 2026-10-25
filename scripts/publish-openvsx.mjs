// Publish changes-workbench.vsix to Open VSX with the token from .env (OVSX_PAT).
// ovsx reads OVSX_PAT from the environment, so the token never appears in arguments or output.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.OVSX_PAT?.trim()) {
  console.error(
    "Set OVSX_PAT in .env (open-vsx.org › Settings › Access Tokens). See .env.example.",
  );
  process.exit(1);
}
const { publisher, name, version } = JSON.parse(
  fs.readFileSync("package.json", "utf8"),
);
const ovsx = (...args) =>
  execFileSync("npx", ["--yes", "ovsx@1.2.0", ...args], {
    stdio: "inherit",
    env: process.env,
  });
const namespace = await fetch(`https://open-vsx.org/api/${publisher}`);
if (namespace.status === 404) {
  console.log(`Creating the ${publisher} namespace on Open VSX…`);
  ovsx("create-namespace", publisher);
}
ovsx("publish", `${name}.vsix`);
console.log(`Published https://open-vsx.org/extension/${publisher}/${name} (${version})`);
