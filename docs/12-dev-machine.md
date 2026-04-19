# 12 — Dev Machine: Изолированный контейнер агента

## Концепция

Агент получает **полноценную dev-машину** — Docker-контейнер с:
- Полный доступ к файловой системе
- Bun/Node.js/Python runtime
- Git, curl, ssh
- Persist через Docker volume (не теряется при передеплое)
- Возможность самостоятельного передеплоя (recreate container, сохраняя volume)

## Архитектура

```
┌─────────────────────────────────────────────────────┐
│           Subbrain Main (порт 4000)                 │
│  AgentLoop → Docker API → Dev Machine              │
└────────────────────────┬────────────────────────────┘
                         │ Docker socket / API
                         ▼
┌─────────────────────────────────────────────────────┐
│         subbrain-devmachine (контейнер)              │
│                                                     │
│  Runtime: Bun + Node 22 + Python 3.12 + Git         │
│  User: agent (non-root, но sudo доступен)           │
│  Workdir: /home/agent                               │
│                                                     │
│  Volume: subbrain-devmachine-data → /home/agent     │
│  (персистентный, переживает recreate)                │
│                                                     │
│  Ограничения:                                       │
│  - memory: 2GB                                      │
│  - cpus: 1.0                                        │
│  - no network access to host Docker socket          │
│  - pids-limit: 100                                  │
│  - read-only root fs (только /home/agent writable)  │
└─────────────────────────────────────────────────────┘
```

## Tools для агента

| Tool | Описание |
|------|----------|
| `dev_exec` | Выполнить shell-команду в контейнере |
| `dev_write_file` | Записать файл в /home/agent/... |
| `dev_read_file` | Прочитать файл |
| `dev_list_dir` | ls директории |
| `dev_reset` | Recreate контейнер (volume сохраняется) |

## docker-compose.yml (дополнение)

```yaml
  devmachine:
    image: oven/bun:1.3-debian
    container_name: subbrain-devmachine
    volumes:
      - devmachine-data:/home/agent
    working_dir: /home/agent
    user: "1000:1000"
    mem_limit: 2g
    cpus: 1.0
    pids_limit: 100
    read_only: true
    tmpfs:
      - /tmp:size=500m
    command: ["sleep", "infinity"]  # Keep alive, exec into it
    restart: unless-stopped

volumes:
  devmachine-data:
```

## Сценарии использования

1. **Агент пилит микро-SaaS**: создаёт проект, пишет код, коммитит в git
2. **Парсер/скрапер**: пишет скрипт, тестирует, запускает по расписанию
3. **Эксперименты**: пробует новые библиотеки без риска для основного сервера
4. **CI/CD**: деплоит свои проекты через git push

## Безопасность

- Контейнер НЕ имеет доступа к Docker socket основного хоста
- Нет доступа к сети основного Subbrain (только интернет)
- Memory/CPU лимиты предотвращают DoS
- Volume — только /home/agent, остальное read-only
- Агент НЕ может модифицировать основной Subbrain сервер

## Реализация

### Phase 1: Docker exec через Bun
- Subbrain основной подключается к Docker API (`/var/run/docker.sock`)
- `dev_exec` → `docker exec subbrain-devmachine <command>`
- Простой паттерн: exec + capture stdout/stderr

### Phase 2: Git integration
- Агент создаёт GitHub аккаунт (или используем service account)
- Настраивает SSH key в volume
- Может push/pull проекты

### Phase 3: Auto-deploy
- Агент пишет Dockerfile + docker-compose в своём volume
- Через отдельный "deploy" tool запускает свои проекты
- Отдельная Docker network для его проектов
