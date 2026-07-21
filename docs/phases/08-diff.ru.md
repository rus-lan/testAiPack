# Фаза 08: diff

> Спека фазы. Контракт = `contract/phases/08-diff.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Снять git-diff рабочего дерева после прогона для каждой пары `(side, n)`,
сохранить `full.patch`, сводную статистику `summary.json` и (опционально)
HTML side-by-side `side.html`. Диффы нужны судье (фаза 09) и отчёту (фаза 11).

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.Diff` (см. `contract/phases/08-diff.tsp`).

- Вход: `DiffInput` — `{ runInput: RunInput, manifest: Manifest, workspace:
  WorkspaceTree }`. Флаг `runInput.diffHtml` управляет генерацией HTML.
- Выход: `DiffResultOutput` — `{ diff: { old: DiffResult; new: DiffResult } }`.
  `DiffResult = { side: Side, runs: DiffRunResult[] }`. Каждый `DiffRunResult =
  { runIndex: int32, fullPatch: string, summary: DiffSummary, htmlPath?: string,
  noChanges: boolean }`. `DiffSummary = { filesChanged, additions, deletions,
  perFile: FileChange[] }`. `FileChange = { path, additions, deletions }`.
- Ошибки: `@error DiffError` — `{ code, message, side: Side, runIndex?: int32,
  context? }`, где `code` принимает только одно значение:
  - `E_DISK_FULL` — нет места писать `full.patch` / `side.html` (`ENOSPC`).

  Повреждённое рабочее дерево (нет `.git`, упал `git add`/`git diff`) НЕ
  выделено в отдельный код — контракт 08 имеет только `E_DISK_FULL`. На
  практике такие сбои оборачиваются в `E_DISK_FULL` с детальным `message`, или
  ошибки пробрасываются выше как infra-level failure (вне `DiffError`).

`summary.json` (сериализованная `DiffSummary`):
```jsonc
{
  "filesChanged": 3,
  "additions": 42,
  "deletions": 7,
  "perFile": [{ "path": "src/a.ts", "additions": 10, "deletions": 2 }, ...]
}
```

## 3. Шаги алгоритма

1. Для каждой пары `(side, n)`, `side ∈ {old, new}`, `n ∈ 1..runs`:
   a. `destDir = workspace.appsOld[n-1]` (или `workspace.appsNew[n-1]`).
   b. Проверить существование `destDir/.git`. Если нет → fail прогона
      (повреждённое дерево; оборачивается в infra-level failure вне `DiffError`
      или в `E_DISK_FULL` с детальным `message` — контракт не выделяет
      отдельного кода).
   c. Выполнить `git -C <destDir> add -A` (индексируем все изменения рабочего
      дерева, включая untracked, чтобы попали в diff). Сбой `git add` — аналогично
      не имеет выделенного кода; детализируется в `message`.
   d. Выполнить `git -C <destDir> diff --cached` → записать stdout в
      `diff/<side>/run-<n>/full.patch`. `ENOSPC` → throw
      `DiffError({ code: "E_DISK_FULL", side, runIndex: n })`.
   e. Выполнить `git -C <destDir> diff --cached --stat` → распарсить в
      `DiffSummary` (`filesChanged`, `additions`, `deletions`, `perFile`).
   f. Если `full.patch` пустой → `noChanges = true`.
   g. Если `runInput.diffHtml === true`: сгенерировать `side.html` через
      `diff2html` (self-contained HTML с встроенным CSS/JS), путь приписать в
      `htmlPath`. `ENOSPC` → `E_DISK_FULL`. В v0.1 используется `diff2html`
      над `full.patch`.
   h. Записать `summary.json` в `diff/<side>/run-<n>/summary.json`.
2. Собрать `DiffResult` для каждой стороны (`{ side, runs: DiffRunResult[] }`),
   объединить в `DiffResultOutput { diff: { old, new } }` и вернуть.

## 4. Входные/выходные файлы

| Файл / каталог                          | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------------- | ------------- | -------------------- |
| `apps/<side>Version/run-<n>/`           | Чтение+git index | рабочее дерево     |
| `diff/<side>/run-<n>/full.patch`        | Запись        | unified diff текст   |
| `diff/<side>/run-<n>/summary.json`      | Запись        | `DiffSummary`        |
| `diff/<side>/run-<n>/side.html`         | Запись (opt)  | HTML (diff2html)     |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                       | Код                  |
| --------------------------------------------------- | ----------------------------------------------- | -------------------- |
| Рабочее дерево не изменено агентом                  | `noChanges = true`, патч пустой                 | —                    |
| `destDir/.git` отсутствует                          | fail (infra-level / `E_DISK_FULL` с детальным message) | —       |
| `git add` упал (битый index)                        | fail (аналогично)                               | —                    |
| `git diff` упал                                     | fail (аналогично)                               | —                    |
| Нет места писать `full.patch`                       | throw                                           | `E_DISK_FULL`        |
| `runInput.diffHtml === false`                       | `htmlPath` не задаётся                          | —                    |
| Очень большой diff (>10MB)                          | пишем как есть, warning в логе                  | —                    |
| Бинарный файл в diff                                | `git diff` пишет `Binary files … differ`,       | —                    |
|                                                     | `perFile` помечает `binary: true`               |                      |
| Untracked файлы (созданы агентом)                   | попадают в diff через `git add -A`              | —                    |
| Удалённые файлы                                     | попадают в diff                                 | —                    |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: агент модифицировал 2 файла → `fullPatch` непустой,
  `summary` содержит `filesChanged: 2`, `additions`/`deletions` > 0,
  `noChanges = false`.
- ✅ no changes: рабочее дерево чистое → `fullPatch` пустой, `noChanges = true`.
- ✅ html generated: `runInput.diffHtml = true` → `htmlPath` задан, файл
  существует и содержит встроенный CSS.
- ✅ html skipped: `runInput.diffHtml = false` → `htmlPath` не задан.
- ✅ no .git: удалили `.git` из `destDir` → fail (без выделенного кода, через
  `E_DISK_FULL` или infra-level failure).
- ✅ git add fails: повреждённый `index` → fail (аналогично).
- ✅ disk full: `ENOSPC` на записи патча → throw `E_DISK_FULL` с `runIndex`.
- ✅ untracked files: агент создал `new-file.ts` → файл в diff через
  `git add -A`.
- ✅ binary file: добавлен PNG → `perFile` помечает `binary: true`, патч
  содержит `Binary files differ`.
- ❌ НЕ покрыто (ticket): семантический diff (AST-level) вместо текстового —
  ticket про v0.3.

## 7. Инварианты

- Для каждой пары `(side, n)` существует `diff/<side>/run-<n>/full.patch` и
  `summary.json`.
- `DiffRunResult.noChanges === true` ⇔ `fullPatch` пустой.
- Если `runInput.diffHtml = true`, для каждой пары `DiffRunResult.htmlPath`
  задан.
- Диффы изолированы по парам: diff old/run-1 не зависит от old/run-2.
- `DiffSummary.perFile` суммы `additions` + `deletions` согласованы с
  `git diff --stat`.

## 8. Зависимости от других фаз

- Зависит от: **02 repo-clone** (рабочие деревья с `.git`), **06 run-side**
  (агент должен был модифицировать дерево; diff пустой, если не модифицировал).
- Блокирует: **09 judge** (судье нужны `fullPatch` с обеих сторон),
  **11 report-render** (в отчёте видны `fileDiffStats` из `summary`).
- Параллелизуется с: **07 aggregate**, **09 judge** — все три читают независимые
  артефакты фазы 06.
