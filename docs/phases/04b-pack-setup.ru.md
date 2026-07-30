# Фаза 04b: pack-setup

> Спека фазы. Контракт = `contract/phases/04b-pack-setup.tsp`. Реализация —
> TypeScript strict + Effect-TS. Ненумерованная фаза-«сиблинг» (как
> `captureOpencodeConfig`) — вставлена между 04 и 05 без сдвига
> `PHASE_COUNT`/номеров остальных фаз.

## 1. Назначение

Сделать инструмент отвечающим на свой прямой вопрос: не просто доставить pack
на сторону new (это уже сделали фазы 03/04), а **установить его зависимость**
(`--pack-setup`), **проверить, что она реально работает** (`--pack-check`, гейт
6 в фазе 05) и **прогнать её один раз перед агентской сессией** (`--pack-exercise`,
пер-run шаг в `cli/pipeline.ts`) — прежде чем измерять что-либо. Раньше модель
могла получить файлы pack-а и просто не воспользоваться ими; часть прогонов
«after» в реальном эксперименте так и не завели инструмент, но всё равно
считались валидными.

Все три флага (`--pack-setup`, `--pack-check`, `--pack-exercise`) —
опциональные и составляют **один режим** прогона (`PackSetupMode`):

- `exercised` — задан `--pack-exercise` (setup/check могут быть заданы или
  нет).
- `installed-only` — задан `--pack-setup` и/или `--pack-check`, но не
  `--pack-exercise`.
- `delivered-only` — ничего из трёх не задано; байт-в-байт то же поведение,
  что было до этой фазы. Pack без ничего запускаемого **не проваливает**
  прогон — он деградирует до `installed-only`/`delivered-only` и явно
  сообщает об этом в отчёте (см. `undeclaredDepWarning` ниже), а не падает.

Эта фаза (04b) отвечает только за **`setup`** — установку один раз в первый
new-HOME и копирование результата на остальные. `checks` (гейт 6, фаза 05) и
`exercises` (пер-run шаг в `cli/pipeline.ts`) заполняются другими местами и
сливаются в единый `PackSetupReport` в `cli/pipeline.ts`.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.PackSetup` (см. `contract/phases/04b-pack-setup.tsp`).

- Вход: `PackSetupInput` — `{ runInput, manifest, workspace, packInstall? }`.
  Локальное расширение `PackSetupInputExt` (`src/phases/04b-pack-setup.ts`)
  добавляет `dockerImage?` и `newHomePath?` — последнее это **уже посчитанный**
  фазой 04 `EnvVarSet.PATH` для `homeNew[0]`, переиспользуется, а не
  пересчитывается, чтобы `--pack-setup` резолвил HOME-установленный бинарник
  ровно так же, как это сделает bash-тул самого агента.
- Выход: `PackSetupResult` — `{ report: PackSetupReport, logPath: string }`.
- `PackSetupReport` (в `main.tsp`, общий для всех трёх источников):
  `{ mode, setupDeclared, checkDeclared, exerciseDeclared,
  undeclaredDepWarning?, setup?: PackCmdResult, checks: PackCmdResult[],
  exercises: PackCmdResult[] }`.
- `PackCmdResult` — `{ side, runIndex, exitCode, durationMs, outputTail?,
  artifactHash? }`. `artifactHash` заполняется только `exercises`-записями
  (см. §6 «diff hygiene» и `docs/phases/08-diff.ru.md`).
- Ошибки: `@error PackSetupError` — `{ code, message, context? }`, коды:
  - `E_PACK_SETUP_FAILED` — `--pack-setup` завершился ненулевым кодом, либо
    сбой копирования HOME.
  - `E_PACK_SETUP_TIMEOUT` — `--pack-setup` не уложился в
    `runInput.timeouts.installSeconds` (отдельного флага таймаута для
    setup/check/exercise нет — переиспользуется существующий install-таймаут).

## 3. Шаги алгоритма

1. `setupDeclared/checkDeclared/exerciseDeclared` — просто `!== undefined` на
   соответствующих полях `runInput`. `mode = derivePackSetupMode(...)`.
2. Если ничего не задано (`!setupDeclared && !exerciseDeclared`) —
   `scanForDependencyMarkers(packRoot)` эвристически проверяет
   `pyproject.toml`, `package.json` с полем `bin`, `requirements*.txt`, а
   также текст установочной команды (`pip install`/`uv tool install`/
   `npm i(nstall)`/`npx `) в `SKILL.md`/`README.md`. Если найдено —
   `undeclaredDepWarning` попадает в отчёт («pack, похоже, оборачивает
   внешний рантайм, но ничего не задекларировано»). Это не жёсткое
   требование — самодостаточные skill-паки без внешних зависимостей должны
   продолжать работать без единого нового флага.
3. Если `!setupDeclared` — no-op: лог пишется, `report.setup` остаётся
   `undefined`, `checks`/`exercises` — пустые массивы. Байт-в-байт то же, что
   было до фазы.
4. Иначе — запускается `runInput.packSetup` **один раз** через
   `runShellInHome(cmd, homeNew[0], appsNew[0], docker, timeoutMs,
   newHomePath)` (docker-aware, `sh -c`, никогда `sh -lc` — см. §5).
   Таймаут/ненулевой код → `Effect.fail` с соответствующим кодом, HOME не
   копируется.
5. При успехе — `homeNew[0]` **заменяет** (`removeDir` + `copyDir`, не
   мёрджит) каждый `homeNew[1..N-1]`: все new-HOME на старте байт-идентичны
   (фаза 04 строит их из одного скелета+auth+инструкций), так что это
   единственный сетевой/установочный вызов на весь эксперимент, а не один на
   run.
6. Лог (`results/pack-setup.log`) собирается из неизменяемых
   `headerLines`/`setupLogLines` — не инкрементальный `.push()` (правило
   `functional/immutable-data`).

## 4. PATH и docker (см. также `docs/phases/04-home-isolation.ru.md`)

Критично для корректности всего механизма — см. пункт «эмпирически найденные
баги» ниже. `runShellInHome` (общий хелпер для 04b/гейта 6/exercise,
`src/isolation/shell-runner.ts`) принимает опциональный `pathOverride`:

- В docker-режиме передаётся как `-e PATH=<pathOverride>`.
- В host-режиме — переопределяет `PATH` в env-записи процесса.
- Оба ветки используют `sh -c`, **никогда** `sh -lc`.

`pathOverride` — это ровно тот `EnvVarSet.PATH`, который фаза 04 уже
вычислила (`setupPathFor` в `04-home-isolation.ts`,
`<homeDir>/.local/bin:<остальной PATH>`), переданный через `newHomePath`
(04b) / `homePathEnv.{old,new}` (гейт 6, `PreflightInputExt`) /
`homeEnv.PATH` (exercise, `cli/pipeline.ts`) — без повторного пробирования.

**Эмпирически подтверждённые баги при реализации** (докер-образ
`testaipack-opencode:latest`, проверено напрямую через `docker run`, не
только юнит-тестами):

1. **Login shell сбрасывает PATH.** `/etc/profile` образа безусловно
   переустанавливает `PATH` в UID-зависимое хардкод-значение при login-shell
   (`sh -lc`), независимо от того, что было передано через `-e PATH=...` или
   унаследовано. `sh -c` (non-login) этого не делает. Если бы этот баг не
   был найден до релиза — каждый вызов `--pack-setup`/`--pack-check`/
   `--pack-exercise` видел бы неверный PATH, и гейт 6 всегда репортил бы
   инструмент как отсутствующий, даже когда он реально установлен.
2. **Docker-ветка изначально вообще не передавала PATH.** Без явного
   `pathOverride` контейнер видел только базовый PATH образа, никогда
   `.local/bin`. Отдельно проверено (реальной opencode-агентской сессией,
   не сырой оболочкой), что bash-тул самого агента этой проблемы не имеет —
   он корректно резолвит HOME-установленный бинарник через унаследованный
   PATH без специальной обработки; баг был изолирован именно в собственном
   хелпере харнесса.

## 5. Входные/выходные файлы

| Файл / каталог                | Чтение/Запись | Схема                    |
| ------------------------------ | ------------- | ------------------------ |
| `home/new/run-1/` (и остальные)| Запись        | `--pack-setup` пишет сюда, копируется на run-2..N |
| `results/pack-setup.log`       | Запись        | текст, `writeLog`         |
| `results/pack-setup.json`      | Запись (в `cli/pipeline.ts`, не в этой фазе) | `PackSetupReport`, собран из setup(04b)+checks(гейт 6)+exercises(pipeline) |

## 6. Гейт 6 и exercise (не в этой фазе, но часть одного `PackSetupReport`)

- **Гейт 6 `pack-functional`** — `05-preflight.ts`, `gatePackFunctional`.
  Запускает `--pack-check` через тот же `runShellInHome` на **каждом** HOME
  обеих сторон, не только на `run-1`: `homesForCheck` (расширение
  `PreflightInputExt`, собирается в `cli/pipeline.ts` из `treePaths.homeOld`/
  `homeNew` + PATH каждого HOME) — 04b копирует один установленный HOME на
  остальные, и именно эта копия — то самое место, где HOME может тихо
  остаться без рабочей установки (см. фикс `verbatimSymlinks` у `copyDir` в
  `util/fs.ts`); гейт, проверяющий только `run-1`, ничего не доказывает про
  `run-2..N`. Классификация: инфра-ошибка (только `outcome.timedOut` —
  ЛЮБОЙ ненулевой exit code, включая 127 «command not found», на old-стороне
  это ОЖИДАЕМЫЙ результат, а не сбой) → `E_PACK_CHECK_FAILED` exitCode 2;
  new-сторона не работает в конкретном HOME (exit ≠ 0) → exitCode 3,
  `reason: 'new-side-not-functional'`, падает на первом же непройденном
  HOME; old-сторона неожиданно работает в конкретном HOME (exit 0) без
  `--allow-baseline-tool` → exitCode 3, `reason: 'baseline-already-has-tool'`
  (жёсткий фейл: baseline, который тихо уже содержит зависимость — во
  ВСЕХ или только в одном скопированном HOME — делает сравнение
  бессмысленным, и это не должно обнаруживаться только постфактум). С
  `--allow-baseline-tool` — проходит, но агрегированный `details` явно
  отмечает число обойдённых HOME. Без `--pack-check` гейт помечен
  `skipped (no --pack-check)`, `passed: true` — не путать со «подтверждено
  работает». `PackSetupReport.checks` получает один `PackCmdResult` на
  каждый проверенный HOME (`runIndex` = номер run, 1-based), как и
  документировано в контракте.
- **Exercise** — `cli/pipeline.ts`, `runPackExercise`, пер-run, только
  new-сторона, до старта агентской сессии. Сбой/таймаут **контейнит только
  этот run** (`successRank:0, finishCause:'error',
  errorCode:'E_PACK_EXERCISE_FAILED'`, агентская сессия не запускается) —
  не абортит весь эксперимент и, что важнее всего, не даёт этому прогону
  тихо стать де-факто baseline-прогоном. Успешный exercise проверяется на
  «diff hygiene»: `git status --porcelain` → трекнутый файл изменён → жёсткий
  abort всего эксперимента (`E_PACK_EXERCISE_DIRTY`, не контейнится); новый
  нетрекнутый файл (`??`) → добавляется в `.git/info/exclude` +
  `computeArtifactHash` пишется в `run-N.exercise.json` (детерминизм-триггер
  на собственный пайплайн pack-а; см. `docs/phases/08-diff.ru.md`).
- Setup/check/exercise дают **только wall-clock**, никогда — токены/шаги/
  cost (это работа харнесса, не агента); нулевые значения этих метрик не
  подставляются, потому что ноль читается как «измерено — ничего», а не как
  «неприменимо». `RunSideResult.setupWallMs` — экземплярное поле,
  зарезервированное для parallel metric-split; агрегация (`SidePhaseSplit.setup`/
  `setupStats`) — вне границ этой фазы.

## 7. Edge-cases и ошибки

| Кейс                                                        | Поведение                                             | Код |
| ------------------------------------------------------------ | ------------------------------------------------------ | --- |
| Ничего не задано                                              | no-op, `mode: delivered-only`                          | —   |
| Задан только `--pack-setup`/`--pack-check`, без exercise      | `mode: installed-only`                                 | —   |
| Задан `--pack-exercise`                                       | `mode: exercised`                                      | —   |
| Pack без ничего запускаемого, задекларированные маркеры зависимости найдены | `undeclaredDepWarning` в отчёте, не fail | —   |
| `--pack-setup` таймаут                                        | fail всего эксперимента                                | `E_PACK_SETUP_TIMEOUT` |
| `--pack-setup` ненулевой exit                                 | fail всего эксперимента                                | `E_PACK_SETUP_FAILED` |
| Сбой копирования HOME на run 2..N                              | fail всего эксперимента                                | `E_PACK_SETUP_FAILED` |
| `--pack-check` объявлен → гейт 6 не прошёл                    | fail всего эксперимента (см. §6)                       | `E_PACK_CHECK_FAILED` |
| baseline (old) неожиданно уже имеет инструмент                | fail (жёстко), кроме `--allow-baseline-tool`            | `E_PACK_CHECK_FAILED`, `reason: baseline-already-has-tool` |
| `--pack-setup` без `--pack-check`                              | предупреждение в отчёте: claim о функциональности не проверен | — |
| `--pack-exercise` без `--pack-check`                           | предупреждение (`packExerciseWithoutCheckWarning`, `cli/pipeline.ts`), не fail | — |
| Один run: `--pack-exercise` падает/таймаутит                  | контейнит только этот run, unusable для new-стороны     | `E_PACK_EXERCISE_FAILED` (на уровне `RunSideResultExt`) |
| Exercise модифицирует трекнутый файл                           | жёсткий abort всего эксперимента                        | `E_PACK_EXERCISE_DIRTY` |
| Exercise создаёт нетрекнутые файлы                              | исключаются из diff (`.git/info/exclude`), не fail      | — |

## 8. Открытые вопросы спеки, зафиксированные решения

- **Baseline уже содержит инструмент** → жёсткий fail с явным override-флагом
  `--allow-baseline-tool` (см. §6, гейт 6).
- **Таймаут** переиспользует `timeouts.installSeconds`; отдельного флага нет.
- **Сбой exercise** контейнит только один прогон, не абортит весь
  эксперимент, и не даёт ему тихо стать de-facto baseline.
- **Межэкспериментное кэширование пакетов** — отложено, не реализовано.
- **`--pack-check`** остаётся рекомендуемым, не обязательным; при `--pack-setup`
  без `--pack-check` — громкое предупреждение и явная пометка «функциональность
  не подтверждена» в отчёте.
- **Если CLI самого pack-а сам обращается к модели** — эти токены невидимы
  харнессу (внешний процесс, который никем не метрится); это должно явно
  проговариваться в отчёте как честная оговорка (рендеринг — вне границ этой
  фазы, `src/report/**`).
- **graphify: точные команды, проверено эмпирически** (`testaipack-opencode:latest`,
  2026-07-30, npm-маршрут, не `pip`/`uv` — репозиторий сам ссылается на
  python-путь, который в `node:22-slim` неисполним):
  - setup: `npm install -g --prefix $HOME/.local graphifyy` → устанавливает
    `graphifyy@0.10.1` (реэкспорт `@sentropic/graphify`, бинарник `graphify`).
  - check: `graphify --version` → `0.10.1`, exit 0.
  - exercise (LLM-free путь, без флага `--backend`, без сети после установки,
    без git-репозитория): `graphify extract <inputPath> --scope all
    --no-cluster` → `exit 0`, пишет `.graphify/.graphify_extract.json` +
    `.graphify/.graphify_ast.json` + `.graphify/cache/ast/*.json` +
    `.graphify/manifest.json`/`scope.json`/`.graphify_detect.json` —
    **все нетрекнутые артефакты, кандидаты на `.git/info/exclude`** (см. §6,
    diff hygiene) — именно эти файлы (`.graphify/cache/*`) засоряли diff в
    прошлом реальном эксперименте. `--scope all` — сознательный выбор:
    `--scope auto`/`committed`/`tracked` требуют git-репозиторий с
    коммитами, что exercise-контекст (свежая рабочая копия) не гарантирует.

## 9. Тест-кейсы (по одному на ветку контракта)

См. `src/phases/04b-pack-setup.test.ts` (16 тестов): no-op/`delivered-only`;
успешный setup + верификация HOME-копии на run 2/3; сбой setup (без копии);
таймаут setup; `installed-only`/`exercised` деривация режима; наличие/отсутствие/
пропуск marker-warning; матрица `derivePackSetupMode`; юнит-тесты
`scanForDependencyMarkers`. Плюс `src/isolation/shell-runner.test.ts` (12
тестов, `sh -c` vs `-lc`, `pathOverride` threading для обеих веток) и
`src/isolation/docker-runner.test.ts` (`probeImagePath`, 3 новых теста) —
изолированно закрепляют оба найденных PATH-бага регрессионными тестами.
Эмпирическая проверка всего механизма целиком (реальный
`testaipack-opencode:latest`, не только моки) прогонялась вручную вне
тестового набора — setup → HOME-копия → бинарник реально исполняется в
контейнере → PATH резолвится так же, как у bash-тула агента → гейт-6-подобная
проверка проходит на new и корректно фейлится (exit 127) на old.

## 10. Инварианты

- Ни при каком режиме сторона **old** не получает `--pack-setup`/
  `--pack-check`/`--pack-exercise` — «baseline без инструмента» проверяется
  гейтом 6 как **факт**, а не предполагается.
- `--pack-setup` выполняется **ровно один раз** за весь эксперимент; все
  остальные new-HOME получают точную копию установленного состояния.
- Setup/check/exercise никогда не попадают в метрики агента (токены, шаги,
  cost) — только wall-clock, и не в виде сфабрикованных нулей.
- Каждый run в итоге может заявить «pack установлен, функциональность
  подтверждена, exercise выполнен» — либо явно помечен unusable.
- Артефакты, порождённые exercise, не засоряют измеряемый diff — либо
  исключены (нетрекнутые), либо абортят эксперимент (трекнутые).

## 11. Зависимости от других фаз

- Зависит от: **03 pack-install** (`packInstall.packPath` для marker-скана),
  **04 home-isolation** (`homeNew[]`, уже посчитанный `EnvVarSet.PATH`).
- Блокирует: **05 preflight** (гейт 6 использует `homePathEnv` от этой фазы),
  run-loop в **`cli/pipeline.ts`** (per-run exercise).
- Результат (`PackSetupReport`) собирается целиком в `cli/pipeline.ts` из
  трёх источников (setup здесь, checks из гейта 6, exercises из run-loop) и
  пишется в `results/pack-setup.json` — рендеринг в отчёт (`src/report/**`,
  `11-report-render.ts`) вне границ этой фазы.
