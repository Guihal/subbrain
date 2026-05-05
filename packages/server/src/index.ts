import { installFreeAgentScheduler } from "@subbrain/agent/scheduler/free-agent";
import { initTelemetry } from "@subbrain/core/lib/telemetry";
import { createApp } from "./app/bootstrap";
import { initDeps } from "./app/deps";
import {
  installAutonomousScheduler,
  installFreelanceScoutScheduler,
  installNightCycleScheduler,
  installTelegramPoller,
  installTelegramWebhook,
} from "./app/schedulers";
import { registerShutdown } from "./app/shutdown";

initTelemetry();
const deps = await initDeps();
const { app, nightCycleController } = createApp(deps);

// idleTimeout=255 (Bun max): night-cycle and slow agent loops can hold a
// connection without producing data for >10s (Bun default), which would
// otherwise be killed mid-handler with "Empty reply from server".
app.listen({ port: deps.config.port, idleTimeout: 255 });

const autonomous = installAutonomousScheduler(deps);
installNightCycleScheduler(deps, nightCycleController);
installTelegramWebhook(deps);
installTelegramPoller(deps);
installFreelanceScoutScheduler(deps);
const freeAgent = installFreeAgentScheduler(deps);
registerShutdown(deps, [autonomous, freeAgent]);

// Re-exported so other modules (tests, tooling) can reach the configured bot.
export const telegramBot = deps.telegramBot;
