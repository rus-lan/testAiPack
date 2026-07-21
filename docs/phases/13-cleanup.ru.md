# Фаза 13: cleanup (опциональная)

> Спека фазы. Контракт = `contract/phases/13-cleanup.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

По умолчанию **ничего не удаляет** (workspace retention включён). Управляется
двумя режимами: `--ephemeral` (в рамках `run`) и субкоманда `gc` (отдельная,
работает по всем прогонам). Все операции очистки логируются в
`results/gc.log`.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.Cleanup` (см. `contract/phases/13-cleanup.tsp`).

- Вход: `CleanupInput` — `{ runInput: RunInput, manifest: Manifest, workspace:
  WorkspaceTree, ephemeral: boolean }`. Один булев флаг `ephemeral` управляет
  поведением: `true` → удалить временные каталоги прогона (`apps/`, `home/`,
  `pack/`); `false` → no-op. Субкоманда `testaipack gc` (полная уборка по всем
  прогонам с политиками `--keep-last` / `--older-than` / `--aggressive`)
  существует вне pipeline и не описывается этим контрактом.
- Выход: `CleanupResult` — `{ deleted: string[], kept: string[], gcLogPath:
  string }`:
  - `deleted` — массив путей, удалённых в этом запуске (например `apps/`,
    `home/`, `pack/` при `ephemeral = true`).
  - `kept` — массив путей, оставленных намеренно (`config/`, `results/`).
  - `gcLogPath` — путь к `results/gc.log`.
- Ошибки: фаза **не имеет error-модели** — soft phase по контракту: ошибки
  удаления логируются в `gc.log`, но **никогда не фейлят прогон** (см.
  комментарий в `contract/phases/13-cleanup.tsp`). Сбой удаления на ROFS /
  отсутствие прав фиксируется в `gcLogPath` warning-ом, фаза возвращает
  `CleanupResult` с тем, что удалось удалить.

## 3. Шаги алгоритма

**Режим `ephemeral` (в рамках `run`):**

1. Если `CleanupInput.ephemeral === false` → no-op: пишем в `results/gc.log`
   строку `"cleanup skipped (retention on)"`, возвращаем `CleanupResult` с
   пустыми `deleted`, `kept` — базовым списком сохранённых каталогов
   (`config/`, `results/`), `gcLogPath` = путь к логу.
2. Если `ephemeral === true` → удаляем `apps/`, `home/`, `pack/` целиком
   (рекурсивно). Каждый удалённый путь добавляем в `deleted`.
3. Оставляем `config/`, `results/` (включая все артефакты — metrics, diff,
   judge, timeline, report, review.code-workspace, install.log, preflight.log).
   Эти пути попадают в `kept`.
4. Логируем каждое удаление в `results/gc.log` (путь + размер).
5. Сбой удаления (ROFS, нет прав) — warning в `gc.log`, фаза **не падает**;
   неудалённый путь попадает в `kept` с пометкой.

**Субкоманда `testaipack gc` (вне фазового контракта):**

`gc` — отдельная CLI-субкоманда, работающая по всем прогонам в
`.testaipack/`. Она не описывается `CleanupInput`/`CleanupResult` — у неё
свой парсинг опций и своя структура результата. Здесь упрощённо:

1. Валидация опций: одновременно `--keep-last` и `--older-than` нельзя →
   warning + отказ (субкоманда не падает с error-моделью фазы, просто пишет
   диагностику и выходит).
2. Формат `--older-than` — `<N><unit>`, где unit ∈ `s|m|h|d` (например `7d`,
   `12h`, `30m`). Невалидный → warning + отказ.
3. Собрать список всех прогонов в `.testaipack/` (по подкаталогам, парсинг
   `manifest.json` каждого для timestamp).
4. Применить политику:
   - `--keep-last N`: отсортировать по timestamp убыванию, оставить первые N,
     остальные пометить на полное удаление.
   - `--older-than 7d`: пометить на полное удаление все прогоны, у которых
     `timestamp < now − 7d`.
5. Для **полного удаления** — убрать весь `<runId>/` каталог целиком.
6. Если `--aggressive` (без полного удаления, или дополнительно к нему) —
   во **всех оставшихся** прогонах удалить `home/` (`apps/` и `results/`
   остаются). Это экономит место, сохраняя возможность открыть review workspace
   и посмотреть diff.
7. Логировать все операции в `.testaipack/gc.log` (общий для всех прогонов).
8. Сбой удаления → warning в логе, субкоманда продолжается (идемпотентна —
   повторный запуск добьёт остатки).

## 4. Входные/выходные файлы

| Файл / каталог                          | Чтение/Запись   | Схема (TypeSpec/Zod) |
| --------------------------------------- | --------------- | -------------------- |
| `.testaipack/<runId>/manifest.json`     | Чтение (gc)     | `Manifest`           |
| `.testaipack/<runId>/apps/`             | Удаление (opt)  | —                    |
| `.testaipack/<runId>/home/`             | Удаление (opt)  | —                    |
| `.testaipack/<runId>/pack/`             | Удаление (eph)  | —                    |
| `.testaipack/<runId>/` целиком          | Удаление (gc)   | —                    |
| `.testaipack/gc.log`                    | Дополнение (gc) | текст                |
| `results/gc.log`                        | Дополнение      | текст                |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                          | Код                  |
| --------------------------------------------------- | -------------------------------------------------- | -------------------- |
| `run` без `--ephemeral` (`ephemeral = false`)       | no-op, retention on                                | —                    |
| `--ephemeral` + `--aggressive` (невозможно в run)   | `--aggressive` только в gc                         | —                    |
| `gc --keep-last 5 --older-than 7d`                  | warning, отказ — конфликт опций                    | —                    |
| `gc --older-than xyz` (невалидный формат)           | warning, отказ                                     | —                    |
| `gc --keep-last 100` при 10 прогонах                | ничего не удаляется                                | —                    |
| `gc --older-than 365d` при свежих прогонах           | ничего не удаётся                                  | —                    |
| `gc --aggressive` без других опций                  | во всех прогонах удаляется только `home/`          | —                    |
| ROFS / нет прав                                     | warning в `gc.log`, фаза не падает                 | —                    |
| `manifest.json` повреждён у какого-то прогона        | warning, прогон пропускается (не участвует в keep) | —                    |
| Удаление прервано на середине                        | gc идемпотентен, повторный запуск добьёт           | —                    |

> Все ошибки в cleanup — soft: они логируются в `gc.log`, но **не** пробрасывают
> error-модель фазы (контракт 13 намеренно не имеет `CleanupError`).

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ ephemeral on: `ephemeral = true` → `apps/`, `home/`, `pack/` удалены
  (`CleanupResult.deleted` содержит все три), `config/` и `results/`
  сохранены (`kept`), `gcLogPath` описывает удалённое.
- ✅ ephemeral off (default): `ephemeral = false` → `CleanupResult.deleted`
  пуст, `gcLogPath` содержит `"cleanup skipped (retention on)"`.
- ✅ gc keep-last: 5 прогонов, `gc --keep-last 2` → удалены 3 старейших,
  оставлены 2 свежих.
- ✅ gc keep-last > runs: 5 прогонов, `gc --keep-last 100` → ничего не удалено.
- ✅ gc older-than: 5 прогонов, один старше 7d, `gc --older-than 7d` → удалён
  только он.
- ✅ gc older-than invalid format: `gc --older-than xyz` → warning, отказ, не
  падает.
- ✅ gc conflicting options: `gc --keep-last 5 --older-than 7d` → warning,
  отказ, не падает.
- ✅ gc aggressive: `gc --aggressive` → во всех прогонах удалена только
  `home/`, `apps/` и `results/` сохранены.
- ✅ gc aggressive + keep-last: оставить 2 свежих, в остальных удалить `home/`.
- ✅ ROFS failure: warning в `gc.log`, фаза не падает, неудалённые пути в
  `kept`.
- ✅ corrupted manifest: у одного прогона битый `manifest.json` → warning,
  прогон пропущен, gc продолжается.
- ✅ idempotent gc: повторный `gc` после частично прерванного добивает остатки.
- ❌ НЕ покрыто (ticket): docker-volume cleanup (v0.3 docker isolation).
- ❌ НЕ покрыто (ticket): scheduler-based auto-gc (cron-like) — ticket про
  v0.2.

## 7. Инварианты

- Фаза **никогда не падает** (нет error-модели в контракте) — даже при ROI /
  частичном сбое удаления она возвращает `CleanupResult`.
- По умолчанию (`ephemeral = false`) **все** артефакты сохраняются — workspace
  retention включён.
- `ephemeral = true` сохраняет **всегда** `config/` и `results/` (включая
  отчёты, timeline, diff, judge, install.log, preflight.log,
  review.code-workspace).
- `gc` без `--aggressive` удаляет прогоны **целиком** или не трогает их вовсе.
- `gc --aggressive` в оставшихся прогонах удаляет **только** `home/`, оставляя
  `apps/` (для review workspace) и `results/`.
- `gcLogPath` указывает на `results/gc.log` (а в режиме субкоманды gc — также
  на `.testaipack/gc.log` с аудитным следом всех прогонов).
- gc идемпотентен: повторный запуск с теми же опциями не делает ничего сверх
  того, что уже сделано.

## 8. Зависимости от других фаз

- Зависит от: **01 workspace-setup** (`Manifest`, `WorkspaceTree` для
  ephemeral), **11 report-render** и **12 review-workspace** (должны
  завершиться до cleanup — иначе удалим то, что нужно для отчёта). Для
  субкоманды `gc` зависит только от структуры `.testaipack/` (читает
  `manifest.json` прогонов).
- Блокирует: — (терминальная фаза pipeline; в режиме `gc` работает вне
  pipeline как отдельная субкоманда).
- Параллелизуется с: — (запускается строго последней; `gc` вне pipeline).
