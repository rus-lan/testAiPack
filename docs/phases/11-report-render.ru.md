# Фаза 11: report-render

> Спека фазы. Контракт = `contract/phases/11-report-render.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Собрать из `metrics.json`, диффов, `judge.json` и `timeline.html` итоговый
отчёт во всех запрошенных форматах (`--format`): обязательные `report.md` (в
stdout + файл) и `report.json` (файл), опциональные `report.html` и
`report.yaml`.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.ReportRender` (см.
`contract/phases/11-report-render.tsp`).

- Вход: `ReportRenderInput` — `{ runInput: RunInput, manifest: Manifest,
  metricsDiff: MetricsDiff, timeline: Timeline, diff: { old: DiffResult; new:
  DiffResult }, judge?: JudgeResult, summary: ReportSummary }`:
  - `metricsDiff` (`MetricsDiff`) — результат фазы 07.
  - `timeline` (`Timeline`) — результат фазы 10 (значение поля `timeline` из
    `TimelineResult`, не сам `TimelineResult`).
  - `diff` — две `DiffResult` (old/new) из фазы 08.
  - `judge?` — опциональный `JudgeResult` из фазы 09; отсутствует, если судья
    не запрашивалась (`JudgeResultOutput.judge = null`).
  - `summary` (`ReportSummary`) — собранная оркестратором сводка:
    `headlineResult: string`, `improvements: MetricDelta[]`,
    `regressions: MetricDelta[]`, `neutral: MetricDelta[]`,
    `failures: FailedRun[]`.
- Выход: `ReportRenderResult` — `{ formats: OutputFormat[], paths: { md?:
  string; json?: string; yaml?: string; html?: string }, stdoutFormat: "md" |
  "json" }`. `OutputFormat ∈ { "md", "html", "json", "yaml" }`.
  - `formats` — фактически сгенерированные форматы (подмножество из
    `runInput.formats`, всегда включает `"md"`).
  - `paths` — пути к записанным файлам; обязательных нет, все опциональные.
  - `stdoutFormat` — что печатается в stdout (`"md"` всегда; `"json"` — если
    пользователь явно попросил JSON-вывод через CLI флаг).
- Ошибки: `@error ReportRenderError` — `{ code, message, context? }`, где
  `code`:
  - `E_DISK_FULL` — нет места писать отчёт (`ENOSPC`).
  - `E_EXPORT_INVALID` — собранный `Report` не прошёл собственную
    `reportSchema` перед сериализацией в JSON/YAML (внутреннее рассогласование
    контракта выше по цепочке фаз, а не ошибка пользователя). Раньше это было
    непойманным `throw` внутри `Effect.gen` — теперь корректный
    `Effect.fail(reportRenderError(..., "E_EXPORT_INVALID"))`.

  Неверное значение в `formats` или пустой `formats` здесь **не** выделены в
  отдельный код — они клирятся в фазе 00 (`runInput.formats: OutputFormat[]`
  уже отвалидирован).

## 3. Шаги алгоритма

1. Прочитать `runInput.formats` (уже отвалидированный массив `OutputFormat`).
   Должно быть непустое подмножество `{md, html, json, yaml}` — пустой массив
   клирится в фазе 00.
2. **report.md** — рендерим всегда (даже если `"md"` не в `formats`, он нужен
   в stdout). Структура:
   a. Заголовок: run-id, repo, pack (или `smoke-test`), timestamp.
   b. **Главная таблица дельт** — по 6 (v0.1) или 7 (v0.2, +maxParallelism)
      первичным метрикам из `summary.improvements` / `summary.regressions` /
      `summary.neutral`:
      | Метрика | old median | new median | Δ | Δ% | Вердикт |
      Где вердикт = ✓ (улучшение, «меньше = лучше» соблюдено), ⚠ (значимо
      хуже, `MetricDelta.significant === true` и `better === "worse"`), — (в
      шуме, незначимо).
   c. **Failed runs** — секция присутствует только если
      `summary.failures` непустой: таблица `(side, runIndex, errorCode,
      errorMessage)`.
   d. **Карта** — упрощённая сводка: топ-N долгих шагов (по `stepLatencyP95`)
      из вторичных метрик `rawAggregates`.
   e. **LLM-судья** — секция присутствует только если `judge !== undefined`:
      вердикт, баллы, explanation.
   f. **Вторичные метрики** — компактная таблица (perTool, latency, token
      breakdown).
   g. Футер: пути к `report.json`, `timeline.html`, `review.code-workspace`.
3. Печать `report.md` в **stdout** (`stdoutFormat = "md"` по умолчанию) +
   запись в `results/report.md`.
4. **report.json** — canonical: сериализация `metricsDiff` + `timeline` +
   `diff` + `judge` + `summary` + метаданные (`runId`, `generatedAt`,
   `formats`, `testaipackVersion`). Запись в `results/report.json`.
5. Если `"yaml" ∈ formats`: сериализация той же структуры в
   `results/report.yaml`.
6. Если `"html" ∈ formats`: рендер `results/report.html` — полный
   интерактивный отчёт, встраивающий `timeline.html` (через iframe на
   file://-путь или inline). Главная таблица дельт с теми же ✓/⚠/—, блоки
   Failed runs, Карта, LLM-судья. Self-contained, vanilla JS.
7. `ENOSPC` на любой записи → `ReportRenderError({ code: "E_DISK_FULL" })`.
   `Report` не проходит `reportSchema` перед сериализацией (json/yaml) →
   `ReportRenderError({ code: "E_EXPORT_INVALID" })`.
8. Вернуть `ReportRenderResult { formats, paths, stdoutFormat }`.

## 4. Входные/выходные файлы

| Файл                       | Чтение/Запись | Схема (TypeSpec/Zod) |
| -------------------------- | ------------- | -------------------- |
| `results/metrics.json`     | Чтение        | `Metrics`            |
| `diff/<side>/run-N/summary.json` | Чтение   | `DiffSummary`        |
| `results/judge.json`       | Чтение        | `JudgeResult`        |
| `results/timeline.html`    | Чтение (html) | HTML                 |
| `results/report.md`        | Запись        | Markdown             |
| `results/report.json`      | Запись        | canonical report     |
| `results/report.yaml`      | Запись (opt)  | YAML                 |
| `results/report.html`      | Запись (opt)  | self-contained HTML  |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                          | Код                  |
| --------------------------------------------------- | -------------------------------------------------- | -------------------- |
| `formats = []`                                      | невозможный случай — фаза 00 кидает `E_CONFIG_INVALID` | — (через 00)    |
| `formats = ["md"]` (default)                        | пишем только `report.md` + `report.json`           | —                    |
| `formats = ["all"]`                                 | раскрыто в фазе 00 → все 4 формата                 | —                    |
| `summary.failures` пустой                           | секция Failed runs не показывается                 | —                    |
| `judge === undefined` (судья не запрашивалась)      | секция LLM-судья не показывается                   | —                    |
| `judge.verdict = "unclear"`                          | секция показывается с пометкой unclear             | —                    |
| `metricsDiff.bothFailed = true`                     | в таблице Δ показываем 0/null, вердикт «—»         | —                    |
| Нет места писать отчёт                              | fail                                               | `E_DISK_FULL`        |
| Собранный `Report` не проходит `reportSchema`       | fail (до записи файла)                             | `E_EXPORT_INVALID`   |
| `timeline.html` отсутствует (фаза 10 упала)         | `report.html` без timeline-блока, warning          | —                    |
| Очень большая `perTool` (>50 tool-ов)                | показываем топ-20, остальные в раскрытии           | —                    |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path md: `formats = ["md"]` → `report.md` в stdout и файле, есть
  главная таблица дельт с ✓/⚠/—, футер с путями; `ReportRenderResult.formats
  = ["md"]`.
- ✅ md with failed runs: `summary.failures` непустой → секция Failed runs
  показана с кодом ошибки.
- ✅ md without failed runs: `summary.failures = []` → секция отсутствует.
- ✅ md with judge: `judge.verdict = "ok"` → секция LLM-судья с баллами.
- ✅ md judge missing: `judge === undefined` → секция отсутствует.
- ✅ md judge unclear: `judge.verdict = "unclear"` → секция с пометкой.
- ✅ md bothFailed: `metricsDiff.bothFailed = true` → в таблице Δ = 0/null,
  вердикт «—».
- ✅ json canonical: `report.json` валиден, содержит `metricsDiff` +
  метаданные.
- ✅ yaml output: `formats = ["yaml"]` → `report.yaml` существует, парсится
  обратно в ту же структуру.
- ✅ html output: `formats = ["html"]` → `report.html` self-contained,
  встраивает timeline.
- ✅ html timeline missing: фаза 10 упала → `report.html` без timeline-блока,
  warning.
- ✅ formats all: `["md","html","json","yaml"]` → все 4 файла существуют,
  `ReportRenderResult.paths` заполнен полностью.
- ✅ disk full: `ENOSPC` → fail `E_DISK_FULL`.
- ✅ invalid report schema: собранный `Report` не проходит `reportSchema` →
  fail `E_EXPORT_INVALID` (проверено на уровне `renderJson`/`renderYaml` и на
  уровне всей фазы `reportRender`, до записи файла).
- ❌ НЕ покрыто (ticket): PDF-экспорт отчёта — ticket про v0.3.

## 7. Инварианты

- После фазы `results/report.md` и `results/report.json` существуют **всегда**
  (md — даже если `"md"` не в `formats`, для stdout).
- `report.md` напечатан в stdout (`stdoutFormat = "md"` по умолчанию) — это
  основной способ посмотреть результат без открытия файлов.
- `report.json` содержит полное `metricsDiff` + метаданные — достаточен для
  повторного рендера в любой формат без повторного прогона.
- Знаки в таблице дельт согласованы с `MetricDelta.significant` и
  `MetricDelta.better`: ✓ только при `better = "better"`, ⚠ при `significant`
  и `better = "worse"`, — в остальных случаях.
- Секции Failed runs и LLM-судья появляются только когда для них есть данные
  (отсутствие секции = отсутствие данных, а не ошибка рендера).

## 8. Зависимости от других фаз

- Зависит от: **07 aggregate** (`MetricsDiff`), **08 diff** (`DiffResult` для
  блока диффов), **09 judge** (`JudgeResult`, опционально), **10 timeline**
  (`Timeline` для `report.html`).
- Блокирует: — (точка схода артефактов; review-workspace использует те же
  пути файловой системы, но не data-dependency — может идти как до, так и
  после report-render).
- Параллелизуется с: **12 review-workspace** (обе фазы читают готовые
  артефакты, не мешая друг другу; на практике запускаются последовательно для
  удобства логов, но зависимости нет).
