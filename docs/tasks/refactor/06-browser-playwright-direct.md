# Задача 06 — Browser fix (BROWSER-1)

**Оценка:** 1–1.5 дня
**Зависимости:** —
**Status:** TODO

## Цель

Агент не может сёрфить — `web_*` зависает на CDP-хендшейке `@playwright/mcp`. Снять блокер либо обновлением зависимости (Шаг A), либо переписав `playwright-client.ts` на прямой `chromium.launch` (Шаг B). Плюс гарантия отсутствия leak'ов хром-процессов.

## Текущее состояние

[src/mcp/playwright-client.ts](../../../src/mcp/playwright-client.ts) — обёртка над `@playwright/mcp` через отдельный процесс + JSON-RPC. Зависает на handshake внутри Docker. Все web-тулы (navigate/snapshot/click/type/back/press_key) идут через единый `callTool(name, args)` — внешний интерфейс не меняется.

## Шаг A — обновить `@playwright/mcp`

1. `bun update @playwright/mcp` до latest stable.
2. Smoke в Docker:
   ```bash
   docker compose build && docker compose up -d
   docker compose exec subbrain bun -e '
     const { callTool } = await import("./src/mcp/playwright-client.ts");
     for (let i = 0; i < 3; i++) {
       await callTool("web_navigate", {url: "https://example.com"});
       const snap = await callTool("web_snapshot", {});
       console.log("iter", i, "ok", snap.length, "bytes");
     }
   '
   ```
3. Если 3 прогонки в течение 10 минут проходят без зависания — Шаг B пропускаем, фиксируем версию в `package.json`, мержим.

## Шаг B (fallback) — прямой `chromium.launch`

Срабатывает если Шаг A не помог. Переписать `src/mcp/playwright-client.ts`:

```ts
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser | null = null;
let page: Page | null = null;
let refMap = new Map<string, ElementHandle>();

async function ensureBrowser() {
  if (browser) return;
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  page = await browser.newPage();
}

export async function callTool(name: string, args: any) {
  await ensureBrowser();
  switch (name) {
    case "web_navigate": return page!.goto(args.url, {timeout: 15000});
    case "web_snapshot": return await snapshot();           // см. ниже
    case "web_click":    return clickByRef(args.ref);
    case "web_type":     return typeByRef(args.ref, args.text);
    case "web_back":     return page!.goBack();
    case "web_press_key": return page!.keyboard.press(args.key);
    default: throw new Error(`unknown web tool: ${name}`);
  }
}

async function snapshot() {
  // тегирует interactive elements атрибутом data-pw-ref="N"
  refMap.clear();
  const handles = await page!.$$('button, a, input, textarea, select, [role="button"]');
  for (let i = 0; i < handles.length; i++) {
    const ref = String(i);
    await page!.evaluate(([h, r]) => h.setAttribute("data-pw-ref", r), [handles[i], ref] as const);
    refMap.set(ref, handles[i]);
  }
  const html = await page!.content();
  return summarizeForLLM(html);  // существующий хелпер, переиспользовать
}

async function clickByRef(ref: string) {
  const h = refMap.get(ref) ?? throw new Error(`ref ${ref} not in last snapshot`);
  await h.click();
}
```

- `registry/web.tools.ts` **не трогается** — тот же `callTool` фасад.
- Убирается отдельный child-process + MCP-протокол → меньше точек отказа.
- Dockerfile уже ставит `chrome` channel.

## Шаг C — leak-smoke

По замечанию критика мастер-плана:

1. Логировать число открытых контекстов в `shutdown.ts` при graceful shutdown.
2. Добавить интеграционный тест:
   ```bash
   COUNT_BEFORE=$(ps ax | grep -c '[c]hrome')
   bun run tests/browser-smoke.ts   # запускает agent-loop с 5 web_navigate
   COUNT_AFTER=$(ps ax | grep -c '[c]hrome')
   [ "$COUNT_BEFORE" = "$COUNT_AFTER" ] || { echo LEAK; exit 1; }
   ```
3. В коде `playwright-client.ts` — `process.on("beforeExit", () => browser?.close())`.

## Файлы

- [src/mcp/playwright-client.ts](../../../src/mcp/playwright-client.ts)
- [package.json](../../../package.json) (Шаг A: версия `@playwright/mcp` или Шаг B: переход на `playwright` + удаление `@playwright/mcp` из deps)
- [src/app/shutdown.ts](../../../src/app/shutdown.ts) (после PR 07; до — в `src/index.ts`) — лог числа контекстов
- `tests/browser-smoke.ts` (новый, `*.ts` без `.test.` — чтобы `bun test` не подхватывал автоматически)

## Тесты

- Шаг A smoke: вручную (см. выше), в PR-описание скриншот.
- Leak-smoke: `tests/browser-smoke.ts`, запускается отдельной командой; в PR-описание `before/after` числа.

## Порядок исполнения

1. День 1: Шаг A — обновление + smoke. Если проходит → leak-smoke + мерж.
2. День 1.5: Если Шаг A не помог → Шаг B (переписывание). День 2: leak-smoke + мерж.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Smoke 3 прогона `web_navigate + web_snapshot` в Docker без зависания.
- [ ] `tests/browser-smoke.ts` после прогона: `ps ax | grep chrome | wc -l` без изменений.
- [ ] BROWSER-1 закрыт в [docs/02-audit.md](../../02-audit.md).
