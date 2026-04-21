/**
 * Report-context tool: собирает markdown с фактами + событиями + RAG-контекстом
 * перед отправкой отчёта. Agent-only.
 *
 * Также здесь живёт `tg_send_report` — обёртка над `tg_send_message`,
 * автоматически обогащающая текст через `report_context`.
 */
import { t, type ToolRegistry } from "./tool-registry";
import { buildReportContext } from "../../rag";
import { sendReport } from "../tools/telegram-report";

export function registerReportTools(registry: ToolRegistry): void {
  registry.register({
    name: "report_context",
    description:
      "Собирает RAG-контекст для отчёта: факты из shared_memory, события из raw_log за period, релевантные context/archive. Вызови ДО генерации текста отчёта.",
    scope: "public",
    input: t.Object({
      topic: t.Optional(
        t.String({
          description: "Тема отчёта. Пусто — берём last shared facts.",
        }),
      ),
      since_hours: t.Optional(
        t.Number({ description: "Окно raw_log в часах (default: 24)" }),
      ),
    }),
    handler: async (args, ctx) => {
      try {
        const md = await buildReportContext({
          memory: ctx.executor.memoryDb,
          rag: ctx.executor.ragPipeline,
          topic: args.topic,
          sinceHours: args.since_hours,
        });
        return { success: true, data: md };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: "tg_send_report",
    description:
      "Отправить отчёт в Telegram с автоматическим RAG-обогащением (shared facts + recent raw_log + context/archive). Kill-switch: REPORT_RAG=false → шлёт сырой текст.",
    scope: "public",
    input: t.Object({
      text: t.String({ description: "Текст отчёта" }),
      topic: t.Optional(
        t.String({ description: "Тема (default: первая строка text)" }),
      ),
      since_hours: t.Optional(
        t.Number({ description: "Окно raw_log (default: 24)" }),
      ),
    }),
    handler: (args, ctx) =>
      sendReport(ctx, args.text, {
        topic: args.topic,
        sinceHours: args.since_hours,
        memory: ctx.executor.memoryDb,
        rag: ctx.executor.ragPipeline,
      }),
  });
}
