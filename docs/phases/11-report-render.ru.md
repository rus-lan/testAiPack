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
   в stdout). Секции идут в порядке headline → detail (см.
   `.research/metrics-expansion/spec.md` §2.0) — заголовок держит только
   вердикт-несущие/интерпретирующие факты, детали идут ниже:
   a. **Header** — run-id, repo, pack (или `smoke-test`), timestamp; + строка
      предупреждения о рассинхроне версии opencode (P13, см. §2 ниже).
   b. **Summary** — существующие бакеты Improvements/Regressions/Neutral, плюс
      до двух alert-строк наверху: pack-noop (P1) и «⚠ N risky command(s)
      detected — see Safety» (P2).
   c. **Primary metrics (delta)** — таблица по 7 первичным метрикам
      (`totalTokens`, `wallClockMs`, `costUsd`, `stepCount`, `toolCallCount`,
      `successRank`, `maxParallelism`) + новые колонки `[min–max]` (и `IQR=`,
      если есть) на каждую сторону (P3); плюс блок **Stability** — success
      rate, гистограмма рангов, флаг `unstable`, и строка `verify: X/Y passed`,
      если есть `verifyStats` (P10).
      | Метрика | old median | old [min–max] | new median | new [min–max] | Δ | Δ% | Significant | Вердикт |
      Вердикт = ✓ (улучшение), ⚠ (значимо хуже,
      `MetricDelta.significant === true` и `better === "worse"`), — (в шуме).
      Новые метрики waves 1+2 **не входят** в эту таблицу и не имеют вердикта.
   d. **Pack signal** (P1) — per-side calls/errors/runs-with-call/first-call
      median; `_pack use is not visible for this pack type_`, если
      `canDetect === false`. Секция отсутствует, если `packUse` нет ни на
      одной стороне (смоук-ран или старый report.json).
   e. **Safety** (P2) — таблица опасных bash-команд (`riskyCommands`) по
      сторонам; отсутствует, если оба списка пусты/не заданы.
   f. **Secondary metrics** — по сторонам, перегруппировано в 4 именованных
      блока (в md — вложенные списки, в html — `<details>`, первый открыт):
      **Behavior** (finish causes, max same-tool streak, invalid/duplicate/
      bashFail-счётчики, топ error-текстов, per-tool breakdown), **Latency**
      (step p50/p95, reasoning time + доля от wall-clock, P5-строка «first
      tool/first edit/worst stall»), **Tokens & context** (token breakdown +
      cacheWrite, P11-контекст first/last step tokens), **Output volume**
      (File diff totals + P12 text/reasoning char counts).
   g. **Failed runs** — секция присутствует только если `summary.failures`
      непустой: таблица `(side, runIndex, errorCode, errorMessage)`.
   h. **LLM-судья** — секция присутствует только если `judge !== undefined`:
      вердикт, баллы, explanation (или «did not run», см.
      `docs/phases/09-judge.ru.md`).
   i. **Timeline summary** — топ-N долгих событий.
   j. **Diff summary** — существующие ссылки на патчи + P8 (median tokens per
      changed line, cost per file) + P9 (per-file overlap: both/only-old/
      only-new, до 15 путей).
   k. Футер: пути к `report.json`, `timeline.html`, `review.code-workspace`.

   Каждая новая строка/секция пропускается, если соответствующее поле
   `undefined` — старый `report.json` (без waves 1+2 полей) рендерится ровно
   как раньше, без новых секций и строк.
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
| `packUse` нет ни на одной стороне                    | секция Pack signal отсутствует                     | —                    |
| `packUse.canDetect === false`                        | строка «pack use is not visible for this pack type» вместо чисел | — |
| `packUse.calls === 0` на NEW и `canDetect === true`  | alert в Summary: «pack was never invoked...»        | —                    |
| `riskyCommands` пусты/не заданы с обеих сторон       | секция Safety отсутствует                          | —                    |
| `verifyStats` не задан                                | строка verify в Stability отсутствует              | —                    |
| Старый `report.json` (waves 1+2 полей нет)           | рендер идентичен дорелизному — без новых секций/строк | —                 |
| `wallClockMs = 0` (пустой прогон)                     | строка доли reasoning от wall-clock пропускается (деление на 0) | — |

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
- ✅ primary table [min–max]/IQR: спред-колонки читаются из `stats`;
  `maxParallelism` (нет записи в `AggregateStats`) рендерится как «—».
- ✅ stability block: success rate и гистограмма рангов из
  `stats.successRank.samples`.
- ✅ pack section: рендерит числа при `packUse` заданном; предупреждение при
  `canDetect && calls === 0`; «not visible» при `canDetect === false`;
  секция отсутствует при `packUse` не заданном ни на одной стороне.
- ✅ safety section: список команд с экранированием (`|` в md, HTML-escape в
  html); отсутствует при пустых списках.
- ✅ secondary: строки bash-fails/invalid/duplicates/error-texts —
  пропускаются, когда поле не задано.
- ✅ diff section: tokens-per-line и cost-per-file, `n/a` при нулевом
  знаменателе; per-file overlap — both/only-old/only-new.
- ✅ header: предупреждение о рассинхроне версии при отличии от манифеста;
  тишина при совпадении или отсутствии `opencodeVersions`.
- ✅ secondary группы: md — 4 именованных блока на сторону; html — `<details>`,
  первый открыт.
- ✅ backcompat: `Report`-фикстура без единого нового поля рендерится без
  исключений и без новых секций/строк.
- ✅ real incident fixture (acceptance criterion, см.
  `.research/metrics-expansion/golden-values.md`): один `Report`,
  собранный из golden-значений реальной sample-workspace, одновременно
  показывает Safety с реальной risky-командой, Pack signal с
  baseline-vs-baseline warning, `bashFailCount 5`, drift-warning
  `1.18.3`/`1.18.4`, `[min–max]`-спред, success rate `5/5` на обеих
  сторонах, worst stall `252915ms`, и отсутствие verify-строки.

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
  (отсутствие секции = отсутствие данных, а не ошибка рендера). То же для
  новых секций Pack signal и Safety.
- Ни одна метрика waves 1+2 не входит в `PRIMARY_METRICS` и не несёт
  дельту/вердикт — рендерятся только как detail-факты (см.
  `.research/metrics-expansion/spec.md`).
- Отсутствующая метрика рендерится как отсутствующая строка/секция, никогда
  как `0` — `0` на этих полях означает «измерено, значение ноль», а
  `undefined` — «не измерялось».

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
