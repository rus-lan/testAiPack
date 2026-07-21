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
  watchdogTriggered: boolean }`. Все поля обязательные, кроме
  `verifyExitCode` (появляется только если задан `verify`).
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
  - `E_RATE_LIMIT_EXHAUSTED` — в стриме присутствует устойчивый HTTP 429,
    который opencode уже не может ретраить.
  - `E_OOM` — процесс убит ядром по OOM (сигнал/статус показывает out-of-memory).
  - `E_DISK_FULL` — `ENOSPC` при записи логов/export.
  - `E_PORT_CONFLICT` — opencode пытается занятый порт (для plugin/mcp с
    сетевыми зависимостями).
  - `E_EXPORT_INVALID` — `opencode export` упал или не валиден по схеме
    `OpencodeExport`.
  - `E_TOTAL_TIMEOUT` — исчерпан `runInput.timeouts.totalSeconds` (если задан)
    для всего run-N.

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
   b. Если `manifest.init !== null`: запустить
      `HOME=<env> opencode run --agent build --session <sessionId> --format json --auto "<init>"`
      с `homeEnv` (`EnvVarSet`) из `RunSideInput`. Стрим событий в
      `raw/<side>/run-<runIndex>.events.ndjson`. Таймаут —
      `timeouts.runSeconds`, watchdog — `timeouts.watchdogSeconds`.
   c. Запустить основной промпт:
      `HOME=<env> opencode run --agent build --continue --session <sessionId> --format json --auto "<prompt>"`.
      Если `--init` не было, `--continue` опускается. Все события дописываются
      в тот же `.events.ndjson`.
   d. **Watchdog:** отдельная задача следит за `mtime` файла `.events.ndjson`.
      Если за `timeouts.watchdogSeconds` секунд не было новой строки → kill
      opencode-process, пометить `watchdogTriggered = true`, exit-причину →
      `E_RUN_HANG_WATCHDOG`.
   e. **Жёсткий таймаут:** если общее время превысило `timeouts.runSeconds` →
      kill, `E_RUN_TIMEOUT`. Если задан `timeouts.totalSeconds` и он
      исчерпан → `E_TOTAL_TIMEOUT`.
   f. По завершении процесса (normal / killed): выполнить
      `HOME=<env> opencode export <sessionId>` → записать в
      `raw/<side>/run-<runIndex>.json`. Если export падает или не валиден по
      схеме `OpencodeExport` → код `E_EXPORT_INVALID` (см. фазу 07).
   g. Определить `finishCause` из последнего `step-finish` event-а:
      `stop` / `tool-calls` / `length` / `error`. Определить `successRank` по
      правилам выше. Non-zero exit opencode → `E_RUN_CRASH` + `successRank = 0`
      (НЕ retry).
   h. Rate-limit: если в стриме видим серию HTTP 429 и opencode уже не может
      ретраить → `E_RATE_LIMIT_EXHAUSTED`, `successRank = 0`. НЕ retry на
      уровне оркестратора.
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
3. Собрать `RunSideResult` для прогона и вернуть.

## 4. Входные/выходные файлы

| Файл                                    | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------------- | ------------- | -------------------- |
| `raw/<side>/run-<n>.events.ndjson`      | Запись        | поток JSONL событий  |
| `raw/<side>/run-<n>.json`               | Запись        | `OpencodeExport`     |
| `apps/<side>Version/run-<n>/`           | Чтение+Запись | рабочее дерево агента |

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
| `opencode export` упал                              | прогон failed, но данные в `.events.ndjson` живут | `E_EXPORT_INVALID`         |
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
- ✅ rate-limit exhausted: серия 429 → `E_RATE_LIMIT_EXHAUSTED`,
  `successRank = 0`.
- ✅ OOM kill: процесс убит ядром по OOM → `E_OOM`, `successRank = 0`.
- ✅ disk full: `ENOSPC` при записи лога → `E_DISK_FULL`.
- ✅ port conflict: plugin требует занятый порт → `E_PORT_CONFLICT`.
- ✅ export invalid: `opencode export` упал/невалиден → `E_EXPORT_INVALID`.
- ✅ `--init` then `--prompt`: два вызова opencode с одним `--session`,
  `--continue` на втором.
- ✅ `--verify` ok: verify exit 0 → `successRank` без изменений.
- ✅ `--verify` fail: verify exit 2 → `successRank` понижен, `RunSideResult`
  содержит `verifyExitCode = 2`.
- ✅ `--verify` timeout: verify > `timeouts.verifySeconds` → `E_VERIFY_TIMEOUT`,
  `successRank = 0`.
- ✅ 2-way parallelism: old и new стартуют одновременно (проверка по timestamp
  запуска), внутри стороны N прогонов идут последовательно.
- ❌ НЕ покрыто (ticket): повторяемая инвалидация export при несовместимой
  версии opencode (отдельный ticket по версионированию).

## 7. Инварианты

- Для каждой пары `(side, n)` существует либо валидный `raw/<side>/run-N.json`
  (по схеме `OpencodeExport`), либо `RunSideResult` с кодом `E_*` — но не
  оба и не ни одного.
- `successRank ∈ {0,1,2,3,4}` определён для **каждого** прогона (даже failed
  получает 0).
- Стороны old и new стартуют в пределах ≤ 1s друг от друга (параллельный старт
  через `zipPar`); прогоны внутри стороны строго последовательны.
- `--init` и `--prompt` (если оба заданы) выполняются в одной opencode-сессии
  (`--continue`).
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
