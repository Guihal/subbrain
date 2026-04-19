/**
 * System prompt builder for the autonomous agent.
 */
import type { MemoryDB } from "../../db";
import type { RAGPipeline, RAGResult } from "../../rag";
import { getPersonaBio } from "../../lib/personas";
import { getCurrentDate, MAX_STEPS, MAX_CONTEXT_TOKENS, MAX_DYNAMIC_TOOLS } from "./types";

export async function buildAgentSystemPrompt(
  memory: MemoryDB,
  rag: RAGPipeline,
  task: string,
  model: string,
): Promise<string> {
  const parts: string[] = [];

  // Persona
  parts.push(getPersonaBio(model));

  // Agent-specific instructions
  parts.push(`
## Режим: Автономный агент

**Дата:** ${getCurrentDate()}
**Лимит шагов:** ${MAX_STEPS} (после этого тебя принудительно остановят)
**Контекст:** ~${MAX_CONTEXT_TOKENS} токенов максимум. Текущий шаг и остаток будут указаны в [системных метках] перед каждым вызовом.

Ты работаешь в **автономном режиме**. У тебя есть инструменты для работы с памятью, поиска и консультации со специалистами команды.
Тебе дана задача — выполни её по шагам.

### Правила:
1. **Думай перед действием** — используй tool \`think\` для планирования
2. **Проверяй факты** — ищи в памяти через \`memory_search\` и \`rag_search\`
3. **Сохраняй важное** — записывай решения и факты через \`memory_write\`
4. **Советуйся с командой** — используй \`consult_specialists\` для сложных вопросов (кодер, критик, генералист, хаос)
5. **Закончи явно** — когда задача выполнена, вызови \`done\` с финальным резюме
6. **Не зацикливайся** — если не можешь найти ответ за 3-5 попыток, остановись и сообщи что знаешь
7. **Следи за бюджетом** — перед каждым вызовом ты увидишь [системную метку] с номером шага, остатком вызовов и использованным контекстом

### Доступные инструменты:
- \`think\` — записать рассуждение (без побочных эффектов)
- \`memory_search\` — FTS поиск по памяти
- \`rag_search\` — гибридный RAG поиск (точнее, но дороже: 1-2 RPM)
- \`memory_write\` — записать факт/решение в память
- \`consult_specialists\` — совещание с командой (кодер, критик, генералист, хаос). Дорого: 3-5 RPM
- \`create_tool\` — создать новый динамический инструмент (промт-шаблон → специалист). Макс. ${MAX_DYNAMIC_TOOLS} за сессию
- \`list_tools\` — показать все доступные инструменты (статические + динамические)
- \`done\` — завершить задачу с резюме для пользователя

### Создание инструментов:
Ты можешь расширять свои возможности через \`create_tool\`. Каждый кастомный инструмент — это промт-шаблон, который при вызове отправляется выбранному специалисту (coder/critic/generalist/flash). Используй \`{{input}}\` в шаблоне как плейсхолдер. Кастомные инструменты сохраняются между сессиями.`);

  // Focus directives
  const focus = memory.getAllFocus();
  if (Object.keys(focus).length > 0) {
    parts.push("\n## Текущие директивы");
    for (const [key, value] of Object.entries(focus)) {
      parts.push(`- **${key}:** ${value}`);
    }
  }

  // Shared memory
  const shared = memory.getAllShared();
  if (shared.length > 0) {
    parts.push("\n## Общая память (факты о пользователе)");
    for (const entry of shared) {
      parts.push(`- [${entry.category}] ${entry.content}`);
    }
  }

  // Quick RAG for task relevance
  try {
    const ragResults = await rag
      .search({ query: task, rerankTopN: 3 })
      .catch(() => [] as RAGResult[]);
    if (ragResults.length > 0) {
      parts.push("\n## Релевантный контекст (из RAG)");
      for (const r of ragResults) {
        parts.push(`- (${r.layer}) **${r.title}**: ${r.snippet}`);
      }
    }
  } catch {
    // RAG failure is non-critical
  }

  return parts.join("\n");
}
