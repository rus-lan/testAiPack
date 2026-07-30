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
  - `MetricDelta = { absolute: float64, percent?: float64, significant:
    boolean, better: "better" | "worse" | "neutral" | "context-dependent" }`.
    `percent` опционален: переход `0 → 0` даёт `percent = 0` (реально нет
    изменения), переход `0 → ненулевое` **не** имеет осмысленного процента
    (математически бесконечность) — поле опускается целиком, а не
    выставляется в обманчивый `0`. Рендер отчёта показывает «n/a» вместо
    процента, когда поле отсутствует.
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
  `maxConsecutiveSameTool`, плюс новые опциональные поля (см. ниже). Файловые
  дельты (additions/deletions/filesChanged) сюда не входят — `SecondaryMetrics`
  не несёт `fileDiffStats` (поле было убрано: оно строилось из `info.summary`
  экспорта opencode, а этот API реальными числами не заполняется, и фаза 07 в
  принципе не может увидеть результат фазы 08). Единственный источник этих
  чисел — `report.diff` из фазы 08 (см. `docs/phases/08-diff.ru.md`);
  рендереры читают их оттуда.
- `stats: AggregateStats` — полное распределение (`MetricDistribution`:
  `median`/`min`/`max`/`iqr?`/`samples[]`) по N прогонам для каждой первичной
  метрики (`totalTokens`, `wallClockMs`, `costUsd`, `stepCount`,
  `toolCallCount`, `successRank`). Дополняет `primary` детальной картиной
  разброса.
- `failedRuns: FailedRun[]` — массив `FailedRun = { runIndex, errorCode:
  ErrorCode, errorMessage, timestamp }` для прогонов со `successRank = 0`.
- `rawRunIds: string[]` — `sessionId` прогонов, вошедших в агрегацию.
- `packUse?: PackUse` — использование пака за все прогоны стороны (см. ниже).
  Отсутствует, если `--pack` вообще не задан.
- `riskyCommands?: RiskyCommand[]` — опасные bash-команды, найденные во всех
  прогонах стороны. Присутствует (может быть пустым `[]`) всякий раз, когда
  хотя бы один прогон был успешно извлечён; отсутствует целиком, если ни один
  прогон стороны не дошёл до извлечения (нечего было проверять).
- `opencodeVersions?: string[]` — различные значения `export.info.version`,
  встреченные в прогонах стороны, отсортированные. Та же логика присутствия,
  что у `riskyCommands`.
- `verifyStats?: VerifyStats` — исход `--verify` по всем прогонам стороны
  (включая failed — verify мог пройти до краха). Отсутствует, если `--verify`
  не задавался (нет ни одного прогона с verify-данными).

`MetricDelta` — построчная разница `new − old` с `significant: boolean` и
`better` ∈ `"better" | "worse" | "neutral" | "context-dependent"`.

### Новые модели (waves 1+2, см. `.research/metrics-expansion/spec.md`)

```tsp
model PackUse {
  calls: int32;               // сумма подходящих skill-вызовов по успешным прогонам
  errors: int32;               // из них с state.status === "error"
  runsWithCall: int32;         // прогонов хотя бы с одним вызовом
  runCount: int32;              // всего успешных прогонов, инспектировано
  firstCallMsMedian?: int64;   // медиана (state.time.start − info.time.created) по прогонам-с-вызовом
  canDetect: boolean;          // false для plugin/mcp/agent/command — их не видно в экспортах
}

model RiskyCommand {
  runIndex: int32;
  command: string;             // bash input.command, обрезан до 300 симв.
  completed: boolean;          // state.status === "completed"
  exitCode?: int32;            // state.metadata.exit, если есть
}

model VerifyStats {
  passed: int32;    // verifyExitCode === 0
  failed: int32;    // verifyExitCode есть и ≠ 0
  timedOut: int32;  // errorCode === "E_VERIFY_TIMEOUT"
  runCount: int32;  // passed + failed + timedOut
}
```

`SecondaryMetrics` расширена (все поля optional — старый `report.json` без
них по-прежнему парсится):

| Поле | Семантика | Агрегация |
|---|---|---|
| `invalidToolCalls?` | сумма tool-частей с `tool === "invalid"` (галлюцинированные вызовы) | **сумма** по прогонам |
| `duplicateToolCalls?` | сумма точных повторов (тот же tool + идентичный JSON input), считая повторы сверх первого | **сумма** |
| `bashFailCount?` | сумма bash-вызовов с `state.metadata.exit !== 0` | **сумма** |
| `toolErrorTexts?` | топ-5 различных `state.error`-текстов по частоте, каждый обрезан до 200 симв. | ранжирование по частоте |
| `timeToFirstToolMs?` | первый `tool_use`-таймстамп минус baseline-таймстамп (см. ниже) | медиана по прогонам |
| `timeToFirstEditMs?` | то же для первого `tool_use` с `part.tool ∈ {edit, write, patch}` | медиана по прогонам-с-правкой, опущено если ни одной |
| `maxEventGapMs?` | наибольший разрыв между соседними таймстампами событий | **MAX** по прогонам (не медиана — иначе (10с,10с,240с) превратится в незаметные 10с) |
| `firstStepInputTokens?` | `tokens.input` ПЕРВОЙ `step-finish`-части | медиана по прогонам |
| `lastStepInputTokens?` | `tokens.input` ПОСЛЕДНЕЙ `step-finish`-части **с `tokens.input > 0`** (fallback — буквально последняя, если такой нет) | медиана по прогонам |
| `textChars?` | сумма длин `text`-частей | медиана по прогонам |
| `reasoningChars?` | сумма длин `reasoning`-частей | медиана по прогонам |
| `cacheWriteTokens?` | `info.tokens.cache.write` | медиана по прогонам (не участвует в дельте/вердикте — см. `.research/metrics-expansion/spec.md`) |

**Baseline для `timeToFirstToolMs`/`timeToFirstEditMs` (метрик-split, см. §9):**
на прогоне с `--init` первый событие стрима — это событие сессии `--init`, а
не `--prompt`; «первый инструмент» без поправки измерял бы, как быстро
отработал init, а не задачу. Baseline теперь — первое событие НА или ПОСЛЕ
границы фаз (`boundaryTs`, §9), если она есть; без границы (прогон без init)
— поведение прежнее, baseline = самое первое событие стрима.

Почему `lastStepInputTokens` не берёт буквально последнюю часть: в реальных
данных последний `step-finish` может нести `tokens.input: 0` (шаг с обнулённым
usage), что искажает «финальный размер контекста». Фолбэк на буквально
последнюю часть срабатывает только если ВСЕ `step-finish` несут `0`.

Почему счётчики редких событий — **сумма**, а не медиана: `(0, 0, 0, 0, 3)` —
медиана 0 спрятала бы единственный реальный инцидент (например,
`rm -rf .git` в одном прогоне из пяти). Тот же аргумент для `maxEventGapMs`
как MAX, а не медианы.

## 3. Шаги алгоритма

1. Один раз за фазу (до цикла по сторонам): определить пак — `runInput.packRef`
   → `detectPack` (`src/pack/detector.ts`, чистая функция; ошибка детекции
   считается «пака нет»). `packName = pack?.name` (имя резолвится для ЛЮБОГО
   типа пака, не только skill — иначе `packUse` пришлось бы либо опускать для
   plugin/mcp/agent/command, что неотличимо от «--pack вообще не задан», либо
   не показывать `canDetect: false` вовсе). `canDetect = pack !== null &&
   pack.type === "skill"` — только skill-паки видны как tool-части в
   экспортах; plugin/mcp/agent/command невидимы, и это явно помечается, а не
   тихо читается как «0 вызовов».
2. Для каждой стороны `side ∈ {old, new}`:
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
   c. Извлечь вторичные метрики (см. секцию 2, `SecondaryMetrics`) и `extras`
      (pack-вызовы, опасные команды, дубли, невалидные вызовы, тексты ошибок,
      P11/P12-сигналы — `src/metrics/extract.ts`, функция `extractExtras`).
   d. Прочитать `raw/<side>/run-<runIndex>.events.ndjson`
      (`RunSideResult.eventsLogPath`) и построить P5-профиль через
      `src/metrics/events-profile.ts#profileEvents` (чистый модуль, фаза 07
      только читает файл). Файл отсутствует/не читается (старый workspace) →
      прогон не даёт P5-точку данных вообще (не `0` — иначе фиктивный «нет
      задержки» смешается с настоящим измерением).
   e. Посчитать `VerifyStats` по всем `sideResults[side]` (успешным и
      failed — verify мог отработать до краха): `passed` = число с
      `verifyExitCode === 0`, `failed` = число с `verifyExitCode` заданным и
      `≠ 0`, `timedOut` = число с `errorCode === "E_VERIFY_TIMEOUT"`,
      `runCount` = сумма трёх. `runCount === 0` → `verifyStats` не задаётся
      (`--verify` не использовался).
3. Агрегировать по N **успешных** прогонов (failedRuns исключены):
   - `MetricDistribution` для каждой первичной метрики (`stats`):
     `median`, `min`, `max`, `samples[]`. Если `N ≥ 4` → `iqr = q3 − q1`;
     иначе `iqr` не задаётся.
   - `primary` (`PrimaryMetrics`) заполняется медианами (или эквивалентной
     сводкой) по каждой метрике.
   - `secondary` дополнительно агрегирует `extras` (сумма/медиана/MAX — см.
     таблицу в §2) и P5-профили (медиана `timeToFirstToolMs`/
     `timeToFirstEditMs`, MAX `maxEventGapMs`).
   - `packUse`/`riskyCommands`/`opencodeVersions`/`verifyStats` собираются на
     `SideAggregates` (не внутри `secondary`) — см. §2.
   - `bothFailed = true` (поле `MetricsDiff`) выставляется, если обе стороны
     имеют пустой набор успешных прогонов.
4. Вычислить `MetricDelta` для каждой первичной метрики (`PrimaryDeltas`):
   - `absolute = new.primary.<m> − old.primary.<m>`.
   - `percent`: если `old.primary.<m> = 0` — `0`, когда `absolute` тоже `0`
     (действительно нет изменения), и **опущен** (не задан), когда
     `absolute ≠ 0` (переход из нуля не выражается в процентах). Иначе
     `absolute / old.primary.<m> * 100`.
   - `significant: boolean` — (v0.1) `false` либо (v0.2) `|absolute| > 1.5 ×
     old.stats.<m>.iqr` (если `iqr` есть).
   - `better` ∈ `"better" | "worse" | "neutral" | "context-dependent"` — для
     «меньше = лучше» (токены, время, стоимость) отрицательный delta = `"better"`;
     для `successRank` положительный delta = `"better"`; для `maxParallelism`
     нейтрально → `"context-dependent"`. Новые метрики (waves 1+2) не входят в
     `PrimaryDeltas` — они render-only, без дельты и вердикта.
5. Если **все** прогоны обеих сторон failed → выставить
   `MetricsDiff.bothFailed = true` (не throw; контракт не выделяет кода).
6. Сериализовать `AggregateResult` (включая `metricsDiff` и `rawAggregates`) в
   `results/metrics.json` (stable keys).
7. Вернуть `AggregateResult { metricsDiff, rawAggregates }`.

## 4. Входные/выходные файлы

| Файл                          | Чтение/Запись | Схема (TypeSpec/Zod) |
| ----------------------------- | ------------- | -------------------- |
| `raw/<side>/run-<n>.json`     | Чтение        | `OpencodeExport`     |
| `raw/<side>/run-<n>.events.ndjson` | Чтение   | streamed events (P5) |
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
| `old.primary.<m> = 0`, `new.primary.<m> ≠ 0`         | `deltas.<m>.percent` не задан (не `0`)              | —                    |
| `old.primary.<m> = 0`, `new.primary.<m> = 0`         | `deltas.<m>.percent = 0`                            | —                    |
| (v0.2) дерево сессий с циклом по parent_id          | visited-set обрывает цикл, warning                 | —                    |
| `--pack` не задан                                   | `packUse` не задаётся ни на одной стороне          | —                    |
| `--pack` задан, но тип не `skill` (plugin/mcp/agent/command) | `packUse` присутствует, `canDetect: false`, `calls: 0` | — |
| Ни одного успешного прогона на стороне              | `riskyCommands`/`opencodeVersions` не заданы (нечего было проверить); `packUse`, если пак задан, всё равно есть с нулями | — |
| `events.ndjson` отсутствует/не читается для прогона | прогон не даёт P5-точку данных (не участвует в медиане/MAX) | — |
| Ни у одного прогона нет `events.ndjson`             | `timeToFirstToolMs`/`timeToFirstEditMs`/`maxEventGapMs` не заданы | — |
| Ни один прогон стороны не звал `--verify`           | `verifyStats` не задаётся                          | —                    |

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
- ✅ percent omitted on 0→N: `old.primary.totalTokens = 0`,
  `new.primary.totalTokens > 0` → `deltas.totalTokens.percent` не задан
  (не `0`); рендер отчёта показывает «n/a».
- ✅ percent zero on 0→0: обе стороны `totalTokens = 0` →
  `deltas.totalTokens.percent = 0` (реальное отсутствие изменения).
- ❌ НЕ покрыто (ticket): значимость через bootstrap CI (v0.2.1).
- ❌ НЕ покрыто (ticket): `maxParallelism` при очень глубоком дереве (>100
  сессий) — ticket по производительности обхода.
- ✅ pack detected by name: skill packRef → `packUse.calls` считает только
  подходящие по имени вызовы.
- ✅ pack not detectable: plugin/mcp packRef → `packUse.canDetect === false`,
  `calls === 0`.
- ✅ pack absent: `--pack` не задан → `packUse` не задаётся ни на одной стороне.
- ✅ risky command captured: `rm -rf .git`-подобная команда в bash-вызове →
  попадает в `riskyCommands` с `runIndex`.
- ✅ invalid tool excluded from perTool: `tool === "invalid"` часть →
  считается в `invalidToolCalls`, не в `perTool`, не ломает
  `maxConsecutiveSameTool`.
- ✅ duplicate calls summed across runs: (3,0,1,1,0) → сумма 5, не медиана.
- ✅ bashFailCount summed, not averaged: (0,0,0,0,3) → сумма 3.
- ✅ toolErrorTexts top-5 by frequency, truncated to 200 chars.
- ✅ events profile wired: `events.ndjson` прогона профилируется, поля P5
  агрегируются медианой/MAX; отсутствующий файл → прогон не даёт точку данных
  (не `0`).
- ✅ verifyStats: exit 0 → passed; exit ≠ 0 → failed; `E_VERIFY_TIMEOUT` →
  timedOut; ни одного verify-прогона → `verifyStats` не задаётся.
- ✅ backcompat: `reportSchema`/`aggregateResult`-схема парсит `metrics.json`,
  записанный до появления новых полей (все они optional).
- ✅ real ground truth: агрегаты по реальной sample-workspace
  (`.research/metrics-expansion/golden-values.md`) совпадают с рукописно
  вычисленными значениями (тест скипается, если workspace недоступен на
  машине).

## 7. Инварианты

- После фазы `results/metrics.json` существует и содержит `AggregateResult` с
  `metricsDiff` (`MetricsDiff`) и `rawAggregates` (`{ old: SideAggregates, new:
  SideAggregates }`).
- Число записей в `SideAggregates.failedRuns` равно числу прогонов со
  `successRank = 0` из фазы 06 (никаких «тихих» исключений).
- `MetricDistribution.samples` либо содержит N значений (есть хотя бы один
  успешный прогон), либо пуст (все прогоны стороны failed).
- `deltas` для каждой первичной метрики определён (`MetricDelta` с
  `absolute`, `significant`, `better`, и `percent`, если он осмысленен —
  переход `0 → ненулевое` его не задаёт); если одна сторона failed,
  `better = "neutral"`.
- `MetricsDiff.bothFailed = true` ⇔ обе стороны не имеют успешных прогонов.
- Происхождение `costUsd` фиксировано приоритетом в реализации:
  `info.cost` > `pricing.json` > `0` (поле `sourceCost` в контракт не входит).
- Новые поля `SecondaryMetrics`/`SideAggregates` (waves 1+2) все optional —
  отсутствие поля означает «не измерено», а не `0`; редкие события (invalid/
  duplicate/bashFail) суммируются по прогонам, никогда не усредняются;
  `maxEventGapMs` — MAX, не медиана. Ни одно новое поле не входит в
  `PrimaryDeltas` и не влияет на вердикт.

## 8. Зависимости от других фаз

- Зависит от: **06 run-side** (`sideResults: RunSideResult[]` + массив
  `raw/<side>/run-N.json` + `raw/<side>/run-N.events.ndjson`), **00 cli-parse**
  (`runInput.packRef` для pack-детекции), опционально от `pricing.json`
  (внешний файл). Использует чистые модули `src/pack/detector.ts`
  (`detectPack`) и `src/metrics/events-profile.ts` (`profileEvents`) — оба без
  side-effects, фаза 07 только вызывает их и пишет результат.
- Блокирует: **11 report-render** (нужен `MetricsDiff` для главной таблицы
  дельт и для новых секций Pack signal / Safety / Stability).
- Параллелизуется с: **08 diff**, **09 judge** — все три читают независимые
  артефакты фазы 06 и не мешают друг другу.

## 9. Разбиение init/task (metric-split, `.research/metric-split/spec.md`)

Один прогон одной стороны исполняет до двух вызовов opencode CLI в ОДНОЙ
сессии: `--init` (если задан и `initSide` включает эту сторону,
`src/phases/06-run-side.ts`), затем `--prompt` продолжением той же сессии
(`--continue`). Один export покрывает оба вызова, поэтому все метрики,
извлекаемые из export-а, до сих пор смешивали init и task. Разбиение делит
пять «расщепляемых» первичных метрик (`totalTokens`, `wallClockMs`,
`costUsd`, `stepCount`, `toolCallCount`) между двумя фазами.

**Граница (`src/metrics/extract.ts#findPhaseBoundary`).** Второе
user-role-сообщение экспорта: `U = messages.filter(role === "user")`;
`|U| ≥ 2` → граница `b = U[1]`, `boundaryTs = messages[b].info.time.created`,
init = `messages[0..b-1]`, task = `messages[b..]`; `|U| ≤ 1` → границы нет,
весь export — task (прогон без init IS the task, целиком). Доказано на
реальных данных: суммы `init.<m> + task.<m>` бит-в-бит равны
whole-run-значению для всех пяти метрик и для wall-clock (проверено тестами
против `.testaipack/2026-07-30_09-25-09_b348a2` и `..._b10a40`).

**Стоимость среза (§3 спеки).** Приоритет: (1) сумма `info.cost` по
сообщениям среза, если > 0 — измерено; (2) иначе, если `info.cost` сессии в
целом > 0 — пропорция от него по доле токенов среза, флаг
`costProrated: true` (деривативная величина, никогда не рендерится как
измеренная); (3) иначе — таблица цен по токенам среза (как для whole-run);
(4) иначе `0`.

**Новые модели контракта** (`contract/main.tsp`):

```tsp
model PhaseSlice { totalTokens: int64; wallClockMs: int64; costUsd: float64; stepCount: int32; toolCallCount: int32; }
model PhaseSliceStats { totalTokens: MetricDistribution; wallClockMs: MetricDistribution; costUsd: MetricDistribution; stepCount: MetricDistribution; toolCallCount: MetricDistribution; }
model SetupSegment { wallClockMs: int64; }  // harness pack-setup, до агент-сессии — ТОЛЬКО wall-clock
model SidePhaseSplit {
  runsWithInit: int32; runsWithLostInit: int32;
  init?: PhaseSlice; initStats?: PhaseSliceStats;
  task: PhaseSlice; taskStats: PhaseSliceStats;
  costProrated?: boolean;
  setup?: SetupSegment; setupStats?: MetricDistribution;
}
model PhaseDeltas { totalTokens: MetricDelta; wallClockMs: MetricDelta; costUsd: MetricDelta; stepCount: MetricDelta; toolCallCount: MetricDelta; }
```

- `SideAggregates.phaseSplit?: SidePhaseSplit` — медиана/распределение `task`
  по ВСЕМ успешным прогонам стороны (прогон без init — task = whole run);
  `init`/`initStats` только по прогонам с границей. `runsWithLostInit` —
  прогоны, где фаза 06 знает, что `--init` реально выполнялся
  (`RunSideResultExt.initRan === true`), но export границы не показывает
  («потерянное продолжение сессии», §2.4 спеки) — init-стоимость не
  измерена, а не ноль.
- `MetricsDiff.taskDeltas?: PhaseDeltas` — присутствует, когда ОБЕ стороны
  несут `phaseSplit` (та же честная замена дельт, что и `PrimaryDeltas`, но
  над task-срезом; значимость — по IQR task-распределения OLD-стороны).
- `MetricsDiff.initDeltas?: PhaseDeltas` — присутствует, ТОЛЬКО когда обе
  стороны имеют `runsWithInit > 0` (`--init-side both`). При одностороннем
  init init-стоимость рендерится как медиана/разброс, НИКОГДА не как дельта
  (нечего вычитать у стороны без init).
- `ReportSummary.basis?: "task" | "total"` — какая база питала заголовок и
  бакеты improvements/regressions/neutral. Решено (team lead, 2026-07-30):
  **всегда `"task"`**, когда `taskDeltas` присутствует — и при
  одностороннем, и при двустороннем init; `"total"` только если разбиения
  нет вовсе (старый report.json). Причина: init-шум — не поведение пака (в
  `b348a2` init-срез — модель, воюющая с установкой зависимостей,
  22K–257K токенов между прогонами ОДНОЙ и той же стороны), и total-дельта
  при одностороннем init сравнивает разные по составу нагрузки в принципе.

**`RunSideResult`** получает три новых поля от фазы 06
(`src/phases/06-run-side.ts`, harness-таймеры `Date.now()` вокруг каждого
вызова, НЕ `OnceResult.durationMs` — тот 0 на watchdog/timeout/error-ветках):
`initRan?: boolean`, `initWallMs?: int64`, `promptWallMs?: int64`.
`setupWallMs?: int64` — соседнее поле, harness-обвязка pack-setup-пайплайна
(до агентской сессии), пишется параллельной фазой; фаза 07 читает его для
`SidePhaseSplit.setup`/`setupStats`, медиана по ВСЕМ попыткам стороны
(успешным и failed — setup идёт до агент-сессии, крах агента не портит его
собственное измерение).

**Ретрофит.** `testaipack report --rebuild` пересчитывает фазу 07 из
`raw/<side>/run-N.json` на диске — разбиение получается «бесплатно», без
изменения структуры `rebuild.ts`; для лога-восстановления (нет
`run-N.result.json`) `initRan` берётся из строки `[INIT_DONE]` в `.log`
(`src/recovery/run-recovery.ts`). Проверено на реальной workspace
`b348a2` (см. тест `src/cli/rebuild.test.ts`): числа `phaseSplit` совпадают
с независимо вычисленными вручную по сырым export-ам.

**`timeToFirstToolMs`/`timeToFirstEditMs` — семантика изменилась.**
Пересчитаны на месте (не добавлены параллельные поля): на прогоне с init
теперь измеряют время ДО первого инструмента task-фазы, а не всего стрима.
Отчёты, пересобранные после этого изменения, покажут другие числа для
init-содержащих сторон — это не регрессия производительности, а исправление
метрики, которая раньше молча измеряла init.
