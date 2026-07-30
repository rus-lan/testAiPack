# Фаза 06: run-side

> Спека фазы. Контракт = `contract/phases/06-run-side.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Исполнить задачу (`--init` → `--prompt` → `--verify`) на каждой стороне для
каждого прогона 1..N. Стороны `old` и `new` запускаются **параллельно**;
прогоны внутри одной стороны — **последовательно**. Собираем `raw/<side>/run-N.events.ndjson`
и `raw/<side>/run-N.json` (через `opencode export`).

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.RunSide` (см. `contract/phases/06-run-side.tsp`).
Внимание: фаза **не объявляет своей Result-модели** — на выходе используется
общий тип `RunSideResult` из `contract/main.tsp`.

- Вход: `RunSideInput` — `{ runInput: RunInput, manifest: Manifest, workspace:
  WorkspaceTree, homeEnv: EnvVarSet, side: Side, runIndex: int32, sessionId:
  string }`. Один вызов фазы = запуск **одной** стороны для **одного** прогона.
  Оркестратор параллельно запускает две стороны через
  `Effect.zipPar(runSide({side:"old",...}), runSide({side:"new",...}))` и
  последовательно перебирает `runIndex` от 1 до `runs` внутри каждой стороны.
- Выход: `RunSideResult` — `{ side: Side, runIndex: int32, exportPath: string,
  eventsLogPath: string, successRank: SuccessRank, finishCause: FinishCause,
  exitCode: int32, durationMs: int64, verifyExitCode?: int32,
  watchdogTriggered: boolean, initRan?: boolean, initWallMs?: int64,
  promptWallMs?: int64 }`. Все поля обязательные, кроме `verifyExitCode`
  (появляется только если задан `verify`) и `initRan`/`initWallMs`
  (появляются только если `--init` реально выполнялся на этой стороне —
  см. п. 3.2.b). `promptWallMs` пишется всегда: обвязочные (harness-side)
  `Date.now()`-таймеры вокруг каждого вызова opencode, а не
  `OnceResult.durationMs` (тот 0 на watchdog/timeout/error-ветках) — источник
  разбиения `init`/`task` для отчёта (см. `docs/phases/07-aggregate.ru.md`,
  спека `.research/metric-split/spec.md` §5.1).
- Ошибки: `@error RunSideError` — `{ code, message, side: Side, runIndex: int32,
  context? }`, где `code` принимает только значения:
  - `E_RUN_TIMEOUT` — жёсткий таймаут `runInput.timeouts.runSeconds` (default
    600s) исчерпан.
  - `E_RUN_HANG_WATCHDOG` — нет нового JSON event за
    `runInput.timeouts.watchdogSeconds` (default 90s).
  - `E_RUN_CRASH` — non-zero exit opencode, не являющийся length/loop.
  - `E_VERIFY_TIMEOUT` — `verify` превысил `runInput.timeouts.verifySeconds`.
  - `E_VERIFY_FAILED` — `verify` завершился с exit ≠ 0 (не фатально для
    прогона — понижает `successRank`, но не фейлит фазу; см. edge-cases).
  - `E_RATE_LIMIT_EXHAUSTED` — в стриме встретился признак 429/rate-limit
    (см. ниже про область сканирования; одного совпадения достаточно,
    «серия» не требуется).
  - `E_OOM` — процесс убит ядром по OOM (сигнал/статус показывает out-of-memory).
  - `E_DISK_FULL` — `ENOSPC` при записи логов/export.
  - `E_PORT_CONFLICT` — opencode пытается занятый порт (для plugin/mcp с
    сетевыми зависимостями).
  - `E_EXPORT_INVALID` — `opencode export` упал или не валиден по схеме
    `OpencodeExport`.
  - `E_TOTAL_TIMEOUT` — исчерпан `runInput.timeouts.totalSeconds` (если задан)
    для всего run-N.

  **Какие коды реально фейлят фазу.** Контракт декларирует все коды выше как
  legal errors, но по факту большинство из них никогда не всплывает как
  `Effect.fail` — они лишь оседают в `RunSideResult.errorCode` при
  `successRank = 0` (прогон при этом валиден, фаза продолжается). Это касается
  и export-шага: `E_RUN_CRASH` (export ничего не вернул), `E_RUN_TIMEOUT`
  (export не уложился в таймаут) и `E_EXPORT_INVALID` (export невалиден после
  исчерпания retry) больше не прерывают фазу — один сломанный export не должен
  убивать все N×2 прогонов, включая уже завершённые и параллельно идущие на
  другой стороне. Фазу реально фейлит только:
  - `E_DISK_FULL` — запись `events.ndjson`, `ensureDir` рабочей директории или
    запись самого export-файла упёрлись в ENOSPC. Это машинно-глобальная
    проблема, а не свойство конкретного прогона.
  - `E_RUN_CRASH` из guard-а «нет рабочей директории приложения для этого
    `runIndex`» — это баг обвязки (фаза 02 не создала worktree), а не итог
    прогона, поэтому он остаётся жёстким fail.

`successRank` (0–4):
- `4` — finish-stop (нормальное завершение).
- `3` — finish-tool-calls → stop (закончил тул-колами, потом остановился).
- `2` — length-limit (context overflow, валидный результат).
- `1` — doom-loop (`maxConsecutiveSameTool` высокий, без финиша).
- `0` — crash / ошибка / таймаут / watchdog.

## 3. Шаги алгоритма

1. Запустить обе стороны параллельно через `Effect.zipPar`:

   ```
   runSideAll(side) = for runIndex in 1..runs (sequential): runSide({side, runIndex, ...})
   ```
   Стороны независимо, внутри стороны строго последовательно (чтобы не
   накладывать N×2 параллельных процессов на машину и сохранить
   детерминированность метрик).
2. Для одного прогона `runSide({side, runIndex, ...})`:
   a. `sessionId` приходит уже сгенерированным в `RunSideInput.sessionId`
      (формат `<runId>-<side>-<runIndex>-<rand6hex>`).
   b. Если `runInput.init` задан (непустая строка) **и** `runInput.initSide`
      включает эту сторону (`"both"`, либо совпадает с `side` — `"new"` только
      на `side = "new"`, `"old"` только на `side = "old"`): запустить
      `HOME=<env> opencode run --agent build --session <sessionId> --format json --auto "<init>"`
      с `homeEnv` (`EnvVarSet`) из `RunSideInput`. Стрим событий в
      `raw/<side>/run-<runIndex>.events.ndjson`. Таймаут —
      `timeouts.runSeconds`, watchdog — `timeouts.watchdogSeconds`. Если `init`
      задан, но `initSide` эту сторону не включает — `--init` целиком
      пропускается для этой стороны (в лог пишется `[INIT] skipped on
      side=<side> (--init-side <initSide>)`), и `--prompt` ниже стартует без
      `--continue` (свежая сессия). `initSide` существует именно для того,
      чтобы `--init`-текст, который на самом деле является ТРИГГЕРОМ пакета
      (например, slash-команда), не долетал до baseline-стороны и не портил
      `--pure-baseline` — см. `docs/phases/00-cli-parse.ru.md`.
   c. Запустить основной промпт:
      `HOME=<env> opencode run --agent build --continue --session <sessionId> --format json --auto "<prompt>"`.
      Если `--init` не было, `--continue` опускается. Все события дописываются
      в тот же `.events.ndjson`. Вокруг каждого из двух вызовов (`--init` в
      п. b, если он был, и `--prompt` здесь) обвязка меряет собственный
      wall-clock (`Date.now()` до/после) — это `initWallMs`/`promptWallMs` в
      `RunSideResult`, harness-сторона того же разбиения init/task, что фаза
      07 считает по самому экспорту (граница по 2-му user-сообщению).
   d. **Watchdog:** отдельная задача следит за `mtime` файла `.events.ndjson`.
      Если за `timeouts.watchdogSeconds` секунд не было новой строки → kill
      opencode-process, пометить `watchdogTriggered = true`, exit-причину →
      `E_RUN_HANG_WATCHDOG`.
   e. **Жёсткий таймаут:** если общее время превысило `timeouts.runSeconds` →
      kill, `E_RUN_TIMEOUT`. Если задан `timeouts.totalSeconds` и он
      исчерпан → `E_TOTAL_TIMEOUT`.
   f. По завершении процесса (normal / killed): выполнить
      `HOME=<env> opencode export <sessionId>` → записать в
      `raw/<side>/run-<runIndex>.json`, прочитать и провалидировать по схеме
      `OpencodeExport`. Сразу после завершения прогона сессия иногда ещё
      дописывается на диск, и export может вернуть усечённый/невалидный
      JSON — если провал именно на этом шаге (схема не сошлась), делается
      **ограниченный retry** свежего `opencode export` с экспоненциальным
      backoff (до 3 попыток, старт 200ms, потолок ожидания 3s). Если сам
      `opencode export` падает как процесс (ошибка запуска) или не
      укладывается в таймаут — retry **не** делается. В любом из трёх
      исходов (`E_RUN_CRASH` / `E_RUN_TIMEOUT` / `E_EXPORT_INVALID` после
      исчерпания retry) фаза **не падает**: прогон принудительно понижается до
      `successRank = 0` с этим `errorCode`, `--verify` для него пропускается
      (rank всё равно будет обнулён), `export.json` на диске может отсутствовать
      или быть невалидным — фаза 07 уже умеет заводить такой прогон в
      `FailedRun`, фаза 10 читает его как пустой список events. Настоящий
      `ENOSPC` при записи самого export-файла — исключение, он всё ещё валит
      фазу с `E_DISK_FULL` (см. таблицу выше).
   g. Определить `finishCause` из последнего `step-finish` event-а:
      `stop` / `tool-calls` / `length` / `error`. Определить `successRank` по
      правилам выше. Итоговый `exitCode` в `RunSideResult` — «combined»: если
      хотя бы один из вызовов opencode (`--init`, если был, и `--prompt`)
      завершился с ненулевым кодом, берётся код **первого** такого вызова;
      если оба завершились нулём — код последнего вызова (`--prompt`, либо
      `--init`, если `--prompt` почему-то не выполнялся). Non-zero exit
      opencode → `E_RUN_CRASH` + `successRank = 0` (НЕ retry).
   h. Rate-limit: сканируется не весь стрим целиком, а только два вида полей
      на событии — текст assistant text-part и `output` **упавшего**
      tool-call (`state.status === "error"`); всё остальное (callID,
      sessionId, счётчики токенов, содержимое **успешно** прочитанного
      файла) никогда не сканируется, чтобы случайное «429» в полезной
      нагрузке не считалось сигналом лимита. Совпадение с
      `429`/`rate limit`/`rate_limit`/`too many requests` в этих полях →
      `E_RATE_LIMIT_EXHAUSTED`, `successRank = 0`. НЕ retry на уровне
      оркестратора.
   i. Process killed by OOM (статус/сигнал показывает out-of-memory) →
      `E_OOM`, `successRank = 0`.
   j. Context-overflow (`finishCause = "length"`) — **валидный** результат,
      `successRank = 2`, НЕ retry.
   k. `ENOSPC` при записи → `E_DISK_FULL`. Сетевой конфликт порта от
      plugin/mcp → `E_PORT_CONFLICT`.
   l. Если `manifest.verify !== null`:
      - запустить `cd apps/<side>Version/run-<runIndex>/ && <verify>` с
        таймаутом `timeouts.verifySeconds`.
      - exit ≠ 0 → `verifyExitCode = code`, **понижаем** `successRank` на 1
        (min 0); `E_VERIFY_FAILED` — НЕ фатально для прогона, но фиксируется в
        результате.
      - таймаут → `E_VERIFY_TIMEOUT`, `verifyExitCode` не задаётся,
        `successRank = 0` (verify-таймаут считаем провалом прогона).
3. Собрать `RunSideResult` для прогона. Записать его как есть (включая
   локальное расширение `errorCode`, если оно задано) в
   `raw/<side>/run-<n>.result.json` — best-effort (сбой записи логируется в
   `run-<n>.log` и не фейлит прогон): это единственный на диске снимок
   *результата* прогона (rank, finishCause, exitCode, errorCode…), который
   иначе существует только в памяти оркестратора и как plain-text `[STOP]`
   строка в логе — нужен для post-mortem и будущего `report --rebuild`.
   Вернуть `RunSideResult`.

## 4. Входные/выходные файлы

| Файл                                    | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------------- | ------------- | -------------------- |
| `raw/<side>/run-<n>.events.ndjson`      | Запись        | поток JSONL событий  |
| `raw/<side>/run-<n>.json`               | Запись        | `OpencodeExport`     |
| `raw/<side>/run-<n>.result.json`        | Запись (best-effort) | `RunSideResult` (+ локальный `errorCode`) |
| `apps/<side>Version/run-<n>/`           | Чтение+Запись | рабочее дерево агента |
| `config/.config/opencode/<side>/opencode.json`  | Запись | строка `OPENCODE_CONFIG_CONTENT` + `\n` |
| `config/.config/opencode/<side>/installed.json` | Запись | внутренний JSON (не в контракте) |
| `config/.config/opencode/<side>/usage.json`     | Запись | внутренний JSON (не в контракте) |
| `config/.config/opencode/<side>/home/*`         | Запись | байт-копии из `home/<side>/run-1/.config/opencode/` |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                         | Код                        |
| --------------------------------------------------- | ------------------------------------------------- | -------------------------- |
| Жёсткий таймаут `timeouts.runSeconds` исчерпан      | kill, `successRank = 0`, прогон failed            | `E_RUN_TIMEOUT`            |
| `timeouts.totalSeconds` (если задан) исчерпан       | kill, `successRank = 0`, failed                   | `E_TOTAL_TIMEOUT`          |
| Watchdog: нет событий `timeouts.watchdogSeconds`    | kill, `successRank = 0`, failed                   | `E_RUN_HANG_WATCHDOG`      |
| opencode non-zero exit (не length)                  | `successRank = 0`, НЕ retry                       | `E_RUN_CRASH`              |
| Context overflow (finish = length)                  | **валидный**, `successRank = 2`, не retry         | —                          |
| HTTP 429 серией, retry исчерпан                     | `successRank = 0`, не retry                       | `E_RATE_LIMIT_EXHAUSTED`   |
| Doom-loop (один tool × N без прогресса)             | `successRank = 1`, валидный результат             | —                          |
| `--verify` exit ≠ 0                                 | понижение `successRank`, не фатально              | `E_VERIFY_FAILED`          |
| `--verify` таймаут                                  | `successRank = 0`, failed                         | `E_VERIFY_TIMEOUT`         |
| `--init` без `--prompt` (невозможно, клирится в 00) | ошибка контракта                                  | — (через 00)               |
| `--init` задан, но `runInput.initSide` не включает эту сторону | `--init` пропущен для этой стороны, `[INIT] skipped` в логе, `--prompt` без `--continue` | — |
| `opencode export` вернул невалидный по схеме JSON (первые попытки) | ограниченный retry с backoff (до 3 раз) | —              |
| `opencode export` невалиден и после исчерпания retry | фаза ОК, `successRank = 0`, `--verify` пропущен, данные в `.events.ndjson` живут | `E_EXPORT_INVALID` |
| `opencode export` падает как процесс / таймаут       | retry не делается; фаза ОК, `successRank = 0`, `--verify` пропущен | `E_RUN_CRASH` / `E_RUN_TIMEOUT` |
| «429» встретился в успешном выводе tool (не в тексте/ошибке) | НЕ засчитывается как rate-limit           | —                          |
| `--init` упал (non-zero), `--prompt` после него завершился нулём | итоговый `exitCode` = код `--init` (первый non-zero) | `E_RUN_CRASH` |
| Процесс убит по OOM                                 | `successRank = 0`                                 | `E_OOM`                    |
| `ENOSPC` при записи логов/export                    | `successRank = 0`, failed                         | `E_DISK_FULL`              |
| Plugin/mcp пытается занять занятый порт             | `successRank = 0`, failed                         | `E_PORT_CONFLICT`          |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path stop: агент отработал, `finishCause = "stop"` → `successRank = 4`,
  `raw/<side>/run-N.json` валиден.
- ✅ tool-calls finish: `finishCause = "tool-calls"` затем `stop` → `successRank = 3`.
- ✅ length-limit: context overflow → `successRank = 2`, прогон валиден.
- ✅ doom-loop: один tool × 20 без финиша → `successRank = 1`.
- ✅ crash: opencode упал exit 1 → `successRank = 0`, `E_RUN_CRASH`.
- ✅ timeout: процесс длится > `timeouts.runSeconds` → kill, `E_RUN_TIMEOUT`,
  `successRank = 0`.
- ✅ total-timeout: `timeouts.totalSeconds` исчерпан → kill, `E_TOTAL_TIMEOUT`.
- ✅ watchdog: `timeouts.watchdogSeconds` без событий → kill,
  `E_RUN_HANG_WATCHDOG`.
- ✅ rate-limit exhausted: 429 в assistant-тексте или в выводе упавшего tool
  → `E_RATE_LIMIT_EXHAUSTED`, `successRank = 0`.
- ✅ rate-limit false-positive guard: «429» в выводе **успешного** tool-call
  (например, содержимое прочитанного файла) → НЕ засчитывается.
- ✅ OOM kill: процесс убит ядром по OOM → `E_OOM`, `successRank = 0`.
- ✅ disk full: `ENOSPC` при записи лога → `E_DISK_FULL`.
- ✅ port conflict: plugin требует занятый порт → `E_PORT_CONFLICT`.
- ✅ export invalid, retry exhausted: `opencode export` возвращает невалидный
  JSON на всех попытках → retry с backoff исчерпан → фаза ОК, `successRank = 0`,
  `errorCode = E_EXPORT_INVALID`, невалидный файл остаётся на диске.
- ✅ export invalid, retry recovers: первая попытка невалидна, повторная —
  валидна → прогон не падает, export принят со второй попытки.
- ✅ export produced no data: сам `opencode export` падает как процесс →
  фаза ОК, `successRank = 0`, `errorCode = E_RUN_CRASH`, без retry,
  `events.ndjson` записан, `--verify` пропущен.
- ✅ export timeout: `opencode export` не укладывается в таймаут → фаза ОК,
  `successRank = 0`, `errorCode = E_RUN_TIMEOUT`.
- ✅ events.ndjson write failure (ENOSPC): фаза всё ещё падает с
  `E_DISK_FULL` — это машинно-глобальная проблема, не свойство прогона.
- ✅ combined exit code: `--init` падает (non-zero), `--prompt` после него
  завершается нулём → `RunSideResult.exitCode` = код `--init`.
- ✅ `--init` then `--prompt`: два вызова opencode с одним `--session`,
  `--continue` на втором.
- ✅ `initSide = "both"` (default): `--init` выполняется на обеих сторонах.
- ✅ `initSide = "new"`: на `side = "old"` `--init` пропущен (`run` вызван один
  раз, без `--continue`), лог содержит `[INIT] skipped on side=old
  (--init-side new)`; на `side = "new"` `--init` выполняется как обычно.
- ✅ `initSide = "old"`: зеркально — пропущен на `side = "new"`, выполняется на
  `side = "old"`.
- ✅ `--verify` ok: verify exit 0 → `successRank` без изменений.
- ✅ `--verify` fail: verify exit 2 → `successRank` понижен, `RunSideResult`
  содержит `verifyExitCode = 2`.
- ✅ `--verify` timeout: verify > `timeouts.verifySeconds` → `E_VERIFY_TIMEOUT`,
  `successRank = 0`.
- ✅ 2-way parallelism: old и new стартуют одновременно (проверка по timestamp
  запуска), внутри стороны N прогонов идут последовательно.
- ✅ run-N.result.json: пишется после прогона, парсится по `RunSideResult`
  (плюс локальный `errorCode`), совпадает с возвращённым результатом.
- ✅ run-N.result.json write failure: сбой записи (fs) не фейлит прогон.
- ❌ НЕ покрыто (ticket): повторяемая инвалидация export при несовместимой
  версии opencode (отдельный ticket по версионированию).

## 7. Инварианты

- Для каждой пары `(side, n)` фаза всегда возвращает `RunSideResult`; если
  export провалился (`E_RUN_CRASH` / `E_RUN_TIMEOUT` / `E_EXPORT_INVALID`),
  `raw/<side>/run-N.json` на диске может отсутствовать или быть невалидным —
  это не мешает фазе продолжить остальные прогоны и стороны.
- `successRank ∈ {0,1,2,3,4}` определён для **каждого** прогона (даже failed
  получает 0).
- Стороны old и new стартуют в пределах ≤ 1s друг от друга (параллельный старт
  через `zipPar`); прогоны внутри стороны строго последовательны.
- `--init` и `--prompt` выполняются в одной opencode-сессии (`--continue`) на
  стороне, для которой `runInput.initSide` включает `--init`; на другой
  стороне (когда `initSide` её не включает) `--prompt` стартует свежую сессию.
- `runInput.initSide` определяет это ЗА КАЖДУЮ сторону независимо — `both`
  затрагивает обе, `new`/`old` — ровно одну (см. `docs/phases/00-cli-parse.ru.md`).
- Watchdog и жёсткий таймаут взаимоисключающи по эффекту, но оба могут
  сработать: watchdog срабатывает раньше и помечает причину как hang.

## 8. Зависимости от других фаз

- Зависит от: **02 repo-clone** (рабочие деревья, в которых работает агент),
  **04 home-isolation** (`EnvVarSet` (`homeEnv`) и HOME-структура), **05
  preflight** (ok-preflight обязателен, если `runInput.preflightEnabled`).
- Блокирует: **07 aggregate** (читает `raw/<side>/run-N.json`),
  **08 diff** (git diff в рабочих деревьях после прогона),
  **10 timeline** (читает `raw/<side>/run-N.json`).
- Параллелизуется с: сама с собой по оси `side` (`old ‖ new`).

## 9. Снимок конфигурации opencode

После того как обе стороны отработали N×2 прогонов, `src/phases/06-config-capture.ts`
(соседний helper фазы 06, не отдельная нумерованная фаза — как `08-diff-css.ts` при
`08-diff.ts`) сохраняет в `config/.config/opencode/<side>/` картину того, какой конфиг и
какие зависимости реально использовала каждая сторона:

- `opencode.json` — точное содержимое `OPENCODE_CONFIG_CONTENT`, полученное этой стороной
  (последний и приоритетный слой merge opencode; сам opencode никогда не материализует
  единый эффективный конфиг, поэтому testaipack его не синтезирует, а сохраняет слои
  рядом).
- `home/` — байт-копии `opencode.jsonc`, `opencode.json`, `package.json`,
  `package-lock.json` из `home/<side>/run-1/.config/opencode/` (каждый — только если
  существует). `node_modules/` не копируется никогда (размер; `package-lock.json`
  фиксирует дерево целиком).
- `installed.json` — что реально установлено: skills (имя + цель symlink-а), agents,
  commands, plugin-файлы и plugin-config-спеки, имена mcp-серверов, npm-зависимости
  (`package.json`), `configMergeOrder` (порядок слоёв merge — `home/opencode.json` →
  `home/opencode.jsonc` → `opencode.json`, последний побеждает), и
  `identicalAcrossRuns`/`driftFiles` — сверка отслеживаемых файлов run-1 с run-2..run-N.
- `usage.json` — что реально вызывалось, по данным `results/raw/<side>/run-N.events.ndjson`:
  счётчики `toolCalls` по именам инструментов и список вызовов `skill`
  (`run`, `name`, `status`, `error`). Использование skill (и, ожидаемо, mcp) видно в
  событиях; использование plugin-хуков и npm-пакетов **не наблюдаемо** — это явно
  перечислено в `notKnowable`, а не домысливается.

Захват идёт **один раз на сторону**, из `run-1` (отслеживаемые файлы одной стороны у всех
прогонов байт-в-байт идентичны — гарантия фазы 04, но `driftFiles` всё равно её
перепроверяет, а не предполагает вслепую). Захват — best-effort: ошибка не валит уже
завершённый прогон, а пишет предупреждение в лог оркестратора (`src/cli/pipeline.ts`).
Выполняется после прогонов (внутри фазы 06) и до `--ephemeral`-очистки (фаза 13, которая
иначе удалила бы единственную копию этой картины вместе с `home/`).
