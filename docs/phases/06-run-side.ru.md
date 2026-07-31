# Фаза 06: run-side

> Спека фазы. Контракт = `contract/phases/06-run-side.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Исполнить задачу (`--init` → `--prompt` → `--verify`) на каждом варианте для
каждого прогона 1..N. Варианты запускаются **параллельно, до
`runInput.parallel` штук одновременно**; прогоны внутри одного варианта —
**последовательно**. Собираем `raw/<variant>/run-N.events.ndjson` и
`raw/<variant>/run-N.json` (через `opencode export`).

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.RunSide` (см. `contract/phases/06-run-side.tsp`).
Внимание: фаза **не объявляет своей Result-модели** — на выходе используется
общий тип `RunResult` из `contract/main.tsp` (переименован из `RunSideResult`
— имя со `side`-полем было бы худшим из миров под D8, см.
`.research/n-way-variants/01-contract.md §3`).

- Вход: `RunSideInput` — на контракте `{ runInput: RunInput, manifest:
  Manifest, workspace: WorkspaceTree, homeEnv: EnvVarSet, variant: string,
  runIndex: int32, sessionId: string }`. **Локальное расширение**
  (`RunSideInputExt`, `src/phases/06-run-side.ts`) заменяет `variant: string`
  на **полный `VariantSpec`** — прогону нужны `prompt`/`init`/`hint`/
  `verify`/`pure` этого варианта, а не только его имя — плюс `dockerImage?`
  (резолвится фазой 04). Один вызов фазы = запуск **одного** варианта для
  **одного** прогона. Оркестратор запускает варианты конкурентно с лимитом
  `runInput.parallel` (`Effect.all(variants.map(runOneVariant), {
  concurrency: runInput.parallel })`, `src/cli/pipeline.ts`) и
  последовательно перебирает `runIndex` от 1 до `runs` внутри каждого
  варианта.
- Выход: `RunResult` — `{ variant: string, runIndex: int32, exportPath: string,
  eventsLogPath: string, successRank: SuccessRank, finishCause: FinishCause,
  exitCode: int32, durationMs: int64, verifyExitCode?: int32,
  watchdogTriggered: boolean, errorCode?: ErrorCode, initRan?: boolean,
  initWallMs?: int64, promptWallMs?: int64 }`. Все поля обязательные, кроме
  `verifyExitCode` (появляется только если у варианта есть эффективный
  `verify`) и `initRan`/`initWallMs` (появляются только если у варианта есть
  эффективный `init` — см. п. 3.2.b). `promptWallMs` пишется всегда:
  обвязочные (harness-side) `Date.now()`-таймеры вокруг каждого вызова
  opencode, а не `OnceResult.durationMs` (тот 0 на watchdog/timeout/error-
  ветках) — источник разбиения `init`/`task` для отчёта (см.
  `docs/phases/07-aggregate.ru.md`, раздел 9).
- Ошибки: `@error RunSideError` — `{ code, message, variant: string, runIndex:
  int32, context? }` (было `side: Side`), где `code` принимает только
  значения:
  - `E_RUN_TIMEOUT` — жёсткий таймаут `runInput.timeouts.runSeconds` (default
    600s) исчерпан.
  - `E_RUN_HANG_WATCHDOG` — нет нового JSON event за
    `runInput.timeouts.watchdogSeconds` (default 90s).
  - `E_RUN_CRASH` — non-zero exit opencode, не являющийся length/loop.
  - `E_VERIFY_TIMEOUT` — `verify` превысил `runInput.timeouts.verifySeconds`.
  - `E_VERIFY_FAILED` — `verify` завершился с exit ≠ 0 (не фатально для
    прогона — понижает `successRank`, но не фейлит фазу; см. edge-cases).
  - `E_RATE_LIMIT_EXHAUSTED` — в стриме встретился признак 429/rate-limit
    (одного совпадения достаточно, «серия» не требуется).
  - `E_OOM` — процесс убит ядром по OOM (сигнал/статус показывает out-of-memory).
  - `E_DISK_FULL` — `ENOSPC` при записи логов/export.
  - `E_PORT_CONFLICT` — opencode пытается занятый порт (для plugin/mcp с
    сетевыми зависимостями).
  - `E_EXPORT_INVALID` — `opencode export` упал или не валиден по схеме
    `OpencodeExport`.
  - `E_TOTAL_TIMEOUT` — исчерпан `runInput.timeouts.totalSeconds` (если задан)
    для всего run-N.

  **Какие коды реально фейлят фазу.** Большинство кодов выше оседают в
  `RunResult.errorCode` при `successRank = 0` (прогон при этом валиден, фаза
  продолжается) — включая `E_RUN_CRASH`/`E_RUN_TIMEOUT`/`E_EXPORT_INVALID` на
  export-шаге: один сломанный export не должен убивать все прогоны, включая
  уже завершённые и параллельно идущие на других вариантах. Фазу реально
  фейлит только:
  - `E_DISK_FULL` — машинно-глобальная, не прогонная проблема.
  - `E_RUN_CRASH` из guard-а «нет рабочей директории приложения для этого
    `(variant, runIndex)`» — это баг обвязки (фаза 02 не создала worktree),
    а не итог прогона.

`successRank` (0–4) — семантика не изменилась: `4` finish-stop, `3`
finish-tool-calls→stop, `2` length-limit, `1` doom-loop, `0` crash/ошибка/
таймаут/watchdog.

## 3. Шаги алгоритма

1. Запустить варианты конкурентно (`runOneVariant`, `src/cli/pipeline.ts`),
   ограничено `runInput.parallel`:

   ```
   runOneVariant(v) = for runIndex in 1..runs (sequential): runSide({variant: v, runIndex, ...})
   ```
   Варианты независимо (до `parallel` штук одновременно), внутри варианта
   строго последовательно (чтобы не накладывать N × количество вариантов
   параллельных процессов на машину и сохранить детерминированность метрик).
   Legacy-шим с дефолтным `parallel: 2` воспроизводит сегодняшний `old ‖ new`
   байт-в-байт.
2. Для одного прогона `runSide({variant, runIndex, ...})`:
   a. `sessionId` приходит уже сгенерированным в `RunSideInput.sessionId`
      (`makeSessionId(runId, variant.name, runIndex)` — формат
      `<runId>-<variantName>-<runIndex>-<rand6hex>`; была строка `side`,
      теперь имя варианта как есть).
   b. `effectiveInit = effectiveOf(variant, runInput.init, 'init')`;
      `hasInit = effectiveInit !== undefined && effectiveInit !== ''`. Если
      есть эффективный init — запустить
      `HOME=<homeEnv> opencode run --agent build --session <sessionId> --format json --auto "<effectiveInit>"`.
      Стрим событий в `raw/<variant>/run-<runIndex>.events.ndjson`. Таймаут —
      `timeouts.runSeconds`, watchdog — `timeouts.watchdogSeconds`. **Больше
      нет отдельного «routing»-решения по стороне** — старый `--init-side`
      (`both|new|old`) существовал только затем, чтобы направить ОДИН общий
      текст init на нужную сторону; в v2 у каждого варианта просто есть или
      нет собственного эффективного init (унаследованного или явно
      отключённого через `init: ""`, решение D7). Legacy-шим воспроизводит
      старую маршрутизацию десугаром в фазе 00 (`docs/phases/00-cli-parse.ru.md
      §3.4`): `--init-side new` десугарируется в «только `new`-вариант несёт
      `init`», что даёт тот же результат, что и раньше, но через обычный
      механизм наследования, а не через рантайм-ветвление здесь.
   c. Запустить основной промпт:
      `HOME=<homeEnv> opencode run --agent build --continue --session <sessionId> --format json --auto "<effectiveTaskPrompt(runInput, variant)>"`.
      `effectiveTaskPrompt = effectiveOf(variant, prompt, 'prompt') + "\n\n" +
      effectiveOf(variant, hint, 'hint')` (если hint есть) — преемник
      прежнего глобального `packHint`-аппенда, теперь per-variant текст
      (у двух вариантов он может законно отличаться; отчёт раскрывает это
      явно, см. `docs/phases/11-report-render.ru.md`). Если `--init` не
      было, `--continue` опускается. Вокруг каждого из двух вызовов обвязка
      меряет собственный wall-clock (`Date.now()` до/после) — это
      `initWallMs`/`promptWallMs` в `RunResult`.
   d. **Watchdog:** отдельная задача следит за `mtime` файла `.events.ndjson`.
      Если за `timeouts.watchdogSeconds` секунд не было новой строки → kill
      opencode-process, пометить `watchdogTriggered = true`, exit-причину →
      `E_RUN_HANG_WATCHDOG`.
   e. **Жёсткий таймаут:** если общее время превысило `timeouts.runSeconds` →
      kill, `E_RUN_TIMEOUT`. Если задан `timeouts.totalSeconds` и он
      исчерпан → `E_TOTAL_TIMEOUT`.
   f. По завершении процесса (normal / killed): выполнить
      `HOME=<homeEnv> opencode export <sessionId>` → записать в
      `raw/<variant>/run-<runIndex>.json`, прочитать и провалидировать по
      схеме `OpencodeExport`. Ограниченный retry с экспоненциальным backoff
      (до 3 попыток, старт 200ms, потолок ожидания 3s), если провал именно на
      шаге валидации схемы. Процесс/таймаут самого `opencode export` — retry
      не делается. В любом из трёх исходов (`E_RUN_CRASH` / `E_RUN_TIMEOUT` /
      `E_EXPORT_INVALID` после исчерпания retry) фаза **не падает**: прогон
      принудительно понижается до `successRank = 0` с этим `errorCode`,
      `--verify` для него пропускается. Настоящий `ENOSPC` при записи самого
      export-файла — исключение, он всё ещё валит фазу с `E_DISK_FULL`.
   g. Определить `finishCause` из последнего `step-finish` event-а и
      `successRank` по правилам выше. Итоговый `exitCode` — «combined»: первый
      ненулевой код среди вызовов (`--init`, если был, и `--prompt`), иначе
      код последнего вызова. Non-zero exit opencode → `E_RUN_CRASH` +
      `successRank = 0` (НЕ retry).
   h. Rate-limit: сканируется только текст assistant text-part и `output`
      **упавшего** tool-call (`state.status === "error"`) — совпадение с
      `429`/`rate limit`/`rate_limit`/`too many requests` → `E_RATE_LIMIT_EXHAUSTED`,
      `successRank = 0`, НЕ retry.
   i. Process killed by OOM → `E_OOM`, `successRank = 0`.
   j. Context-overflow (`finishCause = "length"`) — **валидный** результат,
      `successRank = 2`, НЕ retry.
   k. `ENOSPC` при записи → `E_DISK_FULL`. Конфликт порта от plugin/mcp →
      `E_PORT_CONFLICT`.
   l. Если у варианта есть эффективный `verify`
      (`effectiveOf(variant, runInput.verify, 'verify')`):
      - запустить `cd apps/<variant>/run-<runIndex>/ && <verify>` с
        таймаутом `timeouts.verifySeconds`.
      - exit ≠ 0 → `verifyExitCode = code`, **понижаем** `successRank` на 1
        (min 0); `E_VERIFY_FAILED` — НЕ фатально для прогона.
      - таймаут → `E_VERIFY_TIMEOUT`, `verifyExitCode` не задаётся,
        `successRank = 0`.
3. Собрать `RunResult` для прогона (+ локальное расширение `errorCode`, если
   оно задано). Записать его как есть в
   `raw/<variant>/run-<n>.result.json` — best-effort (сбой записи логируется
   и не фейлит прогон). Вернуть `RunResult`.

## 4. Входные/выходные файлы

| Файл                                    | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------------- | ------------- | -------------------- |
| `raw/<variant>/run-<n>.events.ndjson`   | Запись        | поток JSONL событий  |
| `raw/<variant>/run-<n>.json`            | Запись        | `OpencodeExport`     |
| `raw/<variant>/run-<n>.result.json`     | Запись (best-effort) | `RunResult` (+ локальный `errorCode`) |
| `apps/<variant>/run-<n>/`               | Чтение+Запись | рабочее дерево агента |
| `config/.config/opencode/<variant>/opencode.json`  | Запись | строка `OPENCODE_CONFIG_CONTENT` + `\n` |
| `config/.config/opencode/<variant>/installed.json` | Запись | внутренний JSON (не в контракте) |
| `config/.config/opencode/<variant>/usage.json`     | Запись | внутренний JSON (не в контракте) |
| `config/.config/opencode/<variant>/home/*`         | Запись | байт-копии из `home/<variant>/run-1/.config/opencode/` |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                         | Код                        |
| --------------------------------------------------- | -------------------------------------------------- | -------------------------- |
| Жёсткий таймаут `timeouts.runSeconds` исчерпан      | kill, `successRank = 0`, прогон failed             | `E_RUN_TIMEOUT`            |
| `timeouts.totalSeconds` (если задан) исчерпан       | kill, `successRank = 0`, failed                    | `E_TOTAL_TIMEOUT`          |
| Watchdog: нет событий `timeouts.watchdogSeconds`    | kill, `successRank = 0`, failed                    | `E_RUN_HANG_WATCHDOG`      |
| opencode non-zero exit (не length)                  | `successRank = 0`, НЕ retry                        | `E_RUN_CRASH`              |
| Context overflow (finish = length)                  | **валидный**, `successRank = 2`, не retry          | —                          |
| HTTP 429 серией, retry исчерпан                     | `successRank = 0`, не retry                        | `E_RATE_LIMIT_EXHAUSTED`   |
| Doom-loop (один tool × N без прогресса)             | `successRank = 1`, валидный результат              | —                          |
| `--verify` exit ≠ 0                                 | понижение `successRank`, не фатально               | `E_VERIFY_FAILED`          |
| `--verify` таймаут                                  | `successRank = 0`, failed                          | `E_VERIFY_TIMEOUT`         |
| У варианта нет эффективного `init`                  | шаг `b` пропускается, `--prompt` без `--continue`  | —                          |
| `variant.init: ""` явно отключает унаследованный глобальный init | как «нет эффективного init»          | —                          |
| `opencode export` вернул невалидный по схеме JSON (первые попытки) | ограниченный retry с backoff (до 3 раз) | —              |
| `opencode export` невалиден и после исчерпания retry | фаза ОК, `successRank = 0`, `--verify` пропущен, данные в `.events.ndjson` живут | `E_EXPORT_INVALID` |
| `opencode export` падает как процесс / таймаут       | retry не делается; фаза ОК, `successRank = 0`, `--verify` пропущен | `E_RUN_CRASH` / `E_RUN_TIMEOUT` |
| «429» встретился в успешном выводе tool (не в тексте/ошибке) | НЕ засчитывается как rate-limit           | —                          |
| `--init` упал (non-zero), `--prompt` после него завершился нулём | итоговый `exitCode` = код `--init` (первый non-zero) | `E_RUN_CRASH` |
| Процесс убит по OOM                                 | `successRank = 0`                                  | `E_OOM`                    |
| `ENOSPC` при записи логов/export                    | `successRank = 0`, failed                          | `E_DISK_FULL`              |
| Plugin/mcp пытается занять занятый порт             | `successRank = 0`, failed                          | `E_PORT_CONFLICT`          |
| `runInput.parallel = 1`                             | варианты стартуют строго по очереди                | —                          |
| `runInput.parallel ≥ variants.length`                | все варианты стартуют одновременно                 | —                          |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path stop / tool-calls finish / length-limit / doom-loop / crash /
  timeout / total-timeout / watchdog / rate-limit / rate-limit false-positive
  guard / OOM kill / disk full / port conflict / export invalid (retry
  exhausted / recovers) / export produced no data / export timeout / events
  write failure — те же исходы и коды, что раньше, теперь атрибутированы
  `variant` вместо `side`.
- ✅ combined exit code: `--init` падает (non-zero), `--prompt` после него
  завершается нулём → `RunResult.exitCode` = код `--init`.
- ✅ `--init` then `--prompt`: два вызова opencode с одним `--session`,
  `--continue` на втором.
- ✅ вариант без эффективного init: `variant.init` не задан и глобальный
  `runInput.init` не задан → шаг b пропущен, `--prompt` без `--continue`.
- ✅ вариант с унаследованным init: `variant.init` не задан, но
  `runInput.init` задан → init выполняется с глобальным текстом.
- ✅ `variant.init: ""` отключает унаследованный init явно (D7) — тот же
  эффект, что «нет эффективного init».
- ✅ `--verify` ok/fail/timeout — как раньше, по эффективному `verify`
  варианта.
- ✅ N-way parallelism: `parallel = 2`, 3 варианта → ровно 2 запускаются
  одновременно, третий стартует по освобождению слота (spy на start order);
  `parallel = 1` → строго по очереди; `parallel = 3` → все три стартуют
  до завершения любого. Прогоны внутри варианта всегда последовательны.
- ✅ `makeSessionId`: формат `<runId>-<variantName>-<runIndex>-<rand6hex>`,
  имя варианта как есть (не `old`/`new`-литерал).
- ✅ run-N.result.json: пишется после прогона, парсится по `RunResult`
  (плюс локальный `errorCode`), совпадает с возвращённым результатом,
  несёт `variant`.
- ✅ run-N.result.json write failure: сбой записи (fs) не фейлит прогон.
- ❌ НЕ покрыто (ticket): повторяемая инвалидация export при несовместимой
  версии opencode.

## 7. Инварианты

- Для каждой пары `(variant, n)` фаза всегда возвращает `RunResult`; если
  export провалился, `raw/<variant>/run-N.json` на диске может отсутствовать
  или быть невалидным — это не мешает фазе продолжить остальные прогоны и
  варианты.
- `successRank ∈ {0,1,2,3,4}` определён для **каждого** прогона (даже failed
  получает 0).
- Варианты стартуют не более чем по `runInput.parallel` одновременно; прогоны
  внутри варианта строго последовательны.
- `--init` и `--prompt` выполняются в одной opencode-сессии (`--continue`) на
  варианте, у которого есть эффективный `init`; на варианте без эффективного
  init `--prompt` стартует свежую сессию. Решение о наличии init — чисто
  per-variant (`effectiveOf`), никакого рантайм-«routing» по глобальному
  флагу больше нет.
- Watchdog и жёсткий таймаут взаимоисключающи по эффекту, но оба могут
  сработать: watchdog срабатывает раньше и помечает причину как hang.

## 8. Зависимости от других фаз

- Зависит от: **02 repo-clone** (рабочие деревья, в которых работает агент),
  **04 home-isolation** (`EnvVarSet` (`homeEnv`) и HOME-структура каждого
  варианта), **05 preflight** (ok-preflight обязателен, если
  `runInput.preflightEnabled`).
- Блокирует: **07 aggregate** (читает `raw/<variant>/run-N.json`),
  **08 diff** (git diff в рабочих деревьях после прогона),
  **10 timeline** (читает `raw/<variant>/run-N.json`).
- Параллелизуется с: сама с собой по оси `variant`, ограничено
  `runInput.parallel`.

## 9. Снимок конфигурации opencode

После того как все варианты отработали свои прогоны, `src/phases/06-config-capture.ts`
(соседний helper фазы 06, не отдельная нумерованная фаза) сохраняет в
`config/.config/opencode/<variant>/` картину того, какой конфиг и какие
зависимости реально использовал каждый вариант:

- `opencode.json` — точное содержимое `OPENCODE_CONFIG_CONTENT`, полученное
  этим вариантом (последний и приоритетный слой merge opencode; сам opencode
  никогда не материализует единый эффективный конфиг, поэтому testaipack его
  не синтезирует, а сохраняет слои рядом).
- `home/` — байт-копии `opencode.jsonc`, `opencode.json`, `package.json`,
  `package-lock.json` из `home/<variant>/run-1/.config/opencode/` (каждый —
  только если существует). `node_modules/` не копируется никогда.
- `installed.json` (`InstalledJson { variant, ... }`) — что реально
  установлено: skills (имя + цель symlink-а либо content-хеш копии), agents, commands, plugin-файлы
  и plugin-config-спеки, имена mcp-серверов, npm-зависимости
  (`package.json`), `configMergeOrder`, и `identicalAcrossRuns`/`driftFiles`
  — сверка отслеживаемых файлов run-1 с run-2..run-N ЭТОГО варианта.
- `usage.json` (`UsageJson { variant, ... }`) — что реально вызывалось, по
  данным `results/raw/<variant>/run-N.events.ndjson`: счётчики `toolCalls` по
  именам инструментов и список вызовов `skill` (`run`, `name`, `status`,
  `error`). Использование plugin-хуков и npm-пакетов **не наблюдаемо** — это
  явно перечислено в `notKnowable`, а не домысливается.

Захват идёт **один раз на вариант**, из `run-1` (отслеживаемые файлы одного
варианта у всех его прогонов байт-в-байт идентичны — гарантия фазы 04, но
`driftFiles` всё равно её перепроверяет, а не предполагает вслепую).
Захват — best-effort: ошибка не валит уже завершённый прогон, а пишет
предупреждение в лог оркестратора (`src/cli/pipeline.ts`). Выполняется
после прогонов (внутри фазы 06) и до `--ephemeral`-очистки (фаза 13, которая
иначе удалила бы единственную копию этой картины вместе с `home/`).
