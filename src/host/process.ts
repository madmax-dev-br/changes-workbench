import { spawn } from "node:child_process";
export interface RunOptions {
  signal?: AbortSignal;
  input?: string;
  timeout?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}
export function run(
  command: string,
  args: string[],
  cwd: string,
  options: RunOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error("Cancelled"));
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out: Buffer[] = [],
      errors: Buffer[] = [],
      size = 0,
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(Buffer.concat(out));
    };
    const abort = () => {
      child.kill();
      finish(new Error("Cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${command}: timeout`));
    }, options.timeout ?? 15000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", finish);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 32 * 1024 * 1024)) {
        child.kill();
        finish(new Error("Result exceeds size limit"));
      } else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.reduce((n, b) => n + b.length, 0) < 16384) errors.push(chunk);
    });
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              Buffer.concat(errors).toString().trim() ||
                `${command} exited ${code}`,
            ),
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
export class Queue {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private limit = 2) {}
  async use<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit)
      await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
