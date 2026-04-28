/**
 * Re-points selected virtual roles (`teamlead`, `coder`) to `gpt-5.4-mini`
 * via the openai-compat provider when `OPENAI_COMPAT_ENABLED=true`.
 * Idempotent and reversible: a WeakMap snapshot of the original route is
 * restored when the flag is off.
 *
 * Called once at bootstrap (`src/app/deps.ts`) BEFORE `createProviders()` so
 * `collectRequiredProviders()` sees `openai-compat` and instantiates the real
 * provider rather than the absent stub.
 */
import { MODEL_MAP, type ModelRoute } from "../model-map";

const ORIGINAL_ROUTES = new WeakMap<
  Record<string, ModelRoute>,
  Partial<Record<string, ModelRoute>>
>();

export function applyOpenAICompatOverrides(
  map: Record<string, ModelRoute> = MODEL_MAP,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const enabled = env.OPENAI_COMPAT_ENABLED === "true";
  let snapshots = ORIGINAL_ROUTES.get(map);
  if (!snapshots) {
    snapshots = {};
    ORIGINAL_ROUTES.set(map, snapshots);
  }

  for (const role of ["teamlead", "coder"] as const) {
    const cur = map[role];
    if (!cur) continue;
    if (enabled) {
      if (cur.primaryProvider === "openai-compat") continue;
      if (!cur.primaryProvider) {
        throw new Error(
          `applyOpenAICompatOverrides: role "${role}" has no primaryProvider`,
        );
      }
      snapshots[role] = { ...cur };
      map[role] = {
        primary: "gpt-5.4-mini",
        primaryProvider: "openai-compat",
        fallback: cur.primary,
        fallbackProvider: cur.primaryProvider,
      };
    } else if (snapshots[role]) {
      map[role] = snapshots[role]!;
      delete snapshots[role];
    }
  }
}
