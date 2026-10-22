import type { RequestMethod } from "../shared";
declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
  getState: () => any;
  setState: (value: any) => void;
};
export const vscode = acquireVsCodeApi();
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }
>();
window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "response") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  request.cleanup();
  message.error
    ? request.reject(new Error(message.error))
    : request.resolve(message.result);
});
export function request<T = any>(
  method: RequestMethod,
  params: Record<string, unknown> = {},
  version?: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled"));
    const id = ++nextId;
    const cancel = () => {
      vscode.postMessage({ type: "cancel", id });
      pending.delete(id);
      cleanup();
      reject(new Error("Cancelled"));
    };
    const timeout = setTimeout(() => {
      vscode.postMessage({ type: "cancel", id });
      pending.delete(id);
      cleanup();
      reject(new Error("Request timed out. Refresh and try again."));
    }, 75000);
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    };
    pending.set(id, { resolve, reject, cleanup });
    signal?.addEventListener("abort", cancel, { once: true });
    vscode.postMessage({ type: "request", id, method, params, version });
  });
}
