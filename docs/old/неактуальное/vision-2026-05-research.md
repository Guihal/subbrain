# Market research для subbrain — May 2026

> Output research-агента (general-purpose, ~27 tool calls, 87k токенов).
> Контекст subbrain: Bun/Elysia/SQLite single-VPS single-user, sqlite-vec + FTS5 + NVIDIA rerank, virtual-roles + arbitration room + 4-layer memory + MCP registry + Telegram bot/userbot.
> Парный документ: [vision-2026-05.md](vision-2026-05.md).

---

## 1. Agent runtimes / frameworks

| # | Проект | Stars (~) | Лицензия | Self-host | Lang |
|---|--------|-----------|----------|-----------|------|
| 1 | **Mastra** | 22k+ | Apache 2.0 | да | TypeScript |
| 2 | **Agno** (бывш. Phidata) | ~25k | MPL-2.0 | да | Python |
| 3 | **LangGraph** | 34.5M monthly downloads | MIT | да | Python |

Также: Pydantic AI, OpenAI Agents SDK, Google ADK, CrewAI, AG2/AutoGen.

**Verdict subbrain:**
- **Mastra → INSPIRE + частично INTEGRATE.** TypeScript-first, Bun-compat, libSQL+vec storage, dual-MCP (consume + serve). 300k weekly npm downloads, Replit Agent 3 на нём. Ближайший по стеку. Borrow workflow primitives (`.then()/.branch()/.parallel()` DSL, memory threads, dual-MCP). НЕ wholesale replace — pipeline subbrain (pre/main/post + arbitration) специфичнее.
- **Agno → INSPIRE.** «<2µs agent instantiation» — proof что lightweight возможен. Multimodal built-in. Не TS — borrow architecture only.
- **LangGraph → SKIP core, INSPIRE checkpointing.** Pattern «durable execution + resume + human-in-the-loop interrupts» — заимствовать в pipeline phase boundaries.

Source: [Comparing Frameworks - Langfuse](https://langfuse.com/blog/2025-03-19-ai-agent-comparison), [LangGraph vs CrewAI vs Mastra](https://www.digitalapplied.com/blog/agentic-orchestration-frameworks-langgraph-vs-crewai), [Mastra GitHub](https://github.com/mastra-ai/mastra)

---

## 2. LLM gateways / proxies

| # | Проект | Stars | Лицензия | Self-host | Lang |
|---|--------|-------|----------|-----------|------|
| 1 | **Bifrost** (maximhq) | ~5k | MIT | да | **Go** |
| 2 | **Portkey gateway** (OSS с March 2026) | ~9k | Apache 2.0 | да | TypeScript |
| 3 | **Helicone gateway** | ~3k | Apache 2.0 | да | TypeScript |

**Verdict subbrain:**
- **Bifrost → INTEGRATE (high priority).** 11µs overhead@5k RPS (50× быстрее litellm). Native MCP gateway (фильтр tool calls на gateway-уровне). Semantic cache (5ms hit, 60ms miss vs 2000ms LLM). 1000+ models. Adaptive load balancer + cluster mode + guardrails. **Точно соответствует roadmap «LLM Gateway вынести в отдельный модуль»** (vision-2026-05.md §3). Go binary как side-car к Bun-процессу через unix socket → cleanly разделяет concerns без переписывания routing на TS. Замена in-process router в `subbrain/server/utils/llm-router/`.
  - Где: `subbrain/services/bifrost/` (docker-compose) + `subbrain/server/utils/gateway-client.ts`. Удалить custom rate-limiter / fallback chain / role-mapping → перенести в Bifrost config через admin API.
- **Portkey OSS → INSPIRE.** PII redaction + jailbreak detection + audit trails — guardrail-pattern для userbot Telegram path.
- **Helicone gateway → SKIP** (Bifrost faster). Caching layer отдельно — см. §15.

Source: [Bifrost GitHub](https://github.com/maximhq/bifrost), [Top 5 LLM Gateways 2026](https://dev.to/varshithvhegde/top-5-llm-gateways-in-2026-a-deep-dive-comparison-for-production-teams-34d2)

---

## 3. Memory systems / long-term memory

| # | Проект | Stars | Лицензия | Self-host | Pattern |
|---|--------|-------|----------|-----------|---------|
| 1 | **Letta** (бывш. MemGPT) | 18k+ | Apache 2.0 | да | OS-paradigm, memory blocks, sleep-time |
| 2 | **Mem0** | 35k+ | Apache 2.0 | да | extract-store-retrieve + dynamic forgetting |
| 3 | **Zep** | 4k+ | Apache 2.0 | да | temporal knowledge graph |

Также: Cognee, Memori, Supermemory.

**Verdict subbrain:**
- **Letta → INSPIRE (high priority).** Three-tier memory (Core RAM / Recall disk / Archival cold) ↔ subbrain 4-layer (focus / shared / context / archive). **Memory blocks pattern** = explicit editable units, агент сам редактирует через tool calls. **Sleep-time agents** = async consolidation в idle ↔ subbrain night-cycle. Заимствовать:
  - Memory block API (CRUD tool над собственной памятью).
  - Sleep-time agent role в virtual-roles registry.
- **Mem0 → INSPIRE.** Dynamic forgetting (decay для low-relevance) — нужно в memory-v2 backlog. Каждое retrieval boost'ит recency_score, отсутствие → exponential decay → archive. **Contradiction detection** при write: new fact vs existing high-confidence → flag review (free-agent runner-type «memory-contradiction-resolver»).
- **Zep → INSPIRE для memory-v2 edges.** Bi-temporal facts (valid_from / valid_to + observed_at). «I used to live in London, moved to Tokyo» → state change recognized.

**Не INTEGRATE как dependency** — все три heavyweight Python. Pattern-borrow only.

Source: [Letta GitHub](https://github.com/letta-ai/letta), [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026), [Mem0 vs Zep vs Letta vs Cognee](https://explore.n1n.ai/blog/ai-agent-memory-comparison-2026-mem0-zep-letta-cognee-2026-04-23)

---

## 4. RAG / hybrid search frameworks

| # | Проект | Stars | Лицензия | Self-host | Подход |
|---|--------|-------|----------|-----------|--------|
| 1 | **LightRAG** | 13k+ | MIT | да | dual-level graph + hybrid |
| 2 | **Microsoft GraphRAG** | 25k+ | MIT | да | community-detection KG |
| 3 | **RAGFlow** | 50k+ | Apache 2.0 | да | deep document understanding + GraphRAG |

Также: Haystack, Vespa.

**Verdict subbrain:**
- **LightRAG → INSPIRE (high priority).** ~80ms vs ~120ms standard RAG. Dual-level retrieval (local entity + global theme). **No community-detection overhead.** Memory-v2 заимствовать:
  - Entity extraction (поверх hippocampus).
  - Edges first-class: `memory_edges (subject_id, predicate, object_id, weight, observed_at, valid_from, valid_to)`.
  - Hybrid retrieval: FTS + vec + edge-walk (1-hop, 2-hop) → rerank.
- **MS GraphRAG → SKIP** для embedding. Тяжёлый: Leiden community detection, 10-20× дороже LightRAG. CLI for offline ingest archive raw_log — possibly.
- **RAGFlow → SKIP.** Document-heavy (PDF/Excel) — overkill для personal chat-data.

Source: [LightRAG vs GraphRAG](https://www.maargasystems.com/2025/05/12/understanding-graphrag-vs-lightrag-a-comparative-analysis-for-enhanced-knowledge-retrieval/), [15 Open-Source RAG 2026](https://www.firecrawl.dev/blog/best-open-source-rag-frameworks)

---

## 5. Vector / hybrid stores

| # | Проект | Stars | Лицензия | Embeddable | Lang |
|---|--------|-------|----------|------------|------|
| 1 | **LanceDB** | 13k+ | Apache 2.0 | да (in-process) | Rust + bindings |
| 2 | **sqlite-vec** (текущий) | 5k+ | Apache 2.0 | да (extension) | C |
| 3 | **Qdrant** | 26k+ | Apache 2.0 | server-only | Rust |

**Verdict subbrain:**
- **sqlite-vec → KEEP.** Оптимально для single-VPS single-user. ACID + FTS5 в той же транзакции, vec в той же файлухе → нет cross-store consistency drama.
- **LanceDB → INSPIRE.** Если когда-то >10M vectors или multimodal (image/audio embeddings для voice) — заточен под columnar batch. TS bindings есть. Сейчас sqlite-vec справится годами.
- **Qdrant → SKIP.** Server-mode, overkill.
- **libSQL+vec (Turso) → WATCH.** Vec built-in, не extension → проще build. Если sqlite-vec extension сломается на Bun apt deploy — drop-in.

**Pattern memory-v2 hybrid score:** `α × FTS_bm25 + β × vec_cosine + γ × edge_walk + δ × recency_decay + ε × confidence`. Веса в DB-config, tunable per-role.

Source: [Vector DB Benchmarks 2026](https://callsphere.ai/blog/vector-database-benchmarks-2026-pgvector-qdrant-weaviate-milvus-lancedb), [Embedded Intelligence sqlite-vec](https://dev.to/aairom/embedded-intelligence-how-sqlite-vec-delivers-fast-local-vector-search-for-ai-3dpb)

---

## 6. Workflow / orchestration engines

| # | Проект | Stars | Лицензия | Self-host | Lang |
|---|--------|-------|----------|-----------|------|
| 1 | **Trigger.dev v3** | 10k+ | Apache 2.0 | да (Docker + Postgres) | TypeScript |
| 2 | **Windmill** | 12k+ | AGPL/EE | да | Rust + scripts (TS/Py/Go/Bash) |
| 3 | **n8n** | 90k+ | Sustainable Use | да | TypeScript |

Также: Hatchet, Inngest (open SDK, **closed orchestrator**), Activepieces, Kestra, Temporal.

**Verdict subbrain:**
- **Trigger.dev v3 → ALTERNATIVE / borrow pattern.** Apache 2.0, full self-host, TS-native, dedicated long-running compute. Postgres backend → конфликт «SQLite only» philosophy. **SKIP как dependency**, но **borrow durable-step pattern**: `await ctx.run('step-name', async () => {...})` с auto-checkpoint в SQLite таблицу `pipeline_steps`.
- **Windmill → INTEGRATE как side-car (replace n8n из roadmap).** TS-native scripts > n8n YAML/UI quirks для power-user, 3min Docker deploy. Если юзер хочет визуально собирать non-LLM automation (rss → digest → telegram) — Windmill > n8n. **Альтернатива roadmap §6: Windmill side-car вместо n8n.**
- **n8n → переоценить vs Windmill.** Windmill TS-friendly, n8n integration-rich. Решение зависит от приоритетов: 400+ ready integrations (n8n win) vs TS-native scripts (Windmill win).

Source: [Trigger.dev vs Inngest vs Temporal](https://trybuildpilot.com/610-trigger-dev-vs-inngest-vs-temporal-2026), [Windmill alternatives](https://www.windmill.dev/docs/compared_to/peers), [N8N alternatives](https://flowlyn.com/blog/open-source-n8n-alternatives)

---

## 7. Agent builder UIs / no-code

| # | Проект | Stars | Лицензия | Use |
|---|--------|-------|----------|-----|
| 1 | **Dify** | 75k+ | Dify OSL (Apache+restrictions) | full LLM app builder |
| 2 | **AnythingLLM** | 30k+ | MIT | private chat + agent |
| 3 | **Langflow** | 35k+ | MIT (DataStax) | visual LangGraph IDE |

**Verdict subbrain:**
- **ALL → SKIP wholesale.** Frontend rewrite roadmap имеет специфичные модули (roles / providers / mcp / skills / tasks / tg-data / runs / settings) — специфичнее generic Dify. Под другую аудиторию.
- **Langflow → INSPIRE.** Pattern visual LangGraph editor — для tasks модуля (task = pipeline). React Flow lib MIT, легко в Nuxt 4. Для visual pipeline builder.
- **AnythingLLM → INSPIRE UI patterns** workspace switcher (workspaces = pipelines).
- **Flowise → SKIP.** Acquired by Workday Aug 2025 → OSS уход. Risky.
- **OpenWebUI → SKIP** (chat frontend, не builder).

Source: [Dify vs Langflow vs Flowise](https://blog.elest.io/dify-vs-langflow-vs-flowise-which-open-source-llm-app-builder-actually-ships-to-production/)

---

## 8. Observability / tracing для LLM

| # | Проект | Stars | Лицензия | Stack |
|---|--------|-------|----------|-------|
| 1 | **Langfuse** | 11k+ | MIT (core) | Postgres + ClickHouse |
| 2 | **Laminar** | 3k+ | Apache 2.0 | Rust core + Postgres |
| 3 | **Phoenix** (Arize) | 6k+ | Elastic 2.0 | Python |

Также: Helicone, OpenLLMetry.

**Verdict subbrain:**
- **Langfuse → INTEGRATE (high priority).** MIT core полностью self-hostable, framework-agnostic через OTel. Replace custom run viewer (`server/services/runs`):
  - Session replays, built-in evaluators (hallucination, toxicity).
  - **Stack heavy** (ClickHouse). Single-VPS 4GB+ RAM. Если tight → Laminar.
- **Laminar → ALTERNATIVE.** Apache 2.0, one-command Helm, full features в OSS, lighter Rust core. **Если ресурсы лимитированы — Laminar вместо Langfuse.**
- **OpenLLMetry → INTEGRATE как library.** Vendor-neutral OTel SDK для TS. `@traceloop/node-server-sdk`. Subbrain instrument'ит pipeline → ingest хоть в Langfuse, хоть Laminar (portability).

Source: [Langfuse alternatives](https://langfuse.com/faq/all/best-phoenix-arize-alternatives), [Laminar alternatives 2026](https://laminar.sh/article/langfuse-alternatives-2026), [LLM Observability Spheron Guide](https://www.spheron.network/blog/llm-observability-gpu-cloud-langfuse-arize-phoenix-helicone/)

---

## 9. MCP server marketplace / ecosystem

**Каталоги:** Glama (21k+), MCP.so (19.7k), PulseMCP (11.8k hand-reviewed), Smithery (7k cloud-managed), Composio (500+ production).

**Топ-15 production MCP-серверов** (для `subbrain/data/mcp-registry/`):

1. GitHub MCP (official Anthropic).
2. Filesystem MCP (official).
3. Postgres MCP (official).
4. SQLite MCP (для самой subbrain DB inspection).
5. Git MCP (history/blame).
6. Playwright MCP (Microsoft).
7. Context7 MCP (Upstash, library docs).
8. Slack MCP (sometimes flaky → community alt).
9. Linear MCP (official Linear).
10. Notion MCP (semantic search workspace).
11. Brave Search MCP.
12. Memory MCP (Anthropic ref — **бенчмарк против subbrain memory**).
13. Puppeteer MCP (alt Playwright).
14. Gmail + Google Calendar MCP bundle.
15. Sentry / Stripe MCP (context-dependent).

**Verdict subbrain:**
- **PulseMCP → INTEGRATE для discovery API.** Hand-reviewed → меньше supply-chain risk. `mcp-registry` модуль pull metadata через PulseMCP MCP server. Auto-update weekly.
- **Composio → INSPIRE.** 500+ с OAuth handled. Subbrain мог бы предоставить per-domain OAuth proxy для MCP (текущая scope filtering только role/agentMode — добавить identity scope).
- **🚨 SECURITY:** 36.7% public MCP have SSRF, 43% unsafe command exec, 41% официальных **zero authentication**. Subbrain `mcp-registry` **обязан** allowlist + sandbox/scope enforcement. Non-negotiable.

Source: [MCP Marketplaces You Didn't Know](https://medium.com/@airabbitX/mcp-marketplaces-you-didnt-know-existed-but-really-should-5ea0afcc9584), [Top 15 MCP Servers](https://dev.to/jangwook_kim_e31e7291ad98/top-15-mcp-servers-every-developer-should-install-in-2026-n1h), [MCP Marketplace Guide](https://apigene.ai/blog/mcp-marketplace)

---

## 10. Skills / prompt management

| # | Проект | Stars | Лицензия | Lang |
|---|--------|-------|----------|------|
| 1 | **BAML** (BoundaryML) | 3k+ | Apache 2.0 | DSL + TS/Py/Go/Rust/Java/C#/Ruby |
| 2 | **Promptfoo** | 5k+ | MIT | TypeScript |
| 3 | **Latitude** | 3k+ | LGPL | TypeScript |

Также: Dust (closed/cloud), LangSmith hub (closed Anthropic alt).

**Verdict subbrain:**
- **BAML → INTEGRATE (medium priority).** DSL для prompt-as-schema, **TS bindings** → Bun OK. Schema-Aligned Parsing (SAP) — для LLM output coercion в типизированные структуры (chain-of-thought + JSON в одном response). Type-safe streaming. **Replace** ad-hoc structured-output handling. Где: `server/utils/baml/` functions + roles в virtual-roles config содержат BAML function names.
- **Promptfoo → INTEGRATE для CI.** YAML eval'ы в repo. `bun run eval` перед deploy → batch-test prompts на test cases (regression). Prompt injection / PII / jailbreak built-in. Где: `tests/prompts/` + lefthook pre-push.
- **Latitude → SKIP** (меньше adoption).

Subbrain `skills` модуль уже есть (.claude/skills inspired) — **stay**, layer BAML под него для prompt-validation.

Source: [Promptfoo alternatives](https://www.braintrust.dev/articles/best-promptfoo-alternatives-2026), [BAML GitHub](https://github.com/BoundaryML/baml)

---

## 11. Telegram data ingest tooling

| # | Проект | Stars | Лицензия | Lang |
|---|--------|-------|----------|------|
| 1 | **GramJS** | 3k+ | MIT | TS/Node + browser |
| 2 | **Teleproto** | <1k | MIT | TS (fork GramJS, modern) |
| 3 | **mtproto-nodejs-client** | 1k+ | MIT | TypeScript |

**Verdict subbrain:**
- **Текущий userbot → KEEP.** MTProto libs стабильны, layer 195 везде.
- **Teleproto → WATCH.** Fork GramJS с «clean API + up-to-date layers». Если current MTProto начнёт ломаться — swap candidate.
- **Specialized ingest libs — nothing notable.** Раздел незрелый.
- **Privacy-aware patterns INSPIRE:** filter service messages / typing / reactions перед raw_log (signal/noise). Group по conversation thread. Hash phone numbers перед write в shared layer.

Source: [GramJS GitHub](https://github.com/gram-js/gramjs), [Teleproto GitHub](https://github.com/sanyok12345/teleproto)

---

## 12. Coding agents / IDE integration

| # | Проект | Stars | Лицензия | Подход |
|---|--------|-------|----------|--------|
| 1 | **Cline** | 58k+ | Apache 2.0 | VS Code, MCP marketplace |
| 2 | **Roo Code** | 20k+ | Apache 2.0 | Cline fork, multi-mode |
| 3 | **Aider** | 30k+ | Apache 2.0 | terminal, git-native |

Также: Continue, Sweep, OpenCode, Letta Code.

**Verdict subbrain:**
- **Subbrain server, coding agents clients** через MCP. Subbrain экспортирует `subbrain-memory` + `subbrain-roles` MCP → Cline/Roo/Aider/CC consume. NOT replacement Claude Code.
- **Roo Code → INSPIRE.** Multi-mode (Code/Architect/Ask/Debug) ↔ subbrain virtual-roles. Roo client-side switching → subbrain server-side richer routing. Borrow UX: `@architect` сменить активную роль mid-thread.
- **Letta Code → INSPIRE.** Memory-first coding (git-backed memory, skills, subagents). Future skill: «memory-aware coding» — agent держит project-specific memory blocks, обновляемые при git commits.

Source: [Roo Code vs Cline](https://www.qodo.ai/blog/roo-code-vs-cline/), [Best Open-Source Coding Tools 2026](https://frontman.sh/blog/best-open-source-ai-coding-tools-2026/), [Letta Code](https://www.letta.com/blog/letta-code)

---

## 13. Multi-agent / agent-team frameworks

| # | Проект | Stars | Лицензия | Pattern |
|---|--------|-------|----------|---------|
| 1 | **AG2/AutoGen** | 35k+ | Apache 2.0 | event-driven GroupChat + speaker selector |
| 2 | **CrewAI** | 30k+ | MIT | role-based crew + tasks |
| 3 | **Google ADK** | 5k+ | Apache 2.0 | hierarchical tree + A2A protocol |

**Verdict subbrain:**
- **`arbitration room` уже multi-agent** — extend pattern.
- **AG2 GroupChat → INSPIRE.** Speaker selector: на каждом step LLM-driven или deterministic. Subbrain arbitration round-robin (или parallel-vote?) — добавить selector mode для async debate.
- **A2A protocol (Google) → WATCH.** Standardized agent-to-agent поверх MCP. CrewAI adopted. Если де-facto → subbrain expose virtual-roles через A2A endpoints → other systems могут вызывать subbrain coder/critic remote. **Follow через 6 месяцев.**
- **Manus** (китайский autonomous swarm) — закрытый, hype, **SKIP**.
- **CrewAI → SKIP** (Python, role pattern уже есть).

Source: [Multi-Agent Frameworks 2026](https://gurusup.com/blog/best-multi-agent-frameworks-2026)

---

## 14. Voice / multimodal

| # | Проект | Stars | Лицензия | Use |
|---|--------|-------|----------|-----|
| 1 | **Pipecat** (Daily.co) | 4k+ | BSD-2 | Python orchestration |
| 2 | **LiveKit Agents** | 3k+ | Apache 2.0 | WebRTC + agent runtime |
| 3 | **Whisper.cpp / Faster-Whisper** | 35k / 12k | MIT | local STT |

Также: NVIDIA Parakeet TDT, Kyutai STT, Piper / Coqui TTS.

**Verdict subbrain:**
- **Defer Q3+ 2026.** Single-VPS без GPU не потянет local Whisper-large + LLM concurrent. Если/когда:
  - **STT → NVIDIA NIM** (subbrain уже использует) — `parakeet-tdt-0.6b-v3` через API, нет GPU нужно.
  - **TTS → ElevenLabs API** или Kyutai TTS via API. Self-host TTS (Piper) на CPU OK.
  - **Pipecat / LiveKit → SKIP** (overkill для personal). Build minimal STT→LLM→TTS chain в TS когда понадобится.

Source: [LiveKit STT models](https://docs.livekit.io/agents/models/stt/)

---

## 15. Cost / budget management

| # | Проект | Stars | Лицензия | Approach |
|---|--------|-------|----------|----------|
| 1 | **Bifrost semantic cache** | — | MIT | gateway-level (см. §2) |
| 2 | **GPTCache** (Zilliz) | 7k+ | MIT | library, embedding similarity |
| 3 | **Helicone caching** | — | Apache 2.0 | proxy-level |

**Verdict subbrain:**
- **Bifrost native cache → INTEGRATE** (часть §2 INTEGRATE). Once Bifrost in stack, cache «свободно» — конфиг redis backend + threshold. 5ms hit vs 2000ms LLM → **immediate ROI**.
- **GPTCache → SKIP** standalone. Bifrost handle. Если custom path остаётся (NIM direct) — `server/utils/cache/` опция, но эффект меньше gateway-cache.
- **Cost tracking → DB-driven Bifrost approach.** Logs tokens/cost per request → subbrain aggregate в `cost_ledger` таблицу + `settings/budgets` модуль frontend. Per-role budgets (teamlead $5/day, chaos $1/day). Hard limit + soft warn.
- **Pattern semantic-cache:** cache при `temperature=0`, skip при `chaos` role. Bifrost per-route cache config — fits.

Source: [Top LLM Gateways Semantic Caching 2026](https://dev.to/debmckinney/top-llm-gateways-that-support-semantic-caching-in-2026-3dho)

---

## 16. Что свежее на May 2026

**Notable releases April-May 2026:**
- **DeepSeek V4 Pro/Flash (24 Apr 2026)** — open-source flagship coding+agentic. Через OpenRouter / direct. **virtual-roles add coder option** ($0.27/$1.10 per Mtok). High priority.
- **Google Gemma 4 (Apr 2026)** — Apache 2.0 open weights. Reasoning+agentic. Self-host через Ollama / vLLM на GPU box если будет. Сейчас → NIM или OpenRouter.
- **Gemini CLI (Apr 2026)** — Apache 2.0 terminal agent (Google's Claude Code analog). **WATCH**, конкурент CC.
- **MCP crossed 97M monthly installs (Mar 2026)** → **standard de-facto.** Subbrain MCP-first дизайн validated.
- **AG2 v2 event-driven core** — async + pluggable orchestration. Pattern для pipeline async refactor.
- **Microsoft Agent Framework** (Azure-native, Q1 2026) — SKIP, Azure-locked.

**Pattern shifts 2026:**
- Bi-temporal memory (Zep) — `valid_from/valid_to + observed_at`. **memory-v2 must have.**
- Sleep-time agents (Letta) — async consolidation. **night-cycle align.**
- A2A protocol (Google + CrewAI) — agent-to-agent над MCP. **WATCH**, adopt при traction.
- Schema-aligned parsing (BAML SAP) — replace fragile JSON.parse. **INTEGRATE.**
- Hybrid retrieval baseline + cross-encoder rerank default → subbrain rerank pipeline (NVIDIA rerank уже есть) **stays correct.**

Source: [Bloomberg DeepSeek V4](https://www.bloomberg.com/news/articles/2026-04-24/deepseek-unveils-newest-flagship-a-year-after-ai-breakthrough), [AI Agents News April 2026](https://www.opus.pro/blog/ai-agents-news-april-2026)

---

# Top-10 действий subbrain (ranked ROI/effort)

| # | Действие | Effort | ROI | Где |
|---|----------|--------|-----|-----|
| **1** | **Bifrost gateway side-car** (replace custom router) | 3-5d | huge: 50× faster, free MCP gateway, free semantic cache, DB-driven routing align с roadmap | new `services/bifrost/` docker + `gateway-client.ts` wrapper. Удалить in-process rate-limiter / fallback / role-mapping |
| **2** | **BAML structured outputs** + Promptfoo CI | 2-3d | high: type-safe prompts, regression catch перед deploy, eliminates fragile JSON parsing | `server/utils/baml/` + `tests/prompts/*.yaml` + lefthook pre-push |
| **3** | **Memory-v2: edges + bi-temporal** (Zep + LightRAG inspired) | 5-7d | huge: unblocks decay/dedup roadmap, relationship-aware retrieval | new `memory_edges` + `memory_facts_temporal` tables + hybrid score в `memory/retrieval.ts` |
| **4** | **Memory blocks API** (Letta inspired) + sleep-time agent role | 3-4d | high: explicit editable memory units, night-cycle становится first-class «sleep-time agent» вместо bespoke cron | `memory/blocks.ts` CRUD MCP tool + virtual-role `sleep-time` |
| **5** | **Langfuse OR Laminar self-host** (через OpenLLMetry) | 2-3d | high: replaces custom run viewer, session replay + evaluators free | `services/langfuse/` (или laminar) compose; `@traceloop/node-server-sdk` |
| **6** | **Windmill side-car** (вместо n8n) | 1-2d | medium: TS-native scripts > n8n YAML/UI, 3min deploy | `services/windmill/` compose; subbrain emits webhook → Windmill triggers |
| **7** | **MCP registry с PulseMCP sync** + security allowlist | 2-3d | medium: legitimate discovery без supply-chain risk; 41% official MCP zero-auth → MUST gate | `mcp-registry/sync-pulsemcp.ts` cron + allowlist DB table |
| **8** | **DeepSeek V4 в virtual-roles** (через OpenRouter) | <1d | high: dirt-cheap powerhouse coder/critic | `virtual-roles.yaml` add provider option |
| **9** | **A2A protocol expose** virtual-roles (subbrain remote agent) | 5d | medium-future: позиционирует subbrain как inter-system primitive | `server/api/a2a/` endpoints, agent-card.json |
| **10** | **Trigger.dev v3 durable-step pattern** (borrow only) | 2-3d | medium: pipeline phases с auto-checkpoint, recovery from crash | `pipeline_steps` SQLite table + `ctx.run('step', fn)` helper |

**Не делать сейчас:**
- Voice (Q3+).
- Replace memory-stack целиком (Letta/Mem0/Cognee) — heavyweight Python, философский misfit.
- LangGraph/CrewAI (Python).
- Full Mastra wholesale replace (pipeline специфичнее).
- Dify/Langflow/Flowise (UI generic, code-first).
- Vespa/Marqo (overkill scale).
- Inngest (closed orchestrator, не self-hostable).

---

## Главный takeaway

**Subbrain архитектура на May 2026 не отстала.** Patterns (4-layer memory, MCP-first, virtual-roles) совпадают с emerging best-practice.

**Самые большие wins — extract в side-cars:**
- **Bifrost** (gateway, 50× faster).
- **Langfuse / Laminar** (observability).
- **BAML** (structured output).

Three side-cars дают subbrain enterprise-grade infrastructure **без переписывания core**.
