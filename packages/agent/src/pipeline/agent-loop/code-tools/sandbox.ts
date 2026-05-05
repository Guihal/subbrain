/**
 * Sandbox — best-effort isolation for LLM-generated code via Bun Worker.
 *
 * Access (whitelisted via Function params): fetch, JSON, Date, Math,
 * URL, URLSearchParams, TextEncoder/Decoder, console.
 * Blocked pre-execution (regex on transpiled JS): eval(), new Function, dynamic import().
 * Blocked at runtime (globals nulled before user code runs): Function, Bun, process, require.
 * Timeout 30s, output capped at 10KB.
 *
 * Not a hard security boundary. Hostile code can still escape via regex-bypass
 * obfuscation (globalThis['pr'+'ocess']), data exfiltration through fetch(), or
 * any Bun Worker global we haven't nuked. Real isolation needs a subprocess
 * sandbox — tracked as TODO, out of scope of this pass.
 */
import { CODE_TOOL_LIMITS, type CodeToolExecResult } from "./types";

const UNSAFE_PATTERNS: { re: RegExp; name: string }[] = [
  { re: /\beval\s*\(/, name: "eval()" },
  { re: /\bnew\s+Function\b/, name: "new Function" },
  { re: /\bimport\s*\(/, name: "dynamic import()" },
];

/**
 * Execute a code tool in an isolated Bun Worker.
 *
 * The tool code must export a default async function:
 *   export default async (input: string): Promise<string> => { ... }
 */
export async function executeSandboxed(code: string, input: string): Promise<CodeToolExecResult> {
  const start = Date.now();

  if (typeof Worker === "undefined") {
    throw new Error("sandbox_unavailable: Worker API not present");
  }

  // Tool code is written as TypeScript ("export default async (input: string) => …").
  // new Function() parses raw JS, so strip TS syntax via Bun.Transpiler first.
  let jsCode: string;
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
    jsCode = transpiler.transformSync(code);
  } catch (err) {
    return {
      success: false,
      error: `Transpile error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }

  // Reject unambiguous dangerous call patterns before handing to Worker.
  // Narrow regexes only — identifier-only matches (\bprocess\b etc.) would
  // break legitimate user code like `const process = "transform"`.
  for (const { re, name } of UNSAFE_PATTERNS) {
    if (re.test(jsCode)) {
      return {
        success: false,
        error: `sandbox: unsafe construct "${name}" detected; blocked pre-execution`,
        durationMs: Date.now() - start,
      };
    }
  }

  // Build the Function body as a plain string, then embed via JSON.stringify.
  // Using a nested template literal here breaks on any user code containing ` or ${…}
  // — the outer worker-script backticks terminate, and ${…} evaluates in worker scope.
  const factoryBody =
    `"use strict";\n` +
    `let Bun, process, require, globalThis, self, global;\n` +
    jsCode.replace(/export\s+default/g, "exports.default =");

  // Wrap user code in a worker script that:
  // 1. Blocks dangerous globals
  // 2. Defines the tool function
  // 3. Runs it with the input
  // 4. Posts the result back
  const workerScript = `
const __userModule = {};
(async () => {
  // Create __factory FIRST (uses Worker's own new Function, which we are about to nuke).
  // Body is JSON-encoded so user backticks/\${} survive intact.
  const __factory = new Function("exports", "fetch", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "JSON", "Date", "Math", "console", ${JSON.stringify(factoryBody)});
  // Now nuke the globals — user code runs next, so it cannot recreate via new Function.
  try { globalThis.Function = undefined; } catch {}
  try { globalThis.Bun = undefined; } catch {}
  try { globalThis.process = undefined; } catch {}
  try { globalThis.require = undefined; } catch {}
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
    const result = await runWorkerWithTimeout(workerScript, CODE_TOOL_LIMITS.TIMEOUT_MS);
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
