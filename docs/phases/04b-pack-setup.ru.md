# Фаза 04b: pack-setup

> Спека фазы. Контракт = `contract/phases/04b-pack-setup.tsp`. Реализация —
> TypeScript strict + Effect-TS. Ненумерованная фаза-«сиблинг» (как
> `captureOpencodeConfig`) — вставлена между 04 и 05 без сдвига
> `PHASE_COUNT`/номеров остальных фаз.

## 1. Назначение

Сделать инструмент отвечающим на свой прямой вопрос: не просто доставить пак
на вариант, который его объявил (это уже сделали фазы 03/04), а **установить
его зависимость** (`PackSpec.setup`), **проверить, что она реально работает**
(`PackSpec.check`, гейт 6 в фазе 05) и **прогнать её один раз перед агентской
сессией** (`VariantSpec.exercise`, пер-run шаг в `cli/pipeline.ts`) — прежде
чем измерять что-либо. Раньше модель могла получить файлы пака и просто не
воспользоваться ими; часть прогонов «after» в реальном эксперименте так и не
завели инструмент, но всё равно считались валидными.

`setup`/`check` теперь принадлежат **паку** (`PackSpec`, реестр эксперимента);
`exercise` принадлежит **варианту** (`VariantSpec`) — один пак может быть
объявлен несколькими вариантами, и у каждого из них может быть свой
`exercise`, но `setup`/`check` — общее свойство самого пака (см. `.research/
n-way-variants/01-contract.md §2`, комментарий `PackSpec`). Все три —
опциональные и составляют **один режим** на КАЖДЫЙ пак реестра (`PackSetupMode`):

- `exercised` — хотя бы один объявивший этот пак вариант несёт `exercise`
  (`setup`/`check` могут быть заданы или нет).
- `installed-only` — задан `setup` и/или `check` пака, но ни один
  объявивший вариант не несёт `exercise`.
- `delivered-only` — ничего из трёх не задано ни для пака, ни для его
  вариантов; байт-в-байт то же поведение, что было до этой фазы. Пак без
  ничего запускаемого **не проваливает** прогон — он деградирует до
  `installed-only`/`delivered-only` и явно сообщает об этом в отчёте (см.
  `undeclaredDepWarning` ниже), а не падает.

Эта фаза (04b) отвечает только за **`setup`** — установку **один раз на
каждую пару (объявивший вариант, пак)** (решение D6,
`.research/n-way-variants/00-overview.md §5`) и копирование результата на
остальные HOME этого же варианта. `checks` (гейт 6, фаза 05) и `exercises`
(пер-run шаг в `cli/pipeline.ts`) заполняются другими местами и сливаются в
единый `PrepReport { packs: PackPrep[], variants: VariantPrep[] }` в
`cli/pipeline.ts`.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.PackSetup` (см. `contract/phases/04b-pack-setup.tsp`).

- Вход: `PackSetupInput` — `{ runInput, manifest, workspace, packInstall? }`.
  Локальное расширение `PackSetupInputExt` (`src/phases/04b-pack-setup.ts`)
  добавляет `dockerImage?` и `envVars?: VariantEnv[]` — уже посчитанный фазой
  04 `EnvVarSet.PATH` для run-1 HOME каждого варианта, переиспользуется
  (`input.envVars?.find(e => e.name === v.name)?.envs[0]?.PATH`), а не
  пересчитывается, чтобы `setup` резолвил HOME-установленный бинарник ровно
  так же, как это сделает bash-тул самого агента.
- Выход: `PackSetupResult` — `{ report: PrepReport, logPath: string }`.
- `PrepReport` (в `main.tsp`, общий для всех трёх источников): `{ packs:
  PackPrep[], variants: VariantPrep[] }`.
  - `PackPrep` — паковая (не вариантная) половина: `{ pack, mode,
    setupDeclared, checkDeclared, exerciseDeclared, undeclaredDepWarning?,
    setups: PackCmdResult[], checks: PackCmdResult[] }` — одна запись на
    каждый пак реестра. `exerciseDeclared` = «хотя бы один объявивший этот
    пак вариант несёт `exercise`».
  - `VariantPrep` — вариантная половина: `{ variant, exerciseDeclared,
    exercises: PackCmdResult[] }` — одна запись на каждый вариант.
- `PackCmdResult` — `{ variant, pack?, runIndex, exitCode, durationMs,
  outputTail?, artifactHash? }`. `pack` отсутствует для `exercise`-записей
  (exercise принадлежит варианту, не паку). `artifactHash` заполняется
  только `exercises`-записями (см. §6 «diff hygiene» и
  `docs/phases/08-diff.ru.md`).
- Ошибки: `@error PackSetupError` — `{ code, message, context? }`, коды:
  - `E_PACK_SETUP_FAILED` — `setup` завершился ненулевым кодом, либо
    сбой копирования HOME.
  - `E_PACK_SETUP_TIMEOUT` — `setup` не уложился в
    `runInput.timeouts.installSeconds` (отдельного флага таймаута для
    setup/check/exercise нет — переиспользуется существующий install-таймаут).

## 3. Шаги алгоритма

**Проход 1 — по каждому паку реестра** (чистая деривация, без побочных
эффектов): `declaringVariants = runInput.variants.filter(v =>
v.packs.includes(pack.name))`; `setupDeclared = pack.setup !== undefined`;
`checkDeclared = pack.check !== undefined`; `exerciseDeclared =
declaringVariants.some(v => v.exercise !== undefined)`; `checkVerified =
checkDeclared && runInput.preflightEnabled` (`check` без preflight никогда не
выполнится — фаза 00 такую комбинацию уже отвергает, но `mode` остаётся
защитным дублем); `mode = derivePackSetupMode(setupDeclared, checkVerified,
exerciseDeclared)`. Если ничего не задано (`!setupDeclared &&
!exerciseDeclared`) — `scanForDependencyMarkers(packRoot)` эвристически
проверяет `pyproject.toml`, `package.json` с полем `bin`, `requirements*.txt`,
а также текст установочной команды (`pip install`/`uv tool install`/
`npm i(nstall)`/`npx `) в `SKILL.md`/`README.md` внутри `pack/<name>/`. Если
найдено — `undeclaredDepWarning` попадает в отчёт («пак, похоже, оборачивает
внешний рантайм, но ничего не задекларировано»). Это не жёсткое требование —
самодостаточные паки без внешних зависимостей должны продолжать работать без
единого нового флага.

**Проход 2 — по каждому варианту, по каждому ИЗ ЕГО объявленных паков с
`setup`** (порядок конфига): если `!setupDeclared` для конкретного пака —
пропускается целиком, `report.packs[*].setups` не получает записи от этого
варианта. Иначе — запускается `pack.setup` **один раз** через
`runShellInHome(cmd, homeVariant[0], appVariant[0], docker, timeoutMs,
pathOverride)` (docker-aware, `sh -c`, никогда `sh -lc` — см. §4), где
`homeVariant[0]`/`appVariant[0]` — run-1 пути **именно этого варианта**.
Таймаут/ненулевой код → `Effect.fail` с соответствующим кодом
(`{ variant, pack }` в контексте), HOME не копируется. При успехе —
`homeVariant[0]` **заменяет** (`removeDir` + `copyDir`, не мёрджит) каждый
`homeVariant[1..N-1]` **того же варианта**: все HOME одного варианта на
старте байт-идентичны (фаза 04 строит их из одного скелета+auth+инструкций),
так что это единственный сетевой/установочный вызов на пару (вариант, пак),
а не один на прогон. Если пак объявлен несколькими вариантами — `setup`
выполняется отдельно **в каждом** из них (D6: сетевой HOME двух разных
вариантов никогда не общий, поскольку варианты различаются набором паков/
конфигурацией) — одна запись `PackCmdResult` на каждую пару (объявивший
вариант, пак), `runIndex: 0`.

Лог (`results/pack-setup.log`) собирается из неизменяемого `Ref` (не
инкрементальный `.push()` — правило `functional/immutable-data`): секция per
pack с `declared-mode`, затем построчно `[SETUP <variant>/<pack>] exitCode=…
durationMs=…`.

## 4. PATH и docker (см. также `docs/phases/04-home-isolation.ru.md`)

Критично для корректности всего механизма — см. пункт «эмпирически найденные
баги» ниже. `runShellInHome` (общий хелпер для 04b/гейта 6/exercise,
`src/isolation/shell-runner.ts`) принимает опциональный `pathOverride`:

- В docker-режиме передаётся как `-e PATH=<pathOverride>`.
- В host-режиме — переопределяет `PATH` в env-записи процесса.
- Оба ветки используют `sh -c`, **никогда** `sh -lc`.

`pathOverride` — это ровно тот `EnvVarSet.PATH`, который фаза 04 уже
вычислила для run-1 HOME соответствующего варианта (`setupPathFor` в
`04-home-isolation.ts`, `<homeDir>/.local/bin:<остальной PATH>`), переданный
через `input.envVars` (04b) / `PreflightInputExt` per-variant PATH (гейт 6) /
`homeEnv.PATH` (exercise, `cli/pipeline.ts`) — без повторного пробирования.
Как и в фазе 04, PATH одинаково добавлен КАЖДОМУ варианту, если хотя бы один
пак реестра объявляет `setup` — только присутствие бинарника отличается по
вариантам, не его достижимость.

**Эмпирически подтверждённые баги при реализации** (докер-образ
`testaipack-opencode:latest`, проверено напрямую через `docker run`, не
только юнит-тестами):

1. **Login shell сбрасывает PATH.** `/etc/profile` образа безусловно
   переустанавливает `PATH` в UID-зависимое хардкод-значение при login-shell
   (`sh -lc`), независимо от того, что было передано через `-e PATH=...` или
   унаследовано. `sh -c` (non-login) этого не делает. Если бы этот баг не
   был найден до релиза — каждый вызов `setup`/`check`/`exercise` видел бы
   неверный PATH, и гейт 6 всегда репортил бы инструмент как отсутствующий,
   даже когда он реально установлен.
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
| `home/<variant>/run-1/` (и остальные HOME того же варианта) | Запись | `setup` пишет сюда, копируется на run-2..N ТОГО ЖЕ варианта |
| `results/pack-setup.log`       | Запись        | текст, `writeLog`         |
| `results/prep.json`            | Запись (в `cli/pipeline.ts`, не в этой фазе) | `PrepReport`, собран из setups(04b)+checks(гейт 6)+exercises(pipeline) |

## 6. Гейт 6 и exercise (не в этой фазе, но часть одного `PrepReport`)

- **Гейт 6 `pack-functional`** — `05-preflight.ts`. Запускает `check` пака
  через тот же `runShellInHome` на **каждом** HOME **каждого** варианта, не
  только на run-1: для пака, объявленного вариантами A/B и не объявленного
  вариантом C — `check` обязан пройти во всех HOME A и B, и обязан НЕ пройти
  во всех HOME C, если только (C, pack) не в `C.allowPacks` (преемник
  `--allow-baseline-tool`, теперь per-(вариант, пак) — см.
  `docs/phases/05-preflight.ru.md`). 04b копирует один установленный HOME на
  остальные HOME того же варианта, и именно эта копия — то самое место, где
  HOME может тихо остаться без рабочей установки (см. фикс `verbatimSymlinks`
  у `copyDir` в `util/fs.ts`); гейт, проверяющий только run-1, ничего не
  доказывает про run-2..N. `PackPrep.checks` получает один `PackCmdResult`
  на каждый проверенный HOME каждого варианта.
- **Exercise** — `cli/pipeline.ts`, `runPackExercise`, пер-run, для КАЖДОГО
  варианта с `exercise`, до старта агентской сессии. Сбой/таймаут
  **контейнит только этот run** (`successRank:0, finishCause:'error',
  errorCode:'E_PACK_EXERCISE_FAILED'`, агентская сессия не запускается) —
  не абортит весь эксперимент и, что важнее всего, не даёт этому прогону
  тихо стать де-факто baseline-прогоном. Успешный exercise проверяется на
  «diff hygiene»: `git status --porcelain` → трекнутый файл изменён → жёсткий
  abort всего эксперимента (`E_PACK_EXERCISE_DIRTY`, не контейнится); новый
  нетрекнутый файл (`??`) → добавляется в `.git/info/exclude` +
  `computeArtifactHash` пишется в `run-N.exercise.json` (детерминизм-триггер
  на собственный пайплайн пака; см. `docs/phases/08-diff.ru.md`).
  `VariantPrep.exercises` содержит по одной записи на прогон варианта.
- Setup/check/exercise дают **только wall-clock**, никогда — токены/шаги/
  cost (это работа харнесса, не агента); нулевые значения этих метрик не
  подставляются, потому что ноль читается как «измерено — ничего», а не как
  «неприменимо». `RunResult.setupWallMs` — экземплярное поле,
  зарезервированное для parallel metric-split; агрегация (`PhaseSplit.setup`/
  `setupStats`) — вне границ этой фазы.

## 7. Edge-cases и ошибки

| Кейс                                                        | Поведение                                             | Код |
| ------------------------------------------------------------ | ------------------------------------------------------ | --- |
| Ничего не задано ни для пака, ни для его вариантов            | no-op, `mode: delivered-only`                          | —   |
| Задан только `setup`/`check` пака, без exercise ни у одного объявившего варианта | `mode: installed-only`                | —   |
| Хотя бы один объявивший вариант несёт `exercise`               | `mode: exercised`                                      | —   |
| Пак без ничего запускаемого, найдены маркеры зависимости      | `undeclaredDepWarning` в отчёте, не fail                | —   |
| `setup` таймаут                                                | fail всего эксперимента                                | `E_PACK_SETUP_TIMEOUT` |
| `setup` ненулевой exit                                         | fail всего эксперимента                                | `E_PACK_SETUP_FAILED` |
| Сбой копирования HOME на run 2..N того же варианта              | fail всего эксперимента                                | `E_PACK_SETUP_FAILED` |
| Пак объявлен 2 вариантами, `setup` у одного из них падает        | fail эксперимента, называет конкретную пару (вариант, пак) | `E_PACK_SETUP_FAILED` |
| `check` пака объявлен → гейт 6 не прошёл                       | fail всего эксперимента (см. §6)                       | `E_PACK_CHECK_FAILED` |
| Чужой (не объявивший) вариант неожиданно уже имеет инструмент  | fail (жёстко), кроме `allowPacks` этого варианта        | `E_PACK_CHECK_FAILED` |
| `setup` без `check`                                            | предупреждение в отчёте: claim о функциональности не проверен | — |
| `exercise` без `check`                                         | предупреждение (генерализовано на N вариантов, `cli/pipeline.ts`), не fail | — |
| Один run: `exercise` падает/таймаутит                          | контейнит только этот run, unusable для этого варианта  | `E_PACK_EXERCISE_FAILED` (на уровне `RunResultExt`) |
| Exercise модифицирует трекнутый файл                            | жёсткий abort всего эксперимента                        | `E_PACK_EXERCISE_DIRTY` |
| Exercise создаёт нетрекнутые файлы                              | исключаются из diff (`.git/info/exclude`), не fail      | — |

## 8. Открытые вопросы спеки, зафиксированные решения

- **Чужой вариант уже содержит инструмент** → жёсткий fail с явным override
  через `variant.allowPacks` (см. §6, гейт 6).
- **Таймаут** переиспользует `timeouts.installSeconds`; отдельного флага нет.
- **Сбой exercise** контейнит только один прогон одного варианта, не абортит
  весь эксперимент, и не даёт ему тихо стать de-facto baseline.
- **Межэкспериментное кэширование пакетов** — отложено, не реализовано.
- **`check`** остаётся рекомендуемым, не обязательным; при `setup`
  без `check` — громкое предупреждение и явная пометка «функциональность
  не подтверждена» в отчёте.
- **Если CLI самого пака сам обращается к модели** — эти токены невидимы
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

См. `src/phases/04b-pack-setup.test.ts`: no-op/`delivered-only`; успешный
setup + верификация HOME-копии на run 2/3 того же варианта; сбой setup (без
копии); таймаут setup; пак, объявленный двумя вариантами — `setup`
выполняется отдельно в каждом, независимая HOME-копия на каждый вариант;
`installed-only`/`exercised` деривация режима; наличие/отсутствие/пропуск
marker-warning; матрица `derivePackSetupMode`; юнит-тесты
`scanForDependencyMarkers`. Плюс `src/isolation/shell-runner.test.ts` (`sh -c`
vs `-lc`, `pathOverride` threading для обеих веток) и
`src/isolation/docker-runner.test.ts` (`probeImagePath`) — изолированно
закрепляют оба найденных PATH-бага регрессионными тестами.
Эмпирическая проверка всего механизма целиком (реальный
`testaipack-opencode:latest`, не только моки) прогонялась вручную вне
тестового набора — setup → HOME-копия → бинарник реально исполняется в
контейнере → PATH резолвится так же, как у bash-тула агента → гейт-6-подобная
проверка проходит на объявившем варианте и корректно фейлится (exit 127) на
не объявившем.

## 10. Инварианты

- Вариант, не объявивший пак, **никогда** не получает его `setup`/`check`/
  `exercise` — «чужой без инструмента» проверяется гейтом 6 как **факт**, а
  не предполагается.
- `setup` пака выполняется **ровно один раз на каждую пару (объявивший
  вариант, пак)**; все остальные HOME того же варианта получают точную копию
  установленного состояния.
- Setup/check/exercise никогда не попадают в метрики агента (токены, шаги,
  cost) — только wall-clock, и не в виде сфабрикованных нулей.
- Каждый прогон в итоге может заявить «пак установлен, функциональность
  подтверждена, exercise выполнен» — либо явно помечен unusable.
- Артефакты, порождённые exercise, не засоряют измеряемый diff — либо
  исключены (нетрекнутые), либо абортят эксперимент (трекнутые).

## 11. Зависимости от других фаз

- Зависит от: **03 pack-install** (`packInstall.deliveries[*].packPath` для
  marker-скана), **04 home-isolation** (`home/<variant>/run-{1..N}/`, уже
  посчитанный `VariantEnv[*].envs[0].PATH`).
- Блокирует: **05 preflight** (гейт 6 использует PATH этой фазы), run-loop в
  **`cli/pipeline.ts`** (per-run exercise).
- Результат (`PrepReport`) собирается целиком в `cli/pipeline.ts` из трёх
  источников (setups здесь, checks из гейта 6, exercises из run-loop) и
  пишется в `results/prep.json` — рендеринг в отчёт (`src/report/**`,
  `11-report-render.ts`) вне границ этой фазы.
