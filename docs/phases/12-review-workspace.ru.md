# Фаза 12: review-workspace

> Спека фазы. Контракт = `contract/phases/12-review-workspace.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Сгенерировать `review.code-workspace` — VSCode multi-root workspace, который
одним кликом открывает OLD, NEW и PACK рядом, чтобы пользователь мог глазами
просмотреть разницу. Параметризуется через `--review-run N` и `--ide`.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.ReviewWorkspace` (см.
`contract/phases/12-review-workspace.tsp`).

- Вход: `ReviewWorkspaceInput` — `{ runInput: RunInput, manifest: Manifest,
  workspace: WorkspaceTree }`. Параметры `--review-run` и `--ide` (если
  заданы) живут в `runInput.flagDefaults` или передаются через CLI напрямую —
  они не являются контрактными полями Input.
- Выход: `ReviewWorkspaceResult` — `{ workspacePath: string, opened: boolean,
  command: string }`:
  - `workspacePath` — абсолютный путь к `review.code-workspace`.
  - `opened` — `true` если редактор был успешно запущен; `false` по умолчанию
    (фаза только генерирует файл и печатает инструкцию, не запускает IDE).
  - `command` — готовая команда запуска редактора (например `code
    <workspacePath>`), печатается в stdout как инструкция.
- Ошибки: фаза **не имеет error-модели** — она принципиально не падает. Даже
  если VSCode не запускается, файл `review.code-workspace` существует, и фаза
  возвращает `ReviewWorkspaceResult` с `opened: false`. Любые инфраструктурные
  сбои логируются, но не фейлят прогон (см. комментарий в
  `contract/phases/12-review-workspace.tsp`).

Структура `review.code-workspace`:
```jsonc
{
  "folders": [
    { "path": "apps/oldVersion/run-1", "name": "OLD (baseline)" },
    { "path": "apps/newVersion/run-1", "name": "NEW (with pack)" },
    { "path": "pack", "name": "PACK source (read-only)" }
  ],
  "settings": {
    "workbench.colorCustomizations": {
      "titleBar.activeForeground": "#000",
      "titleBar.inactiveForeground": "#444"
    }
  }
}
```

## 3. Шаги алгоритма

1. Прочитать `reviewRun` (default 1) и `ide` (default `"vscode"`) из CLI /
   `flagDefaults` (не из контрактного Input). Валидировать
   `1 ≤ reviewRun ≤ manifest.runs`. Невалидное значение → warning, fallback на
   `reviewRun = 1` (фаза не имеет error-модели и не падает).
2. Вычислить относительные пути (относительно `workspaceRoot`):
   - `apps/oldVersion/run-<reviewRun>`
   - `apps/newVersion/run-<reviewRun>`
   - `pack` (для smoke-test режима pack-папка пустая, но всё равно включаем —
     так пользователь видит, что pack-а не было).
3. Собрать объект workspace по шаблону выше (PascalCase-поля VSCode, stable
   key order).
4. Сериализовать в `<workspaceRoot>/review.code-workspace` (pretty JSON). Сбой
   записи → warning в лог; фаза не падает (нет error-модели). В крайнем случае
   `workspacePath` указывает на путь, который не существует — это видно
   пользователю.
5. Сформировать `command` по `ide`:
   - `vscode` → `code <workspacePath>`
   - `cursor` → `cursor <workspacePath>`
   - `code-insiders` → `code-insiders <workspacePath>`
6. Не запускать команду автоматически (только напечатать в stdout как
   инструкцию) — открытие редактора не входит в scope фазы. `opened = false`.
   Если будущая опция `--open` явно запросит запуск, и он удался →
   `opened = true`.
7. Вернуть `ReviewWorkspaceResult { workspacePath, opened, command }`.

## 4. Входные/выходные файлы

| Файл                              | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------- | ------------- | -------------------- |
| `review.code-workspace`           | Запись        | VSCode workspace JSON |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                       | Код                  |
| --------------------------------------------------- | ----------------------------------------------- | -------------------- |
| `--review-run 5` при `runs = 3`                     | warning + fallback на `reviewRun = 1`           | — (фаза не падает)   |
| `--review-run 0`                                    | warning + fallback на `reviewRun = 1`           | — (фаза не падает)   |
| smoke-test режим (`packRef` отсутствует)            | workspace всё равно содержит `pack/` (пустую)   | —                    |
| `--ide cursor`                                      | `command` = `cursor <path>`                     | —                    |
| `--ide code-insiders`                               | `command` = `code-insiders <path>`              | —                    |
| Невозможно записать workspace (ROFS)                | warning в лог, `workspacePath` указывает на     | — (фаза не падает)   |
|                                                     | несуществующий файл, `opened = false`           |                      |
| Повторный запуск с тем же runId                     | перезаписываем `review.code-workspace`          | —                    |
| `apps/<side>Version/run-N` не существует (фаза 02   | пишем workspace с указанным путём; VSCode       | —                    |
| упала)                                              | покажет папку как missing — не наша проблема    |                      |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: `--review-run 1`, `--ide vscode` → `review.code-workspace`
  содержит 3 папки с правильными относительными путями; `command` =
  `code <workspacePath>`, `opened = false`.
- ✅ review-run param: `--review-run 2` → пути `run-2` в обоих сторонах.
- ✅ cursor ide: `--ide cursor` → `command` = `cursor <path>`.
- ✅ code-insiders ide: `--ide code-insiders` → `command` =
  `code-insiders <path>`.
- ✅ smoke-test: `packRef` отсутствует → workspace всё равно содержит `pack/`.
- ✅ invalid review-run: `--review-run 5`, `runs = 3` → warning, fallback на
  `reviewRun = 1`, фаза не падает.
- ✅ invalid review-run zero: `--review-run 0` → warning, fallback на 1, фаза
  не падает.
- ✅ write failure: ROFS → warning в логе, `workspacePath` указывает на
  отсутствующий файл, `opened = false`, фаза не падает.
- ✅ idempotent: повторный запуск перезаписывает workspace.
- ❌ НЕ покрыто (ticket): автооткрытие workspace после генерации (ticket про
  флаг `--open`, который выставил бы `opened = true`).

## 7. Инварианты

- Фаза **никогда не падает** (нет error-модели в контракте): даже при ROI / 
  невалидном `reviewRun` она возвращает `ReviewWorkspaceResult`.
- В успехе `review.code-workspace` существует и валиден как JSON VSCode
  workspace.
- Пути в `folders` **относительные** (от `workspaceRoot`), так что workspace
  переносим вместе с каталогом прогона.
- `folders` всегда содержит ровно 3 записи: OLD, NEW, PACK (порядок фиксирован).
- `command` печатается в stdout как инструкция, **не** выполняется; `opened`
  отражает факт успешного запуска (обычно `false`).
- `reviewRun` ≤ `manifest.runs` (после fallback).

## 8. Зависимости от других фаз

- Зависит от: **01 workspace-setup** (`Manifest`, `WorkspaceTree`), **02
  repo-clone** (папки `apps/<side>Version/run-N`), **03 pack-install`
  (`pack/`), **00 cli-parse** (`reviewRun`, `ide` через `flagDefaults`).
- Блокирует: — (последняя «полезная» фаза перед cleanup; ничего downstream,
  кроме опциональной cleanup).
- Параллелизуется с: **11 report-render** (обе фазы читают готовые артефакты
  фаз 02–10, не имеют data-dependency между собой; на практике запускаются
  последовательно для удобства логов).
