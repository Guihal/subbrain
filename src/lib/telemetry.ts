import { type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { logger } from "./logger";

let sdkInitialized = false;
let sdkInstance: NodeSDK | null = null;

export function getTracer(): Tracer {
  return trace.getTracer("subbrain");
}

export function initTelemetry(): void {
  if (sdkInitialized) {
    logger.warn("telemetry", "OTel SDK already initialized — skipping");
    return;
  }
  if (process.env.OTEL_ENABLED !== "true") {
    return;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    logger.warn("telemetry", "OTEL_ENABLED=true but OTEL_EXPORTER_OTLP_ENDPOINT is missing");
    return;
  }

  const exporter = new OTLPTraceExporter({ url: endpoint });
  const spanProcessor = new BatchSpanProcessor(exporter);

  sdkInstance = new NodeSDK({
    traceExporter: exporter,
    spanProcessors: [spanProcessor],
    serviceName: "subbrain",
  });

  sdkInstance.start();
  sdkInitialized = true;
  logger.info("telemetry", "OTel SDK started", { meta: { endpoint } });
}

export function shutdownTelemetry(): Promise<void> {
  if (!sdkInstance) return Promise.resolve();
  return sdkInstance.shutdown();
}
