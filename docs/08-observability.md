# 08. Observability

> Статус: ✅ Реализовано

## Цель

Мониторинг использования ресурсов: RPM, токены, латентность, стоимость. Без этого «свободное плавание» может незаметно выжрать все RPM.

## Метрики

| Метрика           | Тип       | Описание                                 |
| :---------------- | :-------- | :--------------------------------------- |
| `rpm_current`     | gauge     | Текущий RPM (за последнюю минуту)        |
| `rpm_by_priority` | gauge     | RPM по приоритетам (critical/normal/low) |
| `rpm_by_model`    | gauge     | RPM по моделям                           |
| `tokens_in`       | counter   | Input токены (суммарно и по модели)      |
| `tokens_out`      | counter   | Output токены                            |
| `latency_ms`      | histogram | Время ответа по этапам (pre/main/post)   |
| `errors_total`    | counter   | Ошибки по типам (429, 5xx, timeout)      |
| `queue_depth`     | gauge     | Глубина очереди Rate Limiter'а           |

## Хранение

- **В SQLite** (отдельная таблица `metrics`) — для ночного анализа
- **В памяти** — sliding window для текущих gauge

## Доступ

- `GET /metrics` — текущее состояние (JSON)
- Ночной цикл читает SQLite для формирования отчёта

## Бюджет RPM

```
40 RPM total
├── User-facing:    ~30 RPM (6 RPM × ~5 параллельных запросов)
├── Background:     ~8 RPM (post-processing, embed updates)
└── Autonomous:     ~2 RPM (свободное плавание — только при простое)
```

## Открытые вопросы

- [ ] Prometheus-формат или кастомный JSON?
- [ ] Алерты при RPM > 35?
- [ ] Dashboard (CLI / web / просто логи)?
