# Observability Backend Decision: Langfuse vs Laminar

> Written for Subbrain Phase 5 (P5-1).  
> Existing `metrics_log` table and `src/lib/metrics.ts` aggregator are NOT replaced — OTel runs alongside them.

---

## Decision: Langfuse

Langfuse is chosen as Subbrain's trace backend.

**Primary reason:** Langfuse exposes a standard OTLP HTTP endpoint (`/api/public/otel`) that any OpenTelemetry SDK can push to. Laminar's SDK uses gRPC and auto-instrumentation, which is harder to integrate with a Bun runtime that already plans to use `@opentelemetry/exporter-trace-otlp-http`. Langfuse's "bring your own OTel SDK" approach matches Subbrain's architecture better than Laminar's "use our SDK" approach.

Secondary reasons:
- Langfuse is a German company (Berlin) with explicit EU data residency (Frankfurt) and GDPR compliance out of the box.
- Langfuse has a larger ecosystem, more mature OTel documentation, and broader language/framework integrations.
- Langfuse self-host is MIT-licensed with all features unlocked; Laminar is Apache 2.0 but younger (founded 2026, $3M seed).

---

## Self-host

### Langfuse
- **Services:** 2 app containers (`langfuse-web`, `langfuse-worker`) + 4 infra containers (`postgres`, `clickhouse`, `redis`, `minio`).
- **Databases:** PostgreSQL (metadata/OLTP) + ClickHouse (traces/OLAP) + Redis (cache/queue) + MinIO/S3 (blobs).
- **Compose:** Official `docker-compose.yml` available; 6 services total.
- **Conflict risk:** Adds Postgres, ClickHouse, Redis, MinIO — none of which exist in Subbrain's current `docker-compose.yml` (only `subbrain`, `web`, `cliproxy`). This is a significant infra expansion for a single-VPS setup.
- **Resource footprint:** ClickHouse is the dominant resource consumer. For low-volume single-user use, the full stack is over-provisioned.

### Laminar
- **Services:** `docker-compose.yml` (lightweight) or `docker-compose-full.yml` (production).
- **Databases:** PostgreSQL + ClickHouse + RabbitMQ (full stack) + Qdrant (full stack).
- **Compose:** 4+ services even in lightweight mode.
- **Conflict risk:** Also adds Postgres + ClickHouse + RabbitMQ. Similar infra expansion.

**Verdict:** Both require Postgres + ClickHouse. Langfuse additionally needs Redis + MinIO; Laminar additionally needs RabbitMQ (+ Qdrant in full mode). Neither is "lightweight." For Subbrain's single-VPS deployment, **cloud-hosted Langfuse** (Hobby tier) is the pragmatic path; self-host is reserved for a future multi-VPS or dedicated observability box.

---

## Cost

### Langfuse Cloud
| Tier | Price | Limit |
|------|-------|-------|
| Hobby (Free) | $0/mo | 50,000 units/mo, 30-day retention, 2 seats |
| Core | $29/mo | 100,000 units/mo, 90-day retention, unlimited seats |
| Pro | $199/mo | 500,000 units/mo, 180-day retention |

A "unit" = traces + observations + scores. Subbrain's single-user workload (pipeline phases + agent-loop steps + tool calls) likely generates <10K units/day, well within Hobby limits.

### Laminar Cloud
| Tier | Price | Limit |
|------|-------|-------|
| Free | $0/mo | 1 GB/mo, 1,000 signals steps, 15-day retention, 1 seat |
| Hobby | $30/mo | 3 GB + 5,000 steps, 30-day retention |
| Pro | $150/mo | 10 GB + 50,000 steps, 90-day retention |

Laminar's data-volume pricing is harder to estimate for Subbrain's trace shapes. The 15-day retention on the free tier is tighter than Langfuse's 30 days.

**Verdict:** Langfuse Hobby free tier is more generous and predictable for Subbrain's expected volume.

---

## Data residency

### Langfuse
- **Company:** Langfuse GmbH, Berlin, Germany.
- **GDPR:** Fully GDPR-compliant; standard DPA available.
- **Certifications:** SOC 2 Type II, ISO 27001, HIPAA-aligned (BAA on Pro/Enterprise).
- **Cloud regions:** EU (Frankfurt/Ireland), US (Oregon), Japan, HIPAA. Data never crosses regions after project creation.
- **Self-host:** Full data sovereignty; no telemetry back to Langfuse.

### Laminar
- **Company:** Y Combinator-backed, founded 2026, $3M seed. No explicit HQ location found.
- **GDPR:** No explicit GDPR mention found on pricing or docs pages.
- **Certifications:** "SOC2 Type 2 (in observation)" and "HIPAA compliant" per homepage.
- **Cloud regions:** Not documented.
- **Self-host:** Full control, but compliance posture is less mature.

**Verdict:** Langfuse wins on data residency maturity. German legal entity + explicit EU region + established compliance stack.

---

## SDK fit

### Langfuse
- **Approach:** "Bring your own OTel SDK." Langfuse acts as an OTel backend.
- **Endpoint:** Standard OTLP HTTP (`/api/public/otel` or `/api/public/otel/v1/traces`).
- **Auth:** Basic Auth with base64-encoded `public_key:secret_key`.
- **Integration:** Works with any language/framework that speaks OTLP HTTP. No Langfuse-specific SDK required in the app.
- **Subbrain mapping:** Subbrain will initialize `@opentelemetry/sdk-node` + `@opentelemetry/exporter-trace-otlp-http`, point `OTEL_EXPORTER_OTLP_ENDPOINT` at Langfuse, and add the Basic Auth header. This is exactly what P5-2..P5-6 plan to do.

### Laminar
- **Approach:** "Use our SDK." `Laminar.initialize()` auto-instruments LLM SDKs and frameworks.
- **Protocol:** gRPC for trace delivery (ports 8000 HTTP / 8001 gRPC in self-host).
- **Integration:** Deep SDK integration; less friendly to "I already have my own OTel setup."
- **Subbrain mapping:** Would require either (a) importing `@lmnr-ai/lmnr` and calling `Laminar.initialize()`, or (b) figuring out if Laminar accepts raw OTLP HTTP. Docs do not clearly document a generic OTLP HTTP endpoint.

**Verdict:** Langfuse's "backend-only" OTel approach fits Subbrain's plan to instrument manually with `@opentelemetry/sdk-node`. Laminar's SDK-centric approach creates coupling.

---

## Bun compatibility

### OpenTelemetry + Bun (general)
- Bun is **not** an officially supported runtime for `@opentelemetry/sdk-node`.
- Community workaround: programmatic initialization (no `--require` flag), disable `@opentelemetry/instrumentation-fs` (causes Bun crashes).
- Bun-native APIs (`Bun.serve`, `bun:sqlite`) are NOT auto-instrumented.
- Trace/metrics export via OTLP HTTP generally works; gRPC is less tested.

### Langfuse
- Uses **OTLP HTTP** (protobuf or JSON). No gRPC required.
- No Langfuse SDK in the app — only `@opentelemetry/exporter-trace-otlp-http`.
- Lower surface area for Bun incompatibility.

### Laminar
- Uses **gRPC** for trace delivery per self-host docs (`grpcPort: 8001`).
- Would require `@lmnr-ai/lmnr` SDK in the app.
- gRPC + Bun is less tested than HTTP; additional risk.

**Verdict:** Langfuse's OTLP HTTP path is safer for Bun than Laminar's gRPC path.

---

## Rejected alternative: Laminar

Laminar is rejected for the following reasons:

1. **Unclear OTLP HTTP support:** Laminar's docs emphasize gRPC and their own SDK. There is no documented generic OTLP HTTP endpoint equivalent to Langfuse's `/api/public/otel`. Subbrain's P5-2..P5-6 architecture assumes a standard OTLP HTTP exporter.
2. **Younger, less mature:** Founded 2026, $3M seed, SOC2 "in observation." Langfuse has been operating longer, has a German legal entity, and carries SOC2 Type II + ISO 27001.
3. **gRPC + Bun risk:** Laminar's trace delivery uses gRPC, which is less tested under Bun than HTTP/protobuf OTLP.
4. **Tighter free tier:** 1 GB / 15 days / 1 seat vs Langfuse's 50K units / 30 days / 2 seats. For a trace-heavy agent pipeline, unit-based pricing (Langfuse) is more predictable than data-volume pricing (Laminar).
5. **No documented EU region:** Langfuse explicitly offers Frankfurt/Ireland. Laminar's cloud regions are not documented.

Laminar's strengths (browser agent replay, SQL-native trace analysis, data-volume pricing for large payloads) do not align with Subbrain's current needs. If Subbrain later adds heavy browser-agent observability, Laminar can be re-evaluated.

---

## Integration notes for P5-6

- `OTEL_EXPORTER_OTLP_ENDPOINT` should point to `https://cloud.langfuse.com/api/public/otel` (cloud) or `http://langfuse:3000/api/public/otel` (self-host).
- Auth header: `Authorization=Basic <base64(public_key:secret_key)>`.
- Add `x-langfuse-ingestion-version=4` header for real-time preview.
- `metrics_log` table continues to operate independently; no schema changes.

---

*Decision date: 2026-05-05*  
*Decision owner: critic-round-3 / subagent task #7*
