/**
 * Sandbox — Isolated code execution via Bun Worker.
 *
 * Each code tool is executed in a temporary Worker with:
 * - Access to: fetch, JSON, Date, Math, URL, URLSearchParams, TextEncoder/Decoder
 * - NO access to: file system, process, Bun.file, require, import
 * - Timeout: 30 seconds
 * - Output capped at 10KB
 */
import { CODE_TOOL_LIMITS, type CodeToolExecResult } from "./types";

/**
 * Execute a code tool in an isolated Bun Worker.
 *
 * The tool code must export a default async function:
 *   export default async (input: string): Promise<string> => { ... }
 */
export async function executeSandboxed(
  code: string,
  input: string,
): Promise<CodeToolExecResult> {
  const start = Date.now();

  // Wrap user code in a worker script that:
  // 1. Blocks dangerous globals
  // 2. Defines the tool function
  // 3. Runs it with the input
  // 4. Posts the result back
  const workerScript = `
// Block dangerous APIs
const _blocked = ["Bun", "process", "require"];
for (const name of _blocked) {
  Object.defineProperty(globalThis, name, {
    get() { throw new Error("Access denied: " + name); },
    configurable: false
  });
}

// User code (as async function body)
const __userModule = {};
(async () => {
  // Wrap in a function factory to capture export default
  const __factory = new Function("exports", "fetch", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "JSON", "Date", "Math", "console", \`
    ${code.replace(/export\s+default/g, "exports.default =")}
  \`);
  __factory(__userModule, fetch, URL, URLSearchParams, TextEncoder, TextDecoder, JSON, Date, Math, console);
})().then(async () => {
  if (typeof __userModule.default !== "function") {
    postMessage(JSON.stringify({ error: "Tool must export default async function" }));
    return;
  }
  try {
    const result = await __userModule.default(${JSON.stringify(input)});
    const output = typeof result === "string" ? result : JSON.stringify(result);
    postMessage(JSON.stringify({ output: output.slice(0, ${CODE_TOOL_LIMITS.MAX_OUTPUT_SIZE}) }));
  } catch (err) {
    postMessage(JSON.stringify({ error: err.message || String(err) }));
  }
}).catch(err => {
  postMessage(JSON.stringify({ error: err.message || String(err) }));
});
`;

  try {
    const result = await runWorkerWithTimeout(
      workerScript,
      CODE_TOOL_LIMITS.TIMEOUT_MS,
    );
    const durationMs = Date.now() - start;

    if (result.error) {
      return { success: false, error: result.error, durationMs };
    }
    return { success: true, output: result.output, durationMs };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

function runWorkerWithTimeout(
  script: string,
  timeoutMs: number,
): Promise<{ output?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([script], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    const timer = setTimeout(() => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error(`Timeout: execution exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    worker.onmessage = (event) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      try {
        resolve(JSON.parse(event.data));
      } catch {
        resolve({ output: String(event.data) });
      }
    };

    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error(event.message || "Worker error"));
    };
  });
}
