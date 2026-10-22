import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
/** Locate a launcher without executing it or starting a JVM. */
export async function findExecutable(
  command: string,
): Promise<string | undefined> {
  const directories =
    command.includes("/") || command.includes("\\")
      ? [""]
      : (process.env.PATH ?? "").split(path.delimiter);
  const extensions =
    process.platform === "win32" && !path.extname(command)
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of directories)
    for (const extension of extensions) {
      const file = path.resolve(directory, command + extension);
      try {
        await fs.access(file, constants.X_OK);
        if ((await fs.stat(file)).isFile()) return file;
      } catch {}
    }
}
