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

---

## Канонический список фаз

| #   | Фаза               | Имя файла                        |
| --- | ------------------ | -------------------------------- |
| 00  | cli-parse          | `00-cli-parse.ru.md`             |
| 01  | workspace-setup    | `01-workspace-setup.ru.md`       |
| 02  | repo-clone         | `02-repo-clone.ru.md`            |
| 03  | pack-install       | `03-pack-install.ru.md`          |
| 04  | home-isolation     | `04-home-isolation.ru.md`        |
| 05  | preflight          | `05-preflight.ru.md`             |
| 06  | run-side           | `06-run-side.ru.md`              |
| 07  | aggregate          | `07-aggregate.ru.md`             |
| 08  | diff               | `08-diff.ru.md`                  |
| 09  | judge (опц.)       | `09-judge.ru.md`                 |
| 10  | timeline           | `10-timeline.ru.md`              |
| 11  | report-render      | `11-report-render.ru.md`         |
| 12  | review-workspace   | `12-review-workspace.ru.md`      |
| 13  | cleanup (опц.)     | `13-cleanup.ru.md`               |

---

## Схема зависимостей фаз

```
                       ┌──────────────┐
                       │ 00 cli-parse │  ← .testaipack/config.json (optional)
                       └──────┬───────┘
                              │ RunInput
                       ┌──────▼──────────┐
                       │ 01 workspace-   │
                       │    setup        │ → manifest.json + skeleton
                       └──────┬──────────┘
                              │ WorkspaceTree + Manifest
                ┌─────────────┴─────────────┐
        ┌───────▼────────┐          ┌───────▼────────┐
        │ 02 repo-clone  │          │ 03 pack-       │
        │                │          │    install     │
        └───────┬────────┘          └───────┬────────┘
                │                           │
                └─────────────┬─────────────┘
                              │
                       ┌──────▼──────────┐
                       │ 04 home-        │
                       │    isolation    │ → home/{old,new}/run-N/ + config/*.json
                       └──────┬──────────┘
                              │
                       ┌──────▼──────────┐
                       │ 05 preflight    │  (5 gates, exit 2/3 on failure)
                       └──────┬──────────┘
                              │
                  ┌───────────┴────────────┐
            ┌─────▼─────┐            ┌─────▼─────┐
            │ 06        │            │ 06        │   ← 2-way parallel
            │ run-side  │            │ run-side  │     (old || new),
            │ (old)     │            │ (new)     │     N runs sequential per side
            └─────┬─────┘            └─────┬─────┘
                  └───────────┬────────────┘
                              │ raw/{old,new}/run-N.json
            ┌─────────────────┼─────────────────┐
       ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
       │ 07      │       │ 08      │       │ 09      │   ← parallel
       │ aggreg. │       │ diff    │       │ judge   │     (09 optional)
       └────┬────┘       └────┬────┘       └────┬────┘
            └─────────────────┼─────────────────┘
                              │
                       ┌──────▼──────────┐
                       │ 10 timeline     │ → timeline.{json,html}
                       └──────┬──────────┘
                              │
                       ┌──────▼──────────┐
                       │ 11 report-      │ → report.{md,json,yaml,html}
                       │    render       │
                       └──────┬──────────┘
                              │
                       ┌──────▼──────────┐
                       │ 12 review-      │ → review.code-workspace
                       │    workspace    │
                       └──────┬──────────┘
                              │
                       ┌──────▼──────────┐
                       │ 13 cleanup      │  (optional, gc / --ephemeral)
                       └─────────────────┘
```

Стрелки читаются как «производит данные, потребляемые следующей фазой».
Ветви, разошедшиеся из одного узла (`02 ‖ 03`, `07 ‖ 08 ‖ 09`), исполняются
параллельно и соединяются в общей точке схода.

---

## Легенда обозначений

| Знак / ключевое слово | Значение                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `✅`                  | Тест-кейс, который реально пишется и должен проходить в CI (coverage ≥80% блокирующий).                  |
| `❌`                  | Известная непокрытая ветка — выносится в отдельный ticket, в v0.1 намеренно не тестируется.             |
| `E_XXX`               | Код ошибки. Все коды имеют префикс `E_`, описаны в секции 2 каждой фазы и суммируются в общий error set. |
| «Зависит от»          | Фаза получает на вход данные, произведённые указанной фазой (upstream).                                  |
| «Блокирует»           | Фаза производит данные, без которых указанная фаза не может стартовать (downstream).                     |
| «Параллелизуется с»   | Фазы могут исполняться concurrently и не имеют data-dependency между собой.                             |
| `TypeSpec: <Name>`    | Ссылка на нормативный тип в `contract/phases/<name>.tsp`.                                                |

---

## Кросс-фазные типы (общие)

Чтобы фазы склеивались без щелей, следующие типы определены один раз в
`contract/main.tsp` и переиспользуются всеми фазовыми контрактами через
`using TestAiPack;`:

- `RunInput` — полная конфигурация прогона, результат `cli-parse`. Содержит
  `repoUrl`, `packRef?`, `packType?`, `prompt`, `promptFiles?`, `init?`,
  `initFiles?`, `verify?`, `runs`, `isolation`, `opencodeVersion?`, `auth`
  (`AuthWhitelist`), `pureBaseline`, `judge?`, `judgeFiles?`,
  `preflightEnabled`, `preflightModel?`, `formats` (`OutputFormat[]`),
  `outputPath`, `diffHtml`, `collapseRepeats`, `timelineMode`, `timeouts`
  (`TimeoutConfig`), `workspacePath`, `logLevel`, `pricingPath?`.
- `AuthWhitelist` — boolean-флаги на каждый источник auth: `opencode`,
  `npmrc`, `anthropic`, `openai`, `gemini`, `aws`, `ssh`, `git`.
- `TimeoutConfig` — `preflightSeconds`, `runSeconds`, `verifySeconds`,
  `installSeconds`, `watchdogSeconds`, `totalSeconds?`.
- `Manifest` — структура `manifest.json`: `runId`, `timestamp`, `repoUrl`,
  `packRef?`, `packType?`, `prompt`, `init?`, `verify?`, `runs`, `isolation`,
  `opencodeVersion`, `flagDefaults`.
- `WorkspaceTree` — абсолютные пути к поддиректориям прогона: `root`,
  `appsSource`, `appsOld[]`, `appsNew[]`, `pack`, `homeOld[]`, `homeNew[]`,
  `config`, `results`, `raw`, `diff`. Это результат `workspace-setup` наряду
  с `Manifest`.
- `HomeTree` — структура одного HOME: `basePath`, `structure[]`,
  `copiedAuth[]`.
- `EnvVarSet` — переменные окружения одного прогона: `HOME`,
  `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`,
  `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_PURE`,
  `OPENCODE_CONFIG_CONTENT?`.
- `Side = "old" | "new"`.
- `PackType = "skill" | "plugin" | "agent" | "command" | "mcp" | "all"`.
- `OpencodeExport` — схема вывода `opencode export <session-id>`
  (`info` + `messages[]`); исходник правды для `aggregate`, `timeline`, и
  косвенно для `run-side`.
- `RunSideResult` — результат одного прогона одной стороны: `side`,
  `runIndex`, `exportPath`, `eventsLogPath`, `successRank`, `finishCause`,
  `exitCode`, `durationMs`, `verifyExitCode?`, `watchdogTriggered`.
- `SideAggregates` — агрегированные по N прогонам метрики одной стороны:
  `side`, `primary` (`PrimaryMetrics`), `secondary` (`SecondaryMetrics`),
  `stats` (`AggregateStats` — распределения `MetricDistribution`), `failedRuns`,
  `rawRunIds`.
- `MetricsDiff` — `old`, `new` (обе `SideAggregates`), `deltas`
  (`PrimaryDeltas` — построчно `MetricDelta`), `bothFailed`.
- `MetricDelta` — `absolute`, `percent`, `significant: boolean`, `better`.
- `TimelineEvent` / `Timeline` — модель событий таймлайна (см. фазу 10).
- `DiffResult` / `DiffRunResult` / `DiffSummary` — модель git-diff (см. фазу 08).
- `JudgeResult` — модель вердикта LLM-судьи (см. фазу 09).
- `PhaseError` — базовый тип ошибки фазы: `code: ErrorCode`, `phase`, `message`,
  `cause?`, `context?`, `timestamp`. Каждая фаза, способная упасть, определяет
  свой `@error model <Phase>Error` со своим подмножеством кодов из enum
  `ErrorCode`. Фазы `12 review-workspace` и `13 cleanup` не имеют error-модели
  (мягкие фазы — ошибки логируются, но не фейлят прогон).

Реализация поверх Effect-TS переносит эти типы в runtime-объект `RunContext` с
методами-билдерами путей (`appsDir(side, n)`, `homeDir(side, n)`, …) — это
внутренний объект оркестратора, не часть TypeSpec-контракта.

---

## Где смотреть контракты

Все нормальные имена типов, полей и enum-значений, упомянутые в фазах, лежат в:

```
contract/
├── main.tsp                # RunInput, AuthWhitelist, TimeoutConfig, Manifest,
│                           # WorkspaceTree, HomeTree, EnvVarSet, OpencodeExport,
│                           # SideAggregates, MetricsDiff, MetricDelta,
│                           # TimelineEvent/Timeline, DiffResult, JudgeResult,
│                           # PhaseError, ErrorCode, RunSideResult, enums.
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
