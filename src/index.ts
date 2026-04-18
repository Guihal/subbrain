import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { createProviders } from "./providers";
import { authMiddleware } from "./lib/auth";
import { ModelRouter } from "./lib/model-router";
import { chatRoute } from "./routes/chat";
import { modelsRoute } from "./routes/models";
import { embeddingsRoute } from "./routes/embeddings";
import { logsRoute } from "./routes/logs";
import { autonomousRoute } from "./routes/autonomous";
import { MemoryDB } from "./db";
import { ToolExecutor, mcpRoute } from "./mcp";
import { RAGPipeline } from "./rag";
import {
  AgentPipeline,
  ArbitrationRoom,
  NightCycle,
  AgentLoop,
} from "./pipeline";
import { Metrics } from "./lib/metrics";
import { logger } from "./lib/logger";

const port = Number(process.env.PROXY_PORT) || 4000;
const authToken = process.env.PROXY_AUTH_TOKEN;
const dbPath = process.env.DB_PATH || "data/subbrain.db";

if (!authToken) {
  console.error("PROXY_AUTH_TOKEN is required");
  process.exit(1);
}

const providers = createProviders();
const router = new ModelRouter(providers);
const memory = new MemoryDB(dbPath);
logger.setMemory(memory);
const tools = new ToolExecutor(memory, router);
const rag = new RAGPipeline(memory, router);
tools.setRAG(rag);
const metrics = new Metrics({
  get currentLoad() {
    return router.stats.currentLoad;
  },
  get queueLength() {
    return router.stats.queueLength;
  },
  get availableSlots() {
    return router.stats.availableSlots;
  },
});
const pipeline = new AgentPipeline(memory, router, rag);
pipeline.setMetrics(metrics);
const room = new ArbitrationRoom(router);
room.setMetrics(metrics);
pipeline.setArbitrationRoom(room);
const nightCycle = new NightCycle(memory, router, rag);
const agentLoop = new AgentLoop(memory, router, rag, tools);
agentLoop.setMetrics(metrics);
agentLoop.setRoom(room);

const app = new Elysia()
  .use(staticPlugin({ assets: "public", prefix: "/" }))
  .decorate("memory", memory)
  .decorate("router", router)
  .decorate("tools", tools)
  .decorate("metrics", metrics)
  .decorate("nightCycle", nightCycle)
  .get("/health", ({ router }) => ({
    status: "ok",
    timestamp: Date.now(),
    rpm: router.stats,
  }))
  .get("/metrics", ({ metrics }) => metrics.snapshot())
  .post("/night-cycle", async ({ nightCycle }) => nightCycle.run())
  .use(authMiddleware(authToken))
  .use(chatRoute(router, pipeline))
  .use(modelsRoute(router))
  .use(embeddingsRoute(router))
  .use(logsRoute(memory))
  .use(mcpRoute(tools))
  .use(autonomousRoute(agentLoop))
  .listen(port);

console.log(`🧠 Subbrain proxy running on http://localhost:${port}`);
