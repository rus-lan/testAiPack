# testaipack — Phase-документация

> Phase-доки — **единственный источник правды** для реализации testaipack.
> TypeSpec-контракты, на которые они ссылаются, лежат в `contract/phases/*.tsp` и
> рассматриваются как нормативное приложение: имена типов, обязательные поля,
> enum-ы и коды ошибок берутся оттуда. В случае расхождения текста фазы и
> TypeSpec-файла приоритет у TypeSpec; текст нужно починить под контракт.

Каждая фаза — это отдельный компонуемый блок Effect-слоя. У них узкие,
хорошо описанные входы и выходы, явный список ошибок и набор тест-кейсов по
одному на ветку контракта. Фазы склеиваются между собой через `RunInput`
(результат `cli-parse`), `Manifest` и `WorkspaceTree` (результат
`workspace-setup`), а не через неявное состояние.

С версии `schemaVersion: 2` («n-way variants», см.
`.research/n-way-variants/`) инструмент сравнивает не жёсткую пару
`old`/`new`, а произвольный список **вариантов** (`RunInput.variants`) с
общим реестром **паков** (`RunInput.packs`) и одним назначенным
**baseline**-вариантом (`RunInput.baseline`). Классическая двусторонняя
командная строка (`--pack`/`--prompt`/`--pure-baseline`/…) не удалена —
фаза 00 десугарирует её в ровно два варианта `old`/`new`, поддерживается
бессрочно (см. `docs/phases/00-cli-parse.ru.md §3.4`).

---

## Канонический список фаз

| #   | Фаза               | Имя файла                        |
| --- | ------------------ | --------------------------------- |
| 00  | cli-parse          | `00-cli-parse.ru.md`             |
| 01  | workspace-setup    | `01-workspace-setup.ru.md`       |
| 02  | repo-clone         | `02-repo-clone.ru.md`            |
| 03  | pack-install       | `03-pack-install.ru.md`          |
| 04  | home-isolation     | `04-home-isolation.ru.md`        |
| 04b | pack-setup         | `04b-pack-setup.ru.md`           |
| 05  | preflight          | `05-preflight.ru.md`             |
| 06  | run-side           | `06-run-side.ru.md`              |
| 07  | aggregate          | `07-aggregate.ru.md`             |
| 08  | diff               | `08-diff.ru.md`                  |
| 09  | judge (опц.)       | `09-judge.ru.md`                 |
| 10  | timeline           | `10-timeline.ru.md`              |
| 11  | report-render      | `11-report-render.ru.md`         |
| 12  | review-workspace   | `12-review-workspace.ru.md`      |
| 13  | cleanup (опц.)     | `13-cleanup.ru.md`               |

Номера фаз — историческая нумерация, не переименовывались вместе с
переименованием их сути (например 06 «run-side» теперь по духу «run
variant» — файл и контракт сохранили старое имя, потому что на них ссылаются
остальные фазы и тесты). `04b` — ненумерованный «сиблинг» между 04 и 05, как
и раньше.

---

## Схема зависимостей фаз

```
                       ┌──────────────┐
                       │ 00 cli-parse │  ← .testaipack/config.json (optional)
                       └──────┬───────┘
                              │ RunInput (packs[], variants[], baseline, parallel)
                       ┌──────▼──────────┐
                       │ 01 workspace-   │
                       │    setup        │ → manifest.json + skeleton (per variant)
                       └──────┬──────────┘
                              │ WorkspaceTree.variantTrees + Manifest
                ┌─────────────┴─────────────┐
        ┌───────▼────────┐          ┌───────▼────────┐
        │ 02 repo-clone  │          │ 03 pack-        │
        │ (per variant)  │          │    install      │
        └───────┬────────┘          │ (per pack)      │
                │                   └───────┬─────────┘
                └─────────────┬─────────────┘
                              │
                       ┌──────▼──────────┐
                       │ 04 home-        │
                       │    isolation    │ → home/<variant>/run-N/ + config/<variant>.json
                       └──────┬──────────┘
                              │
                       ┌──────▼──────────┐
                       │ 04b pack-setup  │  (per declaring-variant × pack)
                       └──────┬──────────┘
                              │
                       ┌──────▼──────────┐
                       │ 05 preflight    │  (6 gates, exit 2/3 on failure)
                       └──────┬──────────┘
                              │
              ┌───────────────┼───────────────┐
        ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
        │ 06        │   │ 06        │   │ 06        │   ← up to `parallel` concurrent,
        │ run-side  │   │ run-side  │   │ run-side  │     N runs sequential per variant
        │ (variant  │   │ (variant  │   │ (variant  │
        │  A)       │   │  B)       │   │  ...)     │
        └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
              └───────────────┼───────────────┘
                              │ raw/<variant>/run-N.json
            ┌─────────────────┼─────────────────┐
       ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
       │ 07      │       │ 08      │       │ 09      │   ← parallel
       │ aggreg. │       │ diff    │       │ judge   │     (09 optional)
       └────┬────┘       └────┬────┘       └────┬────┘
            └─────────────────┼─────────────────┘
                              │
                       ┌──────▼──────────┐
                       │ 10 timeline     │ → timeline.{json,html} (lanes: N)
                       └──────┬──────────┘
                              │
                       ┌──────▼──────────┐
                       │ 11 report-      │ → report.{md,json,yaml,html}
                       │    render       │    (metric-major tables)
                       └──────┬──────────┘
                              │
                       ┌──────▼──────────┐
                       │ 12 review-      │ → review.code-workspace
                       │    workspace    │    (N variant folders + pack folders)
                       └──────┬──────────┘
                              │
                       ┌──────▼──────────┐
                       │ 13 cleanup      │  (optional, gc / --ephemeral)
                       └─────────────────┘
```

Стрелки читаются как «производит данные, потребляемые следующей фазой».
Ветви, разошедшиеся из одного узла (`02 ‖ 03`, `07 ‖ 08 ‖ 09`), исполняются
параллельно и соединяются в общей точке схода. Фаза 06 запускает варианты
конкурентно, ограничено `runInput.parallel` (дефолт 2 — воспроизводит
сегодняшний `old ‖ new` для legacy-шима); произвольное N > `parallel`
исполняется волнами, а не всё сразу.

---

## Легенда обозначений

| Знак / ключевое слово | Значение                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `✅`                  | Тест-кейс, который реально пишется и должен проходить в CI (coverage ≥80% блокирующий).                  |
| `❌`                  | Известная непокрытая ветка — выносится в отдельный ticket, намеренно не тестируется сейчас.             |
| `E_XXX`               | Код ошибки. Все коды имеют префикс `E_`, описаны в секции 2 каждой фазы и суммируются в общий error set. |
| «Зависит от»          | Фаза получает на вход данные, произведённые указанной фазой (upstream).                                  |
| «Блокирует»           | Фаза производит данные, без которых указанная фаза не может стартовать (downstream).                     |
| «Параллелизуется с»   | Фазы могут исполняться concurrently и не имеют data-dependency между собой.                             |
| `TypeSpec: <Name>`    | Ссылка на нормативный тип в `contract/phases/<name>.tsp`.                                                |

---

## Кросс-фазные типы (общие)

Чтобы фазы склеивались без щелей, следующие типы определены один раз в
`contract/main.tsp` и переиспользуются всеми фазовыми контрактами через
`using TestAiPack;`.

- `RunInput` (v2, `schemaVersion: 2`) — полная конфигурация прогона, результат
  `cli-parse`. Содержит `repoUrl`, `prompt?` (глобальный дефолт, опционален —
  валиден эффективный промпт на каждый вариант), `promptFiles?`, `init?`,
  `initFiles?`, `hint?` (глобальный дефолт), `verify?`, `model?`, `runs`,
  **`parallel`** (дефолт 2), **`baseline`** (имя варианта-эталона),
  **`packs: PackSpec[]`** (реестр паков), **`variants: VariantSpec[]`**
  (минимум один), `isolation`, `opencodeVersion?`, `auth` (`AuthWhitelist`),
  `judge?`, `judgeFiles?`, `preflightEnabled`, `preflightModel?`, `formats`
  (`OutputFormat[]`), `outputPath`, `diffHtml`, `protectGit`,
  `collapseRepeats`, `timelineMode`, `timeouts` (`TimeoutConfig`),
  `workspacePath`, `logLevel`, `pricingPath?`. `Side`/`InitSide` **удалены**
  из контракта целиком — на wire их больше нет.
  - **Два разных «model»:** эффективная модель варианта
    (`effectiveOf(variant, runInput.model, 'model')`) — модель самого
    прогона этого варианта; запекается в его сгенерированный конфиг фазой 04,
    и именно её проверяет auth-ping в фазе 05 (гейт 2). `preflightModel?`
    (флаг `--preflight-model`) выбирает только модель LLM-судьи (фаза 09).
- `PackSpec` — `{ name, ref, type?, setup?, check? }`. Один пак реестра
  эксперимента. `setup`/`check` принадлежат ПАКУ; `exercise` — варианту (см.
  `VariantSpec`).
- `VariantSpec` — `{ name, packs: string[], prompt?, init?, model?, hint?,
  pure?, verify?, exercise?, allowPacks? }`. Одно плечо эксперимента.
  `prompt`/`init`/`model`/`hint`/`verify` — опциональные оверрайды
  одноимённого глобального поля `RunInput` (правило `effectiveOf`, D7:
  отсутствие поля наследует глобаль, явная пустая строка `""` явно
  отключает наследование). `pure?` — дефолт `packs.length === 0` (D1).
  `allowPacks?` — преемник `--allow-baseline-tool`, теперь
  per-(вариант, пак).
- `AuthWhitelist` — boolean-флаги на каждый источник auth: `opencode`,
  `npmrc`, `anthropic`, `openai`, `gemini`, `aws`, `ssh`, `git`.
- `TimeoutConfig` — `preflightSeconds`, `runSeconds`, `verifySeconds`,
  `installSeconds`, `watchdogSeconds`, `totalSeconds?`.
- `Manifest` (v2) — структура `manifest.json`: `schemaVersion: 2`, `runId`,
  `timestamp`, `repoUrl`, `prompt?`, `init?`, `hint?`, `verify?`, `runs`,
  `parallel`, `baseline`, **`packs: PackSpec[]`**, **`variants:
  VariantSpec[]`** (provenance-копии, `ref` редактирован),
  `isolation`, `opencodeVersion`, `flagDefaults`.
- `WorkspaceTree` — абсолютные пути к поддиректориям прогона: `root`,
  `appsSource`, `pack`, **`variantTrees: VariantTree[]`** (по одной записи на
  каждый вариант — заменяет шесть прежних `appsOld/appsNew/homeOld/homeNew/
  gitDirsOld/gitDirsNew`), `config`, `results`, `raw`, `diff`. Это результат
  `workspace-setup` наряду с `Manifest`.
- `VariantTree` — `{ name, apps: string[], homes: string[], gitDirs:
  string[] }` — один путь на прогон (`run-1`…`run-N`) в каждом массиве.
- `HomeTree` — структура одного HOME: `basePath`, `structure[]`,
  `copiedAuth[]`.
- `EnvVarSet` — переменные окружения одного прогона: `HOME`,
  `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`,
  `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_PURE`,
  `OPENCODE_CONFIG_CONTENT?`, `PATH?`.
- `VariantEnv` — `{ name, envs: EnvVarSet[] }` — env-наборы одного варианта,
  по одному на прогон. Заменяет прежний `EnvVarSet[side][run]` с позиционной
  индексацией `[0]=old,[1]=new`.
- `PackType = "skill" | "plugin" | "agent" | "command" | "mcp" | "all"` —
  без изменений.
- `OpencodeExport` — схема вывода `opencode export <session-id>`
  (`info` + `messages[]`); исходник правды для `aggregate`, `timeline`, и
  косвенно для `run-side`. Без изменений.
- `RunResult` (переименован из `RunSideResult`, решение D8) — результат
  одного прогона одного варианта: `variant: string` (было `side: Side`),
  `runIndex`, `exportPath`, `eventsLogPath`, `successRank`, `finishCause`,
  `exitCode`, `durationMs`, `verifyExitCode?`, `watchdogTriggered`,
  `errorCode?`, `initRan?`, `initWallMs?`, `promptWallMs?`, `setupWallMs?`.
- `VariantAggregates` (было `SideAggregates`) — агрегированные по N прогонам
  метрики одного варианта: `variant`, `primary` (`PrimaryMetrics`),
  `secondary` (`SecondaryMetrics`), `stats` (`AggregateStats`), `failedRuns`,
  `rawRunIds`, `packUses?: PackUse[]` (по записи на объявленный пак),
  `contaminationSignals?`, `phaseSplit?`.
- `MetricsReport` (было `MetricsDiff`) — `{ baseline: string, variants:
  VariantAggregates[], deltas: VariantDelta[], allFailed: boolean }`.
  `VariantDelta = { variant, deltas: PrimaryDeltas, taskDeltas?, initDeltas?,
  pairIncomplete: boolean }` — дельта каждого не-baseline варианта против
  baseline'а (N−1 записей, было ровно одна `new − old`).
- `MetricDelta` — `absolute`, `percent?` (опционален — не задан для перехода
  `0 → ненулевое`, рендер отчёта показывает «n/a»), `significant: boolean`,
  `better`. Структура не изменилась.
- `TimelineEvent` — `variant: string` (было `side: Side`) + остальные поля
  без изменений. `Timeline = { lanes: VariantTimeline[], mode }` (было
  `{ old, new, mode }`). `VariantTimeline = { variant, events:
  TimelineEvent[] }`.
- `DiffResult` (`{ variant, runs: DiffRunResult[] }`) / `DiffRunResult` /
  `DiffSummary` — модель git-diff (см. фазу 08), поле `variant` вместо
  `side`.
- `JudgeResult` — `{ verdict, scores: VariantScore[], ranking: string[],
  explanation, rawResponse?, modelUsed, timestamp, ran?, pairwiseFallback? }`
  (было `oldQuality`/`newQuality`). `VariantScore = { variant, quality }`.
- `PrepReport` (было `PackSetupReport`) — `{ packs: PackPrep[], variants:
  VariantPrep[] }`. `PackPrep` — паковая половина (setup/check-эвиденс на
  каждый пак реестра); `VariantPrep` — вариантная половина (exercise-эвиденс
  на каждый вариант).
- `PhaseError` — базовый тип ошибки фазы: `code: ErrorCode`, `phase`, `message`,
  `cause?`, `context?`, `timestamp`. Каждая фаза, способная упасть, определяет
  свой `@error model <Phase>Error` со своим подмножеством кодов из enum
  `ErrorCode`. Фазы `12 review-workspace` и `13 cleanup` не имеют error-модели
  (мягкие фазы — ошибки логируются, но не фейлят прогон).

Реализация поверх Effect-TS переносит эти типы в runtime-объект `RunContext` с
методами-билдерами путей — внутренний объект оркестратора, не часть
TypeSpec-контракта.

### Общие функции n-way variants (`src/phases/00-cli-parse.ts`, реэкспортированы)

Используются практически каждой downstream-фазой — не переизобретайте их:

```ts
export const VARIANT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const RESERVED_VARIANT_NAMES: ReadonlySet<string> = new Set(['source'])
export const packShortName = (ref: string): string
export const effectiveOf = (v: VariantSpec, g: string | undefined, key: 'prompt'|'init'|'model'|'hint'|'verify'): string | undefined
export const packsOf = (runInput: RunInput, v: VariantSpec): readonly PackSpec[]
export const foreignPacksOf = (runInput: RunInput, v: VariantSpec): readonly PackSpec[]
export const baselineOf = (runInput: RunInput): VariantSpec
```

### v1 → v2 совместимость

`src/compat/legacy.ts` (плюс замороженная копия v1-схем в
`src/compat/v1-schemas.ts`) транслирует воркспейсы, созданные до появления
n-way variants (манифест без `schemaVersion`, читается как `1`), в
canonical v2 форму на лету — `report --rebuild`, `compare`, `list` продолжают
открывать старые прогоны. Подробности маппинга —
`.research/n-way-variants/01-contract.md §7`. Слой компата **никогда** не
регенерируется вместе с `src/generated/` — он ручная снапшот-копия
дореформенных схем.

---

## Где смотреть контракты

Все нормальные имена типов, полей и enum-значений, упомянутые в фазах, лежат в:

```
contract/
├── main.tsp                # RunInput, PackSpec, VariantSpec, AuthWhitelist,
│                           # TimeoutConfig, Manifest, WorkspaceTree, VariantTree,
│                           # HomeTree, EnvVarSet, VariantEnv, OpencodeExport,
│                           # VariantAggregates, MetricsReport, MetricDelta,
│                           # TimelineEvent/Timeline/VariantTimeline, DiffResult,
│                           # JudgeResult, PrepReport, PhaseError, ErrorCode,
│                           # RunResult, enums.
├── index.tsp               # barrel entrypoint: импортирует main.tsp и все
│                           # фазовые tsp; точка входа `tsp compile`.
├── tspconfig.yaml          # конфиг tsp-компилятора (emitters: openapi3,
│                           # json-schema).
└── phases/
    ├── 00-cli-parse.tsp        # namespace TestAiPack.CliParse
    ├── 01-workspace-setup.tsp  # namespace TestAiPack.WorkspaceSetup
    ├── 02-repo-clone.tsp       # namespace TestAiPack.RepoClone
    ├── 03-pack-install.tsp     # namespace TestAiPack.PackInstall
    ├── 04-home-isolation.tsp   # namespace TestAiPack.HomeIsolation
    ├── 04b-pack-setup.tsp      # namespace TestAiPack.PackSetup
    ├── 05-preflight.tsp        # namespace TestAiPack.Preflight
    ├── 06-run-side.tsp         # namespace TestAiPack.RunSide
    ├── 07-aggregate.tsp        # namespace TestAiPack.Aggregate
    ├── 08-diff.tsp             # namespace TestAiPack.Diff
    ├── 09-judge.tsp            # namespace TestAiPack.Judge
    ├── 10-timeline.tsp         # namespace TestAiPack.TimelineBuild
    ├── 11-report-render.tsp    # namespace TestAiPack.ReportRender
    ├── 12-review-workspace.tsp # namespace TestAiPack.ReviewWorkspace
    └── 13-cleanup.tsp          # namespace TestAiPack.Cleanup
```

При добавлении нового поля в любую фазу сначала правится `.tsp`, затем —
соответствующий phase-док, затем — реализация. Обратный порядок запрещён.
