# Фаза 07: aggregate

> Спека фазы. Контракт = `contract/phases/07-aggregate.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Прочитать `raw/<side>/run-{1..N}.json` для обеих сторон, извлечь первичные и
вторичные метрики, агрегировать по N прогонам (median/min/max/IQR) и построить
`results/metrics.json` с двумя блоками `SideAggregates` (одна на сторону) и
блоком `MetricsDiff` (дельта new − old).

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.Aggregate` (см. `contract/phases/07-aggregate.tsp`).

- Вход: `AggregateInput` — `{ runInput: RunInput, manifest: Manifest,
  workspace: WorkspaceTree, sideResults: { old: RunSideResult[]; new:
  RunSideResult[] } }`. Массивы `RunSideResult` на каждую сторону — результат
  фазы 06 (`runs` элементов в каждом). `failedRuns` извлекаются из
  `RunSideResult.successRank = 0` (или по `exitCode`/`finishCause = "error"`),
  а не из отдельного кода на стороне.
- Выход: `AggregateResult` — `{ metricsDiff: MetricsDiff, rawAggregates: { old:
  SideAggregates; new: SideAggregates } }`:
  - `metricsDiff` — общий тип `MetricsDiff = { old: SideAggregates, new:
    SideAggregates, deltas: PrimaryDeltas, bothFailed: boolean }`.
    `PrimaryDeltas` — построчно `MetricDelta` для каждой первичной метрики
    (`totalTokens`, `wallClockMs`, `costUsd`, `stepCount`, `toolCallCount`,
    `successRank`, `maxParallelism`).
  - `rawAggregates` — те же `SideAggregates` по сторонам (для отладки/отчёта).
  - `MetricDelta = { absolute: float64, percent: float64, significant: boolean,
    better: "better" | "worse" | "neutral" | "context-dependent" }`.
- Ошибки: `@error AggregateError` — `{ code, message, side: Side, runIndex?:
  int32, context? }`, где `code` принимает только одно значение:
  - `E_EXPORT_INVALID` — `raw/<side>/run-N.json` не проходит схему
    `OpencodeExport` (или файл отсутствует, и при этом соответствующий
    `RunSideResult` не помечен как failed в фазе 06).

  Случай «все прогоны обеих сторон failed» не падает с ошибкой — он отражается
  в `MetricsDiff.bothFailed = true` (контракт не выделяет для этого кода).

`SideAggregates` содержит:
- `side: Side`.
- `primary: PrimaryMetrics` — median-снимок первичных метрик по N прогонам:
  `totalTokens`, `wallClockMs`, `costUsd`, `stepCount`, `toolCallCount`,
  `successRank`, `maxParallelism`. Используется в дельте (`PrimaryDeltas`) и в
  рендере отчёта; полные распределения живут отдельно в `stats`.
- `secondary: SecondaryMetrics` — `inputTokens`, `outputTokens`,
  `reasoningTokens`, `cacheReadTokens`, `perTool: Record<toolName,
  {count, errorRate, avgDurationMs}>`, `reasoningTimeMs`, `stepLatencyP50Ms`,
  `stepLatencyP95Ms`, `toolLatencyAvgMs`, `finishCauseDistribution`,
  `fileDiffStats`, `maxConsecutiveSameTool`.
- `stats: AggregateStats` — полное распределение (`MetricDistribution`:
  `median`/`min`/`max`/`iqr?`/`samples[]`) по N прогонам для каждой первичной
  метрики (`totalTokens`, `wallClockMs`, `costUsd`, `stepCount`,
  `toolCallCount`, `successRank`). Дополняет `primary` детальной картиной
  разброса.
- `failedRuns: FailedRun[]` — массив `FailedRun = { runIndex, errorCode:
  ErrorCode, errorMessage, timestamp }` для прогонов со `successRank = 0`.
- `rawRunIds: string[]` — `sessionId` прогонов, вошедших в агрегацию.

`MetricDelta` — построчная разница `new − old` с `significant: boolean` и
`better` ∈ `"better" | "worse" | "neutral" | "context-dependent"`.

## 3. Шаги алгоритма

1. Для каждой стороны `side ∈ {old, new}`:
   a. Для каждого `runIndex ∈ 1..runs`: прочитать `raw/<side>/run-<runIndex>.json`.
      Если файл отсутствует или невалиден по схеме `OpencodeExport`:
      - если `sideResults[side][runIndex-1].successRank = 0` (failed run из
        фазы 06) → добавить в `SideAggregates.failedRuns` запись `FailedRun =
        { runIndex, errorCode, errorMessage, timestamp }` (взять код/текст из
        `RunSideError`), **пропустить** в агрегации;
      - иначе → throw
        `AggregateError({ code: "E_EXPORT_INVALID", side, runIndex, context: { reason: "missing or invalid export" } })`
        (неожиданно битый export).
   b. Извлечь первичные метрики из export-а:
      - `totalTokens = input + output + reasoning + cacheRead`.
      - `wallClockMs = max(time_updated) − min(time_created)` по дереву сессий
        (v0.1: по root; v0.2: рекурсивный обход через `parent_id`).
      - `costUsd`: сначала из `info.cost`, если есть; иначе вычислить через
        `pricing.json` (`runInput.pricingPath`) по токенам; иначе `0`.
        (Происхождение значения в контракт не выносится — приоритет
        `info.cost` > `pricing` > `0` фиксирован в реализации.)
      - `stepCount` = число parts с `type = "step-finish"`.
      - `toolCallCount` = число parts с `type = "tool"`.
      - `successRank` = значение из `RunSideResult.successRank` ( finish-cause
        mapping сделан в фазе 06).
      - (v0.2) `maxParallelism` = макс. одновременных активных сессий в
        дереве (по `time_created`/`time_updated` интервалам).
   c. Извлечь вторичные метрики (см. секцию 2, `SecondaryMetrics`).
2. Агрегировать по N **успешных** прогонов (failedRuns исключены):
   - `MetricDistribution` для каждой первичной метрики (`stats`):
     `median`, `min`, `max`, `samples[]`. Если `N ≥ 4` → `iqr = q3 − q1`;
     иначе `iqr` не задаётся.
   - `primary` (`PrimaryMetrics`) заполняется медианами (или эквивалентной
     сводкой) по каждой метрике.
   - `bothFailed = true` (поле `MetricsDiff`) выставляется, если обе стороны
     имеют пустой набор успешных прогонов.
3. Вычислить `MetricDelta` для каждой первичной метрики (`PrimaryDeltas`):
   - `absolute = new.primary.<m> − old.primary.<m>`.
   - `percent = absolute / old.primary.<m> * 100` (если old ≠ 0).
   - `significant: boolean` — (v0.1) `false` либо (v0.2) `|absolute| > 1.5 ×
     old.stats.<m>.iqr` (если `iqr` есть).
   - `better` ∈ `"better" | "worse" | "neutral" | "context-dependent"` — для
     «меньше = лучше» (токены, время, стоимость) отрицательный delta = `"better"`;
     для `successRank` положительный delta = `"better"`; для `maxParallelism`
     нейтрально → `"context-dependent"`.
4. Если **все** прогоны обеих сторон failed → выставить
   `MetricsDiff.bothFailed = true` (не throw; контракт не выделяет кода).
5. Сериализовать `AggregateResult` (включая `metricsDiff` и `rawAggregates`) в
   `results/metrics.json` (stable keys).
6. Вернуть `AggregateResult { metricsDiff, rawAggregates }`.

## 4. Входные/выходные файлы

| Файл                          | Чтение/Запись | Схема (TypeSpec/Zod) |
| ----------------------------- | ------------- | -------------------- |
| `raw/<side>/run-<n>.json`     | Чтение        | `OpencodeExport`     |
| `pricing.json` (если задан)   | Чтение        | `Pricing`            |
| `results/metrics.json`        | Запись        | `AggregateResult`    |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                          | Код                  |
| --------------------------------------------------- | -------------------------------------------------- | -------------------- |
| Один прогон из 3 failed (`successRank = 0`)         | исключается из median, попадает в `failedRuns`     | —                    |
| Один прогон failed, но `RunSideResult.successRank` ≠ 0 | throw                                           | `E_EXPORT_INVALID`   |
| Все прогоны одной стороны failed                   | `SideAggregates.stats.<m>.samples = []`, `primary` из 0/null, `deltas.<m>` neutral | — |
| Все прогоны обеих сторон failed                    | `MetricsDiff.bothFailed = true` (не throw)         | —                    |
| `pricing.json` отсутствует, `info.cost` тоже нет    | `costUsd = 0`/`null`, warning в логе               | —                    |
| `info.cost` есть                                    | используется как `costUsd` (приоритет над pricing) | —                    |
| `N < 4`                                             | `iqr` не задаётся в `MetricDistribution`           | —                    |
| `totalTokens = 0` (пустой прогон)                   | валидное значение 0, не fail                       | —                    |
| (v0.2) дерево сессий с циклом по parent_id          | visited-set обрывает цикл, warning                 | —                    |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path N=3: все 6 прогонов валидны → `SideAggregates` с `median/min/max`,
  `iqr` не задан (N<4), `failedRuns = []`, `bothFailed = false`.
- ✅ happy-path N=4: `iqr` вычислен в каждой `MetricDistribution`, `significant`
  определён.
- ✅ one failed run: один из трёх помечен `E_RUN_CRASH` (successRank 0) →
  исключён из median, в `failedRuns` (с `errorCode = "E_RUN_CRASH"`).
- ✅ all failed one side: все 3 прогона new failed →
  `rawAggregates.new.stats.<m>.samples = []`, `deltas.<m>.better = "neutral"`.
- ✅ all failed both sides: `metricsDiff.bothFailed = true` (не throw).
- ✅ export invalid no code: `raw/old/run-2.json` повреждён, и
  `sideResults.old[1].successRank ≠ 0` → throw `E_EXPORT_INVALID` с `runIndex: 2`.
- ✅ cost from info.cost: export содержит `info.cost = 0.0123` →
  `primary.costUsd = 0.0123`.
- ✅ cost from pricing: `info.cost` нет, есть `pricing.json` → cost вычислен
  по токенам.
- ✅ cost unknown: ни того, ни другого → `costUsd = 0`.
- ✅ successRank aggregation: three runs с rank [4,4,3] → median 4, min 3, max 4
  в `stats.successRank`.
- ✅ perTool aggregation: три прогона с разными наборами tool-ов →
  объединённый `perTool` с усреднённым `errorRate`.
- ❌ НЕ покрыто (ticket): значимость через bootstrap CI (v0.2.1).
- ❌ НЕ покрыто (ticket): `maxParallelism` при очень глубоком дереве (>100
  сессий) — ticket по производительности обхода.

## 7. Инварианты

- После фазы `results/metrics.json` существует и содержит `AggregateResult` с
  `metricsDiff` (`MetricsDiff`) и `rawAggregates` (`{ old: SideAggregates, new:
  SideAggregates }`).
- Число записей в `SideAggregates.failedRuns` равно числу прогонов со
  `successRank = 0` из фазы 06 (никаких «тихих» исключений).
- `MetricDistribution.samples` либо содержит N значений (есть хотя бы один
  успешный прогон), либо пуст (все прогоны стороны failed).
- `deltas` для каждой первичной метрики определён (`MetricDelta` с
  `absolute`, `percent`, `significant`, `better`); если одна сторона failed,
  `better = "neutral"`.
- `MetricsDiff.bothFailed = true` ⇔ обе стороны не имеют успешных прогонов.
- Происхождение `costUsd` фиксировано приоритетом в реализации:
  `info.cost` > `pricing.json` > `0` (поле `sourceCost` в контракт не входит).

## 8. Зависимости от других фаз

- Зависит от: **06 run-side** (`sideResults: RunSideResult[]` + массив
  `raw/<side>/run-N.json`), опционально от `pricing.json` (внешний файл).
- Блокирует: **11 report-render** (нужен `MetricsDiff` для главной таблицы
  дельт).
- Параллелизуется с: **08 diff**, **09 judge** — все три читают независимые
  артефакты фазы 06 и не мешают друг другу.
