# Фаза 07: aggregate

> Спека фазы. Контракт = `contract/phases/07-aggregate.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Прочитать `raw/<variant>/run-{1..N}.json` для **каждого варианта**, извлечь
первичные и вторичные метрики, агрегировать по N прогонам (median/min/max/IQR)
и построить `results/metrics.json` с одним блоком `VariantAggregates` на
вариант плюс блок `MetricsReport` — дельты каждого не-baseline варианта
против одного baseline-варианта (было: дельта `new − old`).

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.Aggregate` (см. `contract/phases/07-aggregate.tsp`).

- Вход: `AggregateInput` — `{ runInput: RunInput, manifest: Manifest,
  workspace: WorkspaceTree, results: VariantRunResults[] }`.
  `VariantRunResults = { name: string, runs: RunResult[] }` — массив
  `RunResult` **на каждый вариант** (`runs` элементов в каждом), результат
  фазы 06. `failedRuns` извлекаются из `RunResult.successRank = 0` (или по
  `errorCode`/`finishCause = "error"`), а не из отдельного кода на варианте.
- Выход: `AggregateResult` — `{ metrics: MetricsReport }` (было: `{
  metricsDiff, rawAggregates }` — `rawAggregates` убран как дублирующий
  `metrics.variants` байт-в-байт).
  - `MetricsReport = { baseline: string, variants: VariantAggregates[],
    deltas: VariantDelta[], allFailed: boolean }`. `variants` — в порядке
    конфига, **включая** baseline; `deltas` — N−1 записей (все НЕ-baseline
    варианты, в порядке конфига).
  - `VariantDelta = { variant: string, deltas: PrimaryDeltas, taskDeltas?:
    PhaseDeltas, initDeltas?: PhaseDeltas, pairIncomplete: boolean }`.
    `PrimaryDeltas` — построчно `MetricDelta` для каждой первичной метрики
    (`totalTokens`, `wallClockMs`, `costUsd`, `stepCount`, `toolCallCount`,
    `successRank`, `maxParallelism`).
  - `MetricDelta = { absolute: float64, percent?: float64, significant:
    boolean, better: "better" | "worse" | "neutral" | "context-dependent" }`.
    `percent` опционален: переход `0 → 0` даёт `percent = 0` (реально нет
    изменения), переход `0 → ненулевое` **не** имеет осмысленного процента
    (математически бесконечность) — поле опускается целиком, а не
    выставляется в обманчивый `0`. Рендер отчёта показывает «n/a» вместо
    процента, когда поле отсутствует.
- Ошибки: `@error AggregateError` — `{ code, message, variant: string,
  runIndex?: int32, context? }`, где `code` принимает только одно значение:
  - `E_EXPORT_INVALID` — `raw/<variant>/run-N.json` не проходит схему
    `OpencodeExport` (или файл отсутствует, и при этом соответствующий
    `RunResult` не помечен как failed в фазе 06).

  Случай «все варианты все прогоны failed» не падает с ошибкой — он отражается
  в `MetricsReport.allFailed = true` (контракт не выделяет для этого кода;
  было `MetricsDiff.bothFailed`, теперь обобщено на N).

`VariantAggregates` содержит (переименовано из `SideAggregates`):
- `variant: string` (было `side: Side`).
- `primary: PrimaryMetrics` — median-снимок первичных метрик по N прогонам:
  `totalTokens`, `wallClockMs`, `costUsd`, `stepCount`, `toolCallCount`,
  `successRank`, `maxParallelism`. Используется в дельте (`PrimaryDeltas`) и в
  рендере отчёта; полные распределения живут отдельно в `stats`.
- `secondary: SecondaryMetrics` — не изменилась структурно (см. `03-hard-
  problems.md`, waves 1+2 сохранены как есть; `perTool`,
  `finishCauseDistribution`, P5/P11/P12-сигналы — см. таблицу ниже).
- `stats: AggregateStats` — полное распределение (`MetricDistribution`:
  `median`/`min`/`max`/`iqr?`/`samples[]`) по N прогонам для каждой первичной
  метрики.
- `failedRuns: FailedRun[]` — `FailedRun = { variant, runIndex, errorCode,
  errorMessage, timestamp }` (поле `variant` — новое, решение D17: раньше
  `FailedRun` не несло атрибуции стороны на своём уровне, потому что жило
  внутри `SideAggregates.<side>`; теперь `ReportSummary.failures` — плоский
  список по всем вариантам, атрибуция обязана быть на самой записи).
- `rawRunIds: string[]` — `sessionId` прогонов, вошедших в агрегацию.
- `packUses?: PackUse[]` — **одна запись на каждый пак, объявленный этим
  вариантом** (было: единственный опциональный `packUse`) — `variant.packs`
  не ограничен числом (Stage 2 снял guard `≤1`), контракт был массивом с
  самого начала. Каждая запись несёт `pack: string` (имя пака).
- `riskyCommands?: RiskyCommand[]` — опасные bash-команды, найденные во всех
  прогонах варианта.
- `opencodeVersions?: string[]` — различные значения `export.info.version`,
  встреченные в прогонах варианта.
- `verifyStats?: VerifyStats` — исход `--verify` по всем прогонам варианта.
- `contaminationSignals?: ContaminationSignal[]` — сигналы, что этот вариант
  приобрёл/использовал ЧУЖОЙ пак (см. §3, шаг 2b). Каждая запись несёт
  `pack: string` — какой именно чужой пак засветился (было: contamination
  проверялась только на стороне `old` против единственного `--pack`; теперь
  — на КАЖДОМ варианте против его собственного «чужого множества»).
- `phaseSplit?: PhaseSplit` — разбиение init/task (см. §9).

`VariantDelta` — построчная разница `V.median − baseline.median` с
`significant: boolean` и `better` ∈ `"better" | "worse" | "neutral" |
"context-dependent"`.

### Новые модели (waves 1+2, не изменились структурно относительно v1)

```tsp
model PackUse {
  pack: string;                 // NEW в v2 — какой пак эта запись описывает
  calls: int32; errors: int32; runsWithCall: int32; runCount: int32;
  firstCallMsMedian?: int64; canDetect: boolean;
  visibilityConfirmed?: boolean; runsWithoutCall?: int32[];
}
model RiskyCommand { runIndex: int32; command: string; completed: boolean; exitCode?: int32; }
model VerifyStats { passed: int32; failed: int32; timedOut: int32; runCount: int32; }
model ContaminationSignal {
  kind: "skill-call" | "bash-install" | "install-drift";
  pack: string;                 // NEW в v2 — ЧЕЙ чужой пак засветился
  detail: string; runIndex?: int32;
}
```

`SecondaryMetrics` — без структурных изменений относительно v1 (все поля
optional, см. `contract/main.tsp`): `invalidToolCalls?`, `duplicateToolCalls?`,
`bashFailCount?`, `toolErrorTexts?`, `timeToFirstToolMs?`,
`timeToFirstEditMs?`, `maxEventGapMs?`, `stallCount?`, `stalledRunCount?`,
`firstStepInputTokens?`, `lastStepInputTokens?`, `textChars?`,
`reasoningChars?`, `cacheWriteTokens?`. Агрегация каждого поля (сумма /
медиана / MAX) не изменилась — см. таблицу в старой версии этого документа
или `contract/main.tsp`, doc-комментарии над `SecondaryMetrics`.

## 3. Шаги алгоритма

1. Один раз за фазу (до цикла по вариантам): для каждого пака реестра
   `canDetect = pack.type === "skill"` (только skill-паки видны как
   tool-части в экспортах; plugin/mcp/agent/command невидимы, и это явно
   помечается, а не тихо читается как «0 вызовов»).
2. Для **каждого варианта** `v` из `runInput.variants` (`aggregateVariant`):
   a. Для каждого `runIndex ∈ 1..runs`: прочитать `raw/<v.name>/run-<runIndex>.json`.
      Если файл отсутствует или невалиден по схеме `OpencodeExport`:
      - если соответствующий `RunResult.successRank = 0` (failed run из
        фазы 06) → добавить в `VariantAggregates.failedRuns` запись
        `FailedRun` (`variant: v.name`), **пропустить** в агрегации;
      - иначе → throw
        `AggregateError({ code: "E_EXPORT_INVALID", variant: v.name, runIndex, context: { reason: "missing or invalid export" } })`
        (неожиданно битый export).
   b. Извлечь первичные метрики из export-а: `totalTokens`, `wallClockMs`,
      `costUsd` (приоритет `info.cost` > `pricing.json` > `0`), `stepCount`,
      `toolCallCount`, `successRank` (из `RunResult.successRank`),
      `maxParallelism` — без изменений относительно v1.
   c. Извлечь вторичные метрики и `extras` (pack-вызовы **по каждому объявленному
      этим вариантом паку**, опасные команды, дубли, невалидные вызовы, тексты
      ошибок, P11/P12-сигналы — `src/metrics/extract.ts`,
      `ExtractOptions.packNames: readonly string[]` вместо старого
      `packName?: string` — `packCalls`/`packErrors`/`firstPackCallMs` стали
      per-name картами, потребляемыми циклом `buildPackUse` по каждому паку
      варианта).
   d. Прочитать `raw/<v.name>/run-<runIndex>.events.ndjson` и построить
      P5-профиль через `src/metrics/events-profile.ts#profileEvents` — без
      изменений относительно v1.
   e. **Contamination — обобщена на «чужое множество» варианта.** Для КАЖДОГО
      чужого пака (`foreignPacksOf(runInput, v)` — объединение паков всех
      ДРУГИХ вариантов минус свой набор) вызывается `findPackActivitySignals`
      с именем этого чужого пака (тот же матчер, что раньше проверял
      единственный `--pack`, теперь параметризован именем и запускается по
      разу на каждый чужой пак). Раньше это работало только для `side ===
      'old'` против единственного `--pack`; теперь — для КАЖДОГО варианта
      против его собственного чужого множества, включая варианты с паками —
      вариант с одним паком всё равно может «подцепить» другой чужой пак.
      Свой собственный пак никогда не попадает в проверку contamination на
      самого себя. `findConfigDriftSignal` (drift-детектор install-файлов)
      не привязан к конкретному чужому паку — variant-level, срабатывает для
      каждого варианта одинаково.
   f. Посчитать `VerifyStats` по всем прогонам варианта.
3. Агрегировать по N **успешных** прогонов (failedRuns исключены) —
   `MetricDistribution`, `primary`, `secondary` — без изменений относительно
   v1. `packUses` собирается по одной записи на каждый пак, объявленный
   вариантом — число паков на вариант не ограничено (Stage 2), так что
   `packUses` может нести произвольное число записей, не только 0 или 1.
4. Вычислить `MetricsReport` (`computeMetricsReport(baseline, variants)`):
   - найти `VariantAggregates` варианта с именем `runInput.baseline`
     (`baselineOf`);
   - для каждого НЕ-baseline варианта `v` (в порядке конфига) —
     `computeVariantDelta(baseline, v)`:
     - `absolute = v.primary.<m> − baseline.primary.<m>` (было `new − old`,
       теперь `V − baseline`, тот же знак условности).
     - `percent`: `0` при переходе `0 → 0`, опущен при переходе `0 →
       ненулевое`, иначе `absolute / baseline.primary.<m> * 100`.
     - `significant: boolean` — `|absolute| > 1.5 × baseline.stats.<m>.iqr`
       (если `iqr` есть) — **всегда против IQR baseline-варианта**, тот же
       асимметричный принцип, что и раньше (`old`-сторона была
       control-группой; теперь ей стал явно назначенный `baseline`). Это
       намеренно: при N≈3 прогонах ни один разброс не является настоящей
       оценкой дисперсии, IQR baseline-а — просто общий эталон.
     - `pairIncomplete: boolean = !hasSamples(baseline) || !hasSamples(v)` —
       обобщение `anyFailed`: дельты всё равно считаются (абсолютное/процент
       рендерятся), но принудительно non-significant/neutral.
     - `taskDeltas`/`initDeltas` — присутствуют по тем же правилам, что и
       раньше (см. §9), теперь на пару (baseline, v).
   - `allFailed = true`, если **все** варианты (не только baseline и один
     другой) не имеют успешных прогонов (обобщение `bothFailed`).
5. **Множественные сравнения (N−1 > 1).** Отчёт (фаза 11) добавляет
   одностроковую оговорку под главной таблицей, когда `deltas.length > 1`:
   N−1 тестов значимости против ОДНОГО baseline при фиксированном пороге
   1.5×IQR линейно завышают family-wise ложноположительный risk. Коррекции
   (Bonferroni и т.п.) сознательно нет — правило и так эвристика на 3–5
   прогонах; поправка в основном превратила бы всё в «шум» и сбивала бы с
   толку в другую сторону. Сама эта фаза только формирует данные; текст
   оговорки — в рендере (фаза 11).
6. Сериализовать `AggregateResult { metrics }` в `results/metrics.json`
   (stable keys). Вернуть `AggregateResult { metrics }`.

## 4. Входные/выходные файлы

| Файл                          | Чтение/Запись | Схема (TypeSpec/Zod) |
| ----------------------------- | ------------- | -------------------- |
| `raw/<variant>/run-<n>.json`     | Чтение        | `OpencodeExport`     |
| `raw/<variant>/run-<n>.events.ndjson` | Чтение   | streamed events (P5) |
| `pricing.json` (если задан)   | Чтение        | `Pricing`            |
| `results/metrics.json`        | Запись        | `AggregateResult`    |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                          | Код                  |
| --------------------------------------------------- | -------------------------------------------------- | -------------------- |
| Один прогон из 3 (любого варианта) failed           | исключается из median, попадает в `failedRuns`     | —                    |
| Один прогон failed, но `RunResult.successRank` ≠ 0  | throw                                              | `E_EXPORT_INVALID`   |
| Все прогоны одного варианта failed                  | `stats.<m>.samples = []`, `primary` из 0/null      | —                    |
| Все прогоны ВСЕХ вариантов failed                   | `MetricsReport.allFailed = true` (не throw)        | —                    |
| Все прогоны только baseline или только `v` failed   | `pairIncomplete = true` для этой пары; остальные пары считаются нормально | — |
| `pricing.json` отсутствует, `info.cost` тоже нет    | `costUsd = 0`, warning в логе                      | —                    |
| `N < 4`                                             | `iqr` не задаётся в `MetricDistribution`           | —                    |
| `baseline.primary.<m> = 0`, `v.primary.<m> ≠ 0`     | `deltas.<m>.percent` не задан (не `0`)              | —                    |
| N-1 > 1 (3+ варианта)                                | отчёт (фаза 11) добавляет multiple-comparisons оговорку | —                |
| Вариант объявил пак, отсутствующий у других          | `contaminationSignals` для него не проверяет собственный пак | —          |
| Вариант с 0 объявленных паков                       | `packUses` не задаётся (пуст)                       | —                    |
| Два варианта делят один и тот же пак                | пак не входит в чужое множество ни у одного из двух — contamination против него не проверяется ни у одного | — |
| Ни у одного варианта нет `events.ndjson`             | P5-поля не заданы вовсе                             | —                    |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path N=3, legacy-шим: 6 прогонов валидны → `VariantAggregates` с
  `median/min/max`, `iqr` не задан (N<4), `deltas.length === 1`.
- ✅ N-way happy-path: 3 варианта, `runs = 3` → `metrics.variants` содержит 3
  записи в порядке конфига, `metrics.deltas` — 2 записи (не-baseline варианты
  в порядке конфига).
- ✅ significance против baseline: фикстура с известными сэмплами baseline'а
  доказывает, что `significant` переключается ровно на 1.5×IQR ИМЕННО
  baseline-варианта, а не варианта V.
- ✅ contamination fixture: экспорт варианта a содержит `npm install
  <b-pack>` → сигнал на варианте a с `pack: 'b-pack'`; собственный пак
  варианта не триггерит сигнал на самого себя.
- ✅ shared pack no contamination: пак объявлен вариантами a и b →
  ни у a, ни у b нет сигнала друг против друга по этому паку.
- ✅ one failed run: один прогон помечен `E_RUN_CRASH` (successRank 0) →
  исключён из median, в `failedRuns` (с `variant`, `errorCode = "E_RUN_CRASH"`).
- ✅ all failed one variant: все прогоны варианта b failed →
  `metrics.variants[b].stats.<m>.samples = []`, `deltas[b].pairIncomplete === true`.
- ✅ all failed all variants: `metrics.allFailed = true` (не throw).
- ✅ export invalid no code: `raw/a/run-2.json` повреждён, соответствующий
  `RunResult.successRank ≠ 0` → throw `E_EXPORT_INVALID` с `variant: 'a',
  runIndex: 2`.
- ✅ percent omitted on 0→N / percent zero on 0→0 — как раньше, теперь
  `baseline.primary.<m>` вместо `old.primary.<m>`.
- ✅ pack detected by name / not detectable / absent — как раньше, теперь по
  каждому объявленному паку варианта отдельно (`packUses[]`, не единственный
  `packUse`).
- ✅ risky command / duplicate calls / bashFailCount / toolErrorTexts / events
  profile / verifyStats — без изменений семантики, теперь атрибутированы
  `variant`.
- ✅ backcompat: `reportSchema`/`aggregateResult`-схема парсит `metrics.json`,
  записанный до появления новых полей.
- ✅ multi-pack variant: вариант объявляет 2 пака → `packUses` содержит 2
  записи (по одной на пак), обе агрегированы независимо.
- ❌ НЕ покрыто (ticket): значимость через bootstrap CI.
- ❌ НЕ покрыто (ticket): `maxParallelism` при очень глубоком дереве сессий.

## 7. Инварианты

- После фазы `results/metrics.json` существует и содержит `AggregateResult`
  с единственным полем `metrics` (`MetricsReport`).
- Число записей в `VariantAggregates.failedRuns` равно числу прогонов со
  `successRank = 0` из фазы 06, для этого варианта (никаких «тихих»
  исключений).
- `MetricDistribution.samples` либо содержит N значений (есть хотя бы один
  успешный прогон), либо пуст (все прогоны варианта failed).
- `metrics.deltas.length === metrics.variants.length − 1` — ровно по записи
  на каждый НЕ-baseline вариант.
- `metrics.deltas[*].pairIncomplete === true` ⇔ baseline или этот вариант не
  имеют успешных прогонов; `metrics.allFailed === true` ⇔ ВСЕ варианты не
  имеют успешных прогонов.
- Происхождение `costUsd` фиксировано приоритетом в реализации:
  `info.cost` > `pricing.json` > `0`.
- Значимость каждой дельты вычисляется против IQR **baseline-варианта**, не
  против IQR самого сравниваемого варианта — единый эталон для всех N−1
  сравнений.
- `contaminationSignals`/`packUses` не путают «свой» пак варианта с «чужим»:
  свой никогда не порождает сигнал contamination на самого себя; чужое
  множество вычисляется как объединение паков всех ДРУГИХ вариантов минус
  собственный набор (`foreignPacksOf`).

## 8. Зависимости от других фаз

- Зависит от: **06 run-side** (`results: VariantRunResults[]` + массив
  `raw/<variant>/run-N.json` + `raw/<variant>/run-N.events.ndjson`), **00
  cli-parse** (`runInput.packs`/`variants`/`baseline` для pack-детекции и
  выбора baseline). Использует чистые модули `src/metrics/extract.ts`,
  `src/metrics/events-profile.ts` (`profileEvents`),
  `src/metrics/baseline-contamination.ts` (`findPackActivitySignals`,
  `findConfigDriftSignal`) — все без side-effects, фаза 07 только вызывает
  их и пишет результат.
- Блокирует: **11 report-render** (нужен `MetricsReport` для главной таблицы
  дельт и для новых секций Pack signal / Safety / Stability).
- Параллелизуется с: **08 diff**, **09 judge** — все три читают независимые
  артефакты фазы 06 и не мешают друг другу.

## 9. Разбиение init/task (metric-split)

Один прогон одного варианта исполняет до двух вызовов opencode CLI в ОДНОЙ
сессии: `--init` (если у варианта есть эффективный `init`,
`src/phases/06-run-side.ts`), затем `--prompt` продолжением той же сессии
(`--continue`). Один export покрывает оба вызова, поэтому все метрики,
извлекаемые из export-а, до сих пор смешивали init и task. Разбиение делит
пять «расщепляемых» первичных метрик (`totalTokens`, `wallClockMs`,
`costUsd`, `stepCount`, `toolCallCount`) между двумя фазами. Механика границы
(`findPhaseBoundary`, второе user-role сообщение) и приоритет стоимости среза
не изменились относительно v1 — см. предыдущую версию этого раздела или
`src/metrics/extract.ts`.

**Новые/переименованные модели контракта** (`contract/main.tsp`):

```tsp
model PhaseSlice { totalTokens: int64; wallClockMs: int64; costUsd: float64; stepCount: int32; toolCallCount: int32; }
model PhaseSliceStats { totalTokens: MetricDistribution; wallClockMs: MetricDistribution; costUsd: MetricDistribution; stepCount: MetricDistribution; toolCallCount: MetricDistribution; }
model SetupSegment { wallClockMs: int64; }  // harness pack-setup, до агент-сессии — ТОЛЬКО wall-clock
model PhaseSplit {                          // было SidePhaseSplit — переименовано (члены не изменились)
  runsWithInit: int32; runsWithLostInit: int32;
  init?: PhaseSlice; initStats?: PhaseSliceStats;
  task: PhaseSlice; taskStats: PhaseSliceStats;
  costProrated?: boolean;
  setup?: SetupSegment; setupStats?: MetricDistribution;
}
model PhaseDeltas { totalTokens: MetricDelta; wallClockMs: MetricDelta; costUsd: MetricDelta; stepCount: MetricDelta; toolCallCount: MetricDelta; }
```

- `VariantAggregates.phaseSplit?: PhaseSplit` — медиана/распределение `task`
  по ВСЕМ успешным прогонам варианта (прогон без init — task = whole run);
  `init`/`initStats` только по прогонам с границей.
- `VariantDelta.taskDeltas?: PhaseDeltas` — присутствует, когда И baseline, И
  вариант `v` несут `phaseSplit` (значимость — по IQR task-распределения
  baseline-варианта, тот же принцип, что и у whole-run дельт).
- `VariantDelta.initDeltas?: PhaseDeltas` — присутствует, ТОЛЬКО когда И
  baseline, И `v` имеют `runsWithInit > 0`. При одностороннем init
  init-стоимость рендерится как медиана/разброс, НИКОГДА не как дельта.
- `ReportSummary.basis?: "task" | "total"` — какая база питала заголовок и
  бакеты improvements/regressions/neutral: `"task"`, когда `taskDeltas`
  присутствует (и при одностороннем, и при двустороннем init на паре с
  baseline); `"total"` только если разбиения нет вовсе. Правило не изменилось
  относительно v1 — теперь просто оценивается на пару (baseline, каждый
  не-baseline вариант) независимо; отчёт раскрывает, если базис расходится
  между парами (см. `docs/phases/11-report-render.ru.md`).

**`RunResult`** несёт (не изменилось относительно v1, просто переименован
носитель — `RunResult`, было `RunSideResult`): `initRan?: boolean`,
`initWallMs?: int64`, `promptWallMs?: int64`, `setupWallMs?: int64` — все от
фазы 06 (harness-таймеры `Date.now()`).

**Ретрофит.** `testaipack report --rebuild` пересчитывает фазу 07 из
`raw/<variant>/run-N.json` на диске — разбиение получается «бесплатно». Для
v1-воркспейсов (см. `src/compat/legacy.ts`) `phaseSplit` синтезируется по тем
же данным через маппинг v1 → v2 (`SidePhaseSplit` → `PhaseSplit`, поля не
менялись, только имя модели).
