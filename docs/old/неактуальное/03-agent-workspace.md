# 12 — Agent Workspace: Изолированный Docker-контейнер агента

## Концепция

Агент получает **собственную рабочую машину** — Docker-контейнер с полным
доступом к shell, файловой системе, git, пакетным менеджерам. Может делать
что угодно: писать код, деплоить сервисы, создавать проекты, ставить пакеты.

Если всё сломается — контейнер пересоздаётся из базового образа, но volume
(рабочая директория) **сохраняется между сессиями**.

---

## Архитектура

```
┌────────────────────────────────────────────────┐
│            Subbrain Main (порт 4000)           │
│                                                │
│  AgentLoop → workspace_exec("npm init -y")     │
│           → workspace_write_file(...)          │
│           → workspace_read_file(...)           │
│           → workspace_reset()                  │
└──────────────────┬─────────────────────────────┘
                   │ Docker API (unix socket)
                   ▼
┌────────────────────────────────────────────────┐
│     subbrain-workspace (отдельный контейнер)   │
│                                                │
│  Base: node:22-slim + bun + git + python3      │
│  User: agent (non-root)                        │
│  Workdir: /workspace (= named volume)          │
│                                                │
│  Capabilities:                                 │
│  ✅ Shell (bash, любые команды)                │
│  ✅ Файловая система (/workspace/*)            │
│  ✅ Сеть (fetch, curl, git clone/push)         │
│  ✅ Пакеты (npm, pip, apt)                     │
│  ✅ Git (clone, commit, push)                  │
│  ✅ Серверы (могут слушать порты)              │
│                                                │
│  Ограничения:                                  │
│  ❌ Нет доступа к host filesystem              │
│  ❌ Нет docker-in-docker                       │
│  ❌ CPU: 2 cores, RAM: 2GB, Disk: 10GB         │
│  ❌ Нет --privileged                           │
└────────────────────────────────────────────────┘
        │
        ▼
  Named Volume: subbrain-workspace-data
  (персистентный, переживает redeploy)
```

---

## Tools для агента

| Tool | Описание |
|------|----------|
| `workspace_exec` | Выполнить shell-команду. Timeout 60s. Возвращает stdout+stderr |
| `workspace_exec_bg` | Запустить фоновый процесс (сервер). Возвращает PID |
| `workspace_write_file` | Записать файл (path, content) |
| `workspace_read_file` | Прочитать файл (path, max 50KB) |
| `workspace_list_dir` | Листинг директории |
| `workspace_reset` | Пересоздать контейнер из образа (volume сохраняется) |
| `workspace_status` | Статус контейнера (running/stopped, uptime, disk usage) |

---

## Docker Compose

```yaml
# В основном docker-compose.yml добавляется:
services:
  workspace:
    image: subbrain-workspace:latest
    build:
      context: ./workspace
      dockerfile: Dockerfile
    container_name: subbrain-workspace
    volumes:
      - workspace-data:/workspace
    networks:
      - subbrain-net
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 2G
    restart: unless-stopped
    # Контейнер просто спит — команды выполняются через docker exec
    command: ["sleep", "infinity"]

volumes:
  workspace-data:
    name: subbrain-workspace-data
```

---

## Workspace Dockerfile

```dockerfile
FROM node:22-slim

# System tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget python3 python3-pip build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Non-root user (but with sudo for package installs)
RUN useradd -m -s /bin/bash agent && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER agent
WORKDIR /workspace

# Git config
RUN git config --global user.name "Subbrain Agent" && \
    git config --global user.email "agent@subbrain.dmtr.ru"
```

---

## Реализация (TypeScript)

```
src/pipeline/agent-loop/
  workspace/
    client.ts       — Docker API client (exec, file ops, reset)
    tools.ts        — Tool definitions for agent
    types.ts        — Interfaces
```

### client.ts (концепт)

```typescript
import { $ } from "bun";

export class WorkspaceClient {
  private container = "subbrain-workspace";

  async exec(command: string, timeout = 60_000): Promise<{stdout: string; stderr: string; exitCode: number}> {
    const proc = Bun.spawn(
      ["docker", "exec", this.container, "bash", "-c", command],
      { timeout }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout: stdout.slice(0, 50_000), stderr: stderr.slice(0, 10_000), exitCode };
  }

  async writeFile(path: string, content: string): Promise<void> {
    // docker exec -i container bash -c "cat > /workspace/path"
    const proc = Bun.spawn(
      ["docker", "exec", "-i", this.container, "bash", "-c", `cat > /workspace/${path}`],
      { stdin: new TextEncoder().encode(content) }
    );
    await proc.exited;
  }

  async readFile(path: string): Promise<string> {
    const { stdout } = await this.exec(`cat /workspace/${path}`);
    return stdout;
  }

  async listDir(path: string = "."): Promise<string> {
    const { stdout } = await this.exec(`ls -la /workspace/${path}`);
    return stdout;
  }

  async reset(): Promise<void> {
    await $`docker restart ${this.container}`;
  }

  async hardReset(): Promise<void> {
    // Recreate container but keep volume
    await $`docker rm -f ${this.container}`;
    await $`docker compose up -d workspace`;
  }

  async status(): Promise<{running: boolean; uptime: string; diskUsage: string}> {
    try {
      const { stdout } = await $`docker inspect ${this.container} --format '{{.State.Status}}|{{.State.StartedAt}}'`.text();
      const [status, started] = stdout.trim().split("|");
      const { stdout: du } = await this.exec("du -sh /workspace");
      return { running: status === "running", uptime: started, diskUsage: du.trim() };
    } catch {
      return { running: false, uptime: "", diskUsage: "" };
    }
  }
}
```

---

## Сценарии использования

1. **Агент пилит микро-SaaS:**
   ```
   workspace_exec("git clone https://github.com/user/project.git")
   workspace_exec("cd project && bun install")
   workspace_write_file("project/src/new-feature.ts", code)
   workspace_exec("cd project && bun test")
   workspace_exec("cd project && git add -A && git commit -m 'feat: add X' && git push")
   ```

2. **Агент создаёт Telegram-бота:**
   ```
   workspace_exec("mkdir my-bot && cd my-bot && bun init")
   workspace_write_file("my-bot/index.ts", botCode)
   workspace_exec("cd my-bot && bun install grammy")
   workspace_exec_bg("cd my-bot && bun run index.ts")  // запуск в фоне
   ```

3. **Агент парсит сайты (скрипт):**
   ```
   workspace_write_file("scraper.ts", scraperCode)
   workspace_exec("bun run scraper.ts")  // результат в stdout
   ```

4. **Всё сломалось:**
   ```
   workspace_reset()  // или workspace_exec("sudo apt-get fix...")
   ```

---

## Безопасность

- Контейнер **не имеет** доступа к host через volume mounts (кроме своего workspace-data)
- Сетевой доступ: только outbound (нет inbound кроме через subbrain-net)
- Docker socket **не монтируется** (нет docker-in-docker)
- Resource limits: 2 CPU, 2GB RAM, 10GB disk
- Timeout на exec: 60 секунд (для длинных задач — exec_bg)

---

## Приоритет реализации

1. ✅ Phase 1 (сделано): Code Tools — лёгкий sandbox через Bun Worker
2. 🔜 Phase 2: Workspace — полный Docker-контейнер
3. Позже: Scheduled workspace tasks (cron внутри контейнера)
4. Позже: Multi-workspace (для разных проектов)

---

## Зависимости

- Docker на host-машине (уже есть — деплой через Docker Compose)
- Доступ к Docker socket из main-контейнера (mount `/var/run/docker.sock`)
  или использовать Docker API по HTTP
- Достаточно дискового пространства для volume
