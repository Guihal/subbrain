import { initDeps } from "./app/deps";
import { createApp } from "./app/bootstrap";
import {
  installAutonomousScheduler,
  installNightCycleScheduler,
  installTelegramWebhook,
} from "./app/schedulers";
import { registerShutdown } from "./app/shutdown";

const deps = await initDeps();
const { app, nightCycleController } = createApp(deps);

// idleTimeout=255 (Bun max): night-cycle and slow agent loops can hold a
// connection without producing data for >10s (Bun default), which would
// otherwise be killed mid-handler with "Empty reply from server".
app.listen({ port: deps.config.port, idleTimeout: 255 });

console.log(`🧠 Subbrain proxy running on http://localhost:${deps.config.port}`);

installAutonomousScheduler(deps);
installNightCycleScheduler(deps, nightCycleController);
installTelegramWebhook(deps);
registerShutdown(deps);

// Re-exported so other modules (tests, tooling) can reach the configured bot.
export const telegramBot = deps.telegramBot;
