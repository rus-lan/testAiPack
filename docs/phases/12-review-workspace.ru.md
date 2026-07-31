# Фаза 12: review-workspace

> Спека фазы. Контракт = `contract/phases/12-review-workspace.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Сгенерировать `review.code-workspace` — VSCode multi-root workspace, который
одним кликом открывает **каждый вариант** эксперимента рядом друг с другом,
плюс по одной read-only папке на **каждый пак реестра**. Параметризуется
через `--review-run N` и `--ide`.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.ReviewWorkspace` (см.
`contract/phases/12-review-workspace.tsp`).

- Вход: `ReviewWorkspaceInput` — `{ runInput: RunInput, manifest: Manifest,
  workspace: WorkspaceTree }`. Параметры `--review-run` и `--ide` (если
  заданы) живут в `manifest.flagDefaults` — они не являются контрактными
  полями Input.
- Выход: `ReviewWorkspaceResult` — `{ workspacePath: string, opened: boolean,
  command: string }`:
  - `workspacePath` — абсолютный путь к `review.code-workspace`.
  - `opened` — `true` если редактор был успешно запущен; `false` по умолчанию
    (фаза только генерирует файл и печатает инструкцию, не запускает IDE).
  - `command` — готовая команда запуска редактора (например `code
    <workspacePath>`), печатается в stdout как инструкция.
- Ошибки: фаза **не имеет error-модели** — она принципиально не падает. Даже
  если VSCode не запускается, файл `review.code-workspace` существует, и фаза
  возвращает `ReviewWorkspaceResult` с `opened: false`.

Структура `review.code-workspace` (N-way пример, `buildWorkspaceJson`):
```jsonc
{
  "folders": [
    { "path": "apps/old/run-1", "name": "old run-1 (baseline)" },
    { "path": "apps/graphify/run-1", "name": "graphify run-1" },
    { "path": "apps/ast-grep/run-1", "name": "ast-grep run-1" },
    { "path": "pack/graphify", "name": "PACK graphify (read-only)" },
    { "path": "pack/ast-grep", "name": "PACK ast-grep (read-only)" }
  ],
  "settings": {
    "workbench.colorCustomizations": {}
  }
}
```

Было (v1, всегда ровно 3 записи): `OLD (baseline)`, `NEW (with pack)`,
`PACK source (read-only)`. Теперь — по одной записи **на каждый вариант**
(имя `<variant> run-<N>`, суффикс ` (baseline)` у варианта, названного
`manifest.baseline`), затем по одной записи **на каждый пак реестра** (имя
`PACK <name> (read-only)`, путь `pack/<name>` — тот же `packDir`-layout, что
и в фазе 03). Пустой реестр паков (smoke-test) даёт `folders` только с
вариантами, без секций `PACK *`.

## 3. Шаги алгоритма

1. Прочитать `reviewRun` (default 1) и `ide` (default `"vscode"`) из
   `manifest.flagDefaults` (`resolveReviewRun`/`resolveIde` — читают как
   `number`, так и строковое представление числа для `reviewRun`, невалидное
   или вне диапазона `1..manifest.runs` → fallback `1`, фаза не имеет
   error-модели и не падает).
2. Вычислить относительные пути (`buildWorkspaceJson`, относительно каталога,
   где будет лежать сам `review.code-workspace` — `locationDir`):
   - для **каждого** варианта из `manifest.variants` — путь его
     `workspace.variantTrees[*].apps[reviewRun-1]` (или запасной путь
     `apps/<variant>/run-<reviewRun>`, если запись в `variantTrees`
     отсутствует — защитный fallback, не должен срабатывать на здоровом
     workspace);
   - для **каждого** пака из `manifest.packs` — `pack/<name>`.
3. Собрать объект workspace по шаблону выше (`folders` = варианты + паки,
   в этом порядке; `settings.workbench.colorCustomizations` — пустой объект,
   кастомизация цвета заголовка окна убрана вместе с фиксированной парой
   old/new, для которой она имела смысл).
4. Сериализовать в `<workspaceRoot>/review.code-workspace` (pretty JSON). Сбой
   записи → warning в лог; фаза не падает.
5. Сформировать `command` по `ide` (`mapIdeToBinary`):
   - `vscode` → `code <workspacePath>`
   - `cursor` → `cursor <workspacePath>`
   - `code-insiders` → `code-insiders <workspacePath>`
   - любое другое значение → трактуется как `vscode` (`code`), без ошибки.
6. Не запускать команду автоматически (только напечатать в stdout как
   инструкцию). `opened = false`.
7. Вернуть `ReviewWorkspaceResult { workspacePath, opened, command }`.

## 4. Входные/выходные файлы

| Файл                              | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------- | ------------- | -------------------- |
| `review.code-workspace`           | Запись        | VSCode workspace JSON |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                       | Код                  |
| --------------------------------------------------- | ------------------------------------------------ | -------------------- |
| `--review-run 5` при `runs = 3`                     | warning + fallback на `reviewRun = 1`           | — (фаза не падает)   |
| `--review-run 0`                                    | warning + fallback на `reviewRun = 1`           | — (фаза не падает)   |
| smoke-test / реестр паков пуст                       | `folders` содержит только записи вариантов, без секций `PACK *` | —    |
| `--ide cursor` / `code-insiders`                    | `command` = `cursor <path>` / `code-insiders <path>` | —                |
| Невозможно записать workspace (ROFS)                | warning в лог, `workspacePath` указывает на несуществующий файл, `opened = false` | — (фаза не падает) |
| Повторный запуск с тем же runId                     | перезаписываем `review.code-workspace`          | —                    |
| `apps/<variant>/run-N` не существует (фаза 02 упала) | пишем workspace с указанным путём; VSCode покажет папку как missing — не наша проблема | — |
| N вариантов (N > 2)                                  | `folders` растёт линейно по числу вариантов + паков, без хардкода на 2+1 | — |
| Несколько вариантов делят один и тот же пак           | пак попадает в `folders` один раз (по реестру, не по вариантам) | — |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path legacy-шим: `--review-run 1`, `--ide vscode` → workspace
  содержит 3 папки (`old run-1 (baseline)`, `new run-1`, `PACK <name>
  (read-only)`); `command` = `code <workspacePath>`, `opened = false`.
- ✅ N-way: 3 варианта + 2 пака реестра → 5 папок (3 варианта + 2 пака),
  относительные пути корректны, ровно один вариант несёт суффикс `
  (baseline)`.
- ✅ review-run param: `--review-run 2` → пути `run-2` у всех вариантов.
- ✅ cursor / code-insiders ide — как раньше.
- ✅ smoke-test / пустой реестр: `folders` не содержит секций `PACK *`.
- ✅ invalid review-run (5 при runs=3, или 0) → warning, fallback на 1, фаза
  не падает.
- ✅ write failure: ROFS → warning в логе, `workspacePath` указывает на
  отсутствующий файл, `opened = false`, фаза не падает.
- ✅ idempotent: повторный запуск перезаписывает workspace.
- ✅ shared pack: пак объявлен двумя вариантами → в `folders` одна запись
  `PACK <name>`, не дублируется.
- ❌ НЕ покрыто (ticket): автооткрытие workspace после генерации (флаг
  `--open`, который выставил бы `opened = true`).

## 7. Инварианты

- Фаза **никогда не падает** (нет error-модели в контракте): даже при
  ROFS / невалидном `reviewRun` она возвращает `ReviewWorkspaceResult`.
- В успехе `review.code-workspace` существует и валиден как JSON VSCode
  workspace.
- Пути в `folders` **относительные** (от `workspaceRoot`), так что workspace
  переносим вместе с каталогом прогона.
- `folders` содержит ровно `manifest.variants.length + manifest.packs.length`
  записей: по одной на каждый вариант (в порядке конфига, ровно один — с
  суффиксом `(baseline)`), затем по одной на каждый пак реестра.
- `command` печатается в stdout как инструкция, **не** выполняется; `opened`
  отражает факт успешного запуска (обычно `false`).
- `reviewRun` ≤ `manifest.runs` (после fallback).

## 7a. Стоимость `--protect-git`

Фаза сама не падает и не меняет поведение под `--protect-git`, но её
результат для пользователя беднее: открытые в редакторе `apps/<variant>/run-N`
для защищённых прогонов **не содержат `.git`** (он перенесён в
`gitdirs/<variant>/run-N/`, см. `docs/phases/02-repo-clone.ru.md`) — значит
VSCode/Cursor не показывает git-декорации (gutter-маркеры изменённых строк,
blame, панель Source Control) для этих папок, ни для одного из открытых
вариантов. Диффы в самом testaipack (`diff/<variant>/run-<n>/full.patch`) при
этом корректны — это только визуальная потеря в IDE-обвязке review-фазы,
часть честной цены фичи наравне с потерей opencode-снапшотов (см.
`docs/phases/08-diff.ru.md`).

## 8. Зависимости от других фаз

- Зависит от: **01 workspace-setup** (`Manifest`, `WorkspaceTree`), **02
  repo-clone** (папки `apps/<variant>/run-N`), **03 pack-install**
  (`pack/<name>/` на каждый пак реестра), **00 cli-parse** (`reviewRun`,
  `ide` через `flagDefaults`).
- Блокирует: — (последняя «полезная» фаза перед cleanup; ничего downstream,
  кроме опциональной cleanup).
- Параллелизуется с: **11 report-render** (обе фазы читают готовые артефакты
  фаз 02–10, не имеют data-dependency между собой; на практике запускаются
  последовательно для удобства логов).
