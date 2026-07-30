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
  Флаг `runInput.protectGit` переключает фазу на two-path git через
  `workspace.gitDirsOld` / `gitDirsNew` и полностью отключает recovery — см.
  раздел 3a.
- Выход: `DiffResultOutput` — `{ diff: { old: DiffResult; new: DiffResult } }`.
  `DiffResult = { side: Side, runs: DiffRunResult[] }`. Каждый `DiffRunResult =
  { runIndex: int32, fullPatch: string, summary: DiffSummary, htmlPath?: string,
  noChanges: boolean, state?: DiffRunState, error?: DiffRunError }`.
  `DiffSummary = { filesChanged, additions, deletions, perFile: FileChange[] }`.
  `FileChange = { path, additions, deletions }`.
- `DiffRunState = "ok" | "git-restored" | "git-replaced" | "failed"`. Отсутствие
  поля (старый `report.json`, записанный до появления этого поля) читается как
  `"ok"` — `state` опционален специально ради обратной совместимости с
  `readReport` (`src/cli/workspace-runs.ts`).
  - `"ok"` — обычный дифф; `.git` на месте, его HEAD совпадает с `apps/source`.
  - `"git-restored"` — `.git` отсутствовал в рабочем дереве прогона и был
    восстановлен из `apps/source/.git`; дифф полный и корректный.
  - `"git-replaced"` — `.git` присутствовал, но чужой (HEAD не читается или не
    совпадает с `apps/source` — агент сделал `git init`, закоммитил или
    повредил репозиторий); он перенесён (не удалён — см. §3, шаг 2.c) в
    `apps/agent-git/<side>/run-<n>/` и заменён на чистый `.git`, дифф берётся
    относительно чистого HEAD (агентские коммиты попадают в патч).
  - `"failed"` — дифф не удалось снять; задан `error`; `fullPatch === ""`,
    `summary` нулевой, `noChanges === false`, `htmlPath` отсутствует, под
    `diff/<side>/run-<n>/` ничего не записано.
- `DiffRunError = { code: "E_WORKTREE_BROKEN", message: string }`.
- Ошибки: `@error DiffError` — `{ code, message, side: Side, runIndex?: int32,
  context? }`, где `code` принимает одно из двух значений:
  - `E_DISK_FULL` — машинно-глобальная, не прогонная проблема: нет места писать
    `full.patch` / `summary.json` / `side.html` (`ENOSPC`), либо сам git
    (`add`/`diff`/`diff --numstat`/`read-tree`) или копирование/перенос
    `.git`/подготовка `apps/agent-git/…` упали с ENOSPC-сигнатурой в тексте
    ошибки (та же идея, что в `02-repo-clone.ru.md`, но с более узким
    паттерном: `^ENOSPC:` в начале строки или `: no space left on device` в
    конце — не голая подстрока `ENOSPC`/`no space left`, потому что
    сопоставляемый текст может содержать выбранный агентом путь; голая
    подстрока позволила бы файлу с именем вроде `ENOSPC` завалить всю фазу
    из-за обычного, изолируемого сбоя одного прогона). Это единственный код,
    из-за которого падает вся фаза.
  - `E_WORKTREE_BROKEN` — повреждённое рабочее дерево прогона или отказ его
    проверить: нет `.git` и восстановить нечем, сбой копирования/переноса при
    восстановлении/замене (не-ENOSPC), упал `git add` / `git diff` / `git diff
    --numstat` (не-ENOSPC), либо HEAD `apps/source` недоступен и потому чужой
    `.git` нельзя ни подтвердить, ни опровергнуть (см. §3, шаг 1). Такой сбой
    изолируется на уровне одного прогона — фаза и отчёт всё равно завершаются.

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

1. Один раз за фазу: прочитать состояние HEAD `apps/source` через `git
   rev-parse --verify -q HEAD` (`headState`, `src/util/git.ts`), которое
   различает три исхода по коду возврата — `0` (коммит есть, вернуть SHA),
   `1` (репозиторий существует, но коммитов ещё нет — "unborn", легитимное
   состояние: например, тест на то, как агент строит проект с нуля), и любой
   другой код (нет `.git`, репозиторий повреждён — запомнить как
   "недоступен"). Прежний способ (`git rev-parse HEAD` без `--verify -q`)
   этого не различал — unborn и повреждённый репозиторий давали одинаковый
   сбой команды. "Недоступен" НЕ означает "пропустить проверку и считать
   прогон здоровым": без эталонного HEAD нельзя ни подтвердить, ни
   опровергнуть, что `.git` прогона — свой, а не чужой (агент мог повредить
   `apps/source` и параллельно сделать `git init` + commit в своём дереве —
   тогда пустой `git add -A` в непроверенном чужом `.git` дал бы пустой патч
   и `state: "ok"`, то есть ложный "агент ничего не менял"). Поэтому каждый
   прогон, чей `.git` присутствует в этом состоянии (шаг 2.c ниже),
   помечается `state: "failed"`, `E_WORKTREE_BROKEN` — сбой изолирован на
   уровне прогона, остальные прогоны и фаза продолжают. Unborn — не
   "недоступен": сравнение в шаге 2.c считает unborn `apps/source` и unborn
   `destDir` равными (`state: "ok"`), не заваливает прогон.
2. Для каждой пары `(side, n)`, `side ∈ {old, new}`, `n ∈ 1..runs`:
   a. `destDir = workspace.appsOld[n-1]` (или `workspace.appsNew[n-1]`).
   b. Проверить существование `destDir/.git`. Если нет → скопировать
      `apps/source/.git` в `destDir/.git` (`state: "git-restored"`). Если и в
      `apps/source` нет `.git`, или копирование упало — прогон помечается
      `state: "failed"` с `error.code E_WORKTREE_BROKEN`, остальные прогоны и
      фаза продолжают работу (см. §3 контракта).
   c. Если `.git` присутствует, а HEAD `apps/source` недоступен (шаг 1) → прогон
      сразу `state: "failed"`, `E_WORKTREE_BROKEN`, `reason:
      "source-head-unreadable"` — см. шаг 1. Иначе сравнить состояние HEAD
      `destDir` (тот же `headState`) с HEAD `apps/source`: равны, если оба —
      один и тот же коммит, ИЛИ оба unborn (`headsMatch`, `src/util/git.ts`).
      Не читается, отличается или один unborn при другом с коммитом (агент
      сделал `git init`, закоммитил, повредил репозиторий) → перенести
      (не удалить) `destDir/.git` в `apps/agent-git/<side>/run-<n>/` — вне
      `destDir`, чтобы не попасть как untracked-контент в собственный же diff —
      и восстановить чистый `.git` из `apps/source/.git` (`state:
      "git-replaced"`). Перенесённый чужой `.git` — единственный след того, что
      агент сделал в терминах git; он не удаляется и живёт рядом с остальным
      `apps/` (значит, попадает под ту же очистку, что и `apps/` — см. §4).
      Сбой переноса/подготовки каталога/восстановления → прогон `state:
      "failed"`, `E_WORKTREE_BROKEN` (или `E_DISK_FULL`, если сбой
      ENOSPC-формы — классификатор проверяется на каждом из трёх шагов:
      подготовка каталога, перенос, восстановление), фаза продолжает.
   d. Прочитать состояние HEAD *самого `destDir`* (после восстановления/замены
      выше, тем же `headState`, в защищённом режиме — через `protectGitDir`).
      Если это коммит → выполнить `git read-tree HEAD` в отдельный временный
      index-файл (`GIT_INDEX_FILE`, ещё пустой на этом шаге) — иначе `git add
      -A` на пустом индексе не отличит файл, который закоммичен, но теперь
      игнорируется (`.gitignore`, например собранный `dist/`, лок-файл), от
      обычного untracked: `add -A` его просто пропустит, а `git diff --cached`
      после этого покажет такой файл как **удалённый**, хотя агент его не
      трогал — на любом репозитории, где есть закоммиченный, но игнорируемый
      путь, это портит `full.patch` на обеих сторонах каждого прогона.
      Если HEAD unborn (коммитов ещё нет) → `read-tree HEAD` не выполняется
      (сама команда падает на unborn HEAD — читать нечего, и это верно: пустой
      индекс уже корректно отражает "ничего не закоммичено"). Сбой чтения
      состояния или `read-tree` → `E_WORKTREE_BROKEN` (или `E_DISK_FULL` при
      ENOSPC-сигнатуре).
   e. Выполнить `git add -A` в тот же временный index-файл, а не в собственный
      index прогона — так фаза не затирает то, что уже застейджил агент (это
      единственный способ наблюдать staged-состояние агента), и разовый
      прогон никогда не натыкается на протухший `destDir/.git/index.lock` от
      убитого процесса агента (свежий временный путь такой lock нести не
      может). Сбой git → `E_WORKTREE_BROKEN` (прогон `failed`),
      ENOSPC-сигнатура в тексте ошибки → `E_DISK_FULL` (валит фазу).
   f. Выполнить `git diff --cached` (тот же временный index) → записать stdout в
      `diff/<side>/run-<n>/full.patch`. Сбой git-команды → `E_WORKTREE_BROKEN`
      (прогон `failed`), ENOSPC-сигнатура → `E_DISK_FULL` (валит фазу).
      `ENOSPC` при записи файла на диск → тоже `DiffError({ code: "E_DISK_FULL",
      side, runIndex: n })` — валит фазу целиком (полный диск — машинная, не
      прогонная проблема).
   g. Выполнить `git diff --cached --numstat` (тот же временный index; машинно
      парсимый построчный формат `additions\tdeletions\tpath`, не
      человекочитаемый `--stat`) → распарсить в `DiffSummary`
      (`filesChanged`, `additions`, `deletions`, `perFile`). Сбой команды →
      `E_WORKTREE_BROKEN` (или `E_DISK_FULL` при ENOSPC-сигнатуре).
   h. Если `full.patch` пустой → `noChanges = true`.
   i. Если `runInput.diffHtml === true`: сгенерировать `side.html` через
      `diff2html` (self-contained HTML с встроенным CSS/JS), путь приписать в
      `htmlPath`. `ENOSPC` → `E_DISK_FULL` (валит фазу). В v0.1 используется
      `diff2html` над `full.patch`.
   j. Записать `summary.json` в `diff/<side>/run-<n>/summary.json`.
3. Собрать `DiffResult` для каждой стороны (`{ side, runs: DiffRunResult[] }`),
   объединить в `DiffResultOutput { diff: { old, new } }` и вернуть. Прогоны с
   `E_WORKTREE_BROKEN` попадают сюда как обычные записи со `state: "failed"` —
   фаза как Effect не падает из-за одного сломанного прогона; `E_DISK_FULL`
   остаётся фейлом всей фазы.

## 3a. `--protect-git`: recovery принципиально не запускается

Когда `runInput.protectGit === true`, для каждой пары `(side, n)` есть
персональный перенесённый git-каталог `workspace.gitDirsOld[n-1]` /
`gitDirsNew[n-1]` (см. `docs/phases/02-repo-clone.ru.md`, раздел 7.1). Ветвление
проверяется **до** шагов 2.b/2.c (`restoreGit`/`checkGitHead`/`replaceGit`) —
эти три функции физически не вызываются ни при каких условиях, пока прогон
защищён, потому что `restoreGit` скопировал бы `.git` обратно внутрь
примонтированного дерева и тем самым молча снял бы защиту:

1. Есть ли `gitDirsOld[n-1]` / `gitDirsNew[n-1]` на диске?
   - Да → `state: "ok"`. Проверка HEAD (шаг 1/2.c обычного пути) не выполняется —
     агент физически не может достать до перенесённого `.git` (не примонтирован
     в docker), так что расхождение HEAD означало бы вмешательство оператора
     хоста, а не поведение агента; заменить его в этом случае не на что.
   - Нет (перенесённый каталог кем-то удалён — оператор, а не агент) → прогон
     `state: "failed"`, `error.code E_WORKTREE_BROKEN`, `reason: "no-git-dir"`,
     остальные прогоны и фаза продолжают как обычно.
2. `git add -A` / `git diff --cached` / `git diff --cached --numstat` идут в
   two-path форме: `git --git-dir=<gitDirsOld[n-1]|gitDirsNew[n-1]>
   --work-tree=<destDir> …` (`src/util/git.ts`, параметр `gitDir`), поверх ещё
   одного слоя — временного index-файла (шаг 2.d обычного пути). Без
   `--protect-git` `gitDir` не передаётся — форма команд байт-в-байт как раньше.
3. HEAD `apps/source` в защищённом режиме не читается вовсе (не нужен — ни один
   потребитель его не использует, см. п.1).
4. `appDirs`/`gitDirs` (`workspace.appsOld`/`gitDirsOld`, либо пара `new`) —
   два параллельных массива одной длины по построению (`buildTreePaths`);
   фаза проверяет это явно перед тем, как их сопоставлять по индексу. Если бы
   массивы разошлись по длине (сегодня недостижимо), молчаливый `gitDirs?.[i]`
   деградировал бы до `undefined` для несовпавшего индекса — прогон, который
   должен быть защищён, провалился бы в обычный путь (`restoreGit`), скопировал
   `.git` обратно в примонтированное дерево и тем самым молча снял защиту.
   Несовпадение длины валит всю фазу (`E_WORKTREE_BROKEN`, `reason:
   "git-dirs-count-mismatch"`) раньше, чем запустится хоть один прогон стороны.

Edge-cases (агент реагирует на защиту иначе, чем на обычный `.git`):

| Кейс | Поведение | Код |
| --- | --- | --- |
| Агент делает `git init` на верхнем уровне рабочего дерева | git отказывается трекать путь с вложенным `.git`; `git --git-dir=<protected> add -A` игнорирует его целиком — дифф идентичен прогону без `git init` | — |
| Агент делает `git init` в поддиректории, которую сам создал (`foo/.git`) | `foo` попадает в индекс как gitlink (`new file mode 160000`, warning в stderr); `--numstat` даёт `-\t-` → `perFile` запись `foo` с `additions: 0, deletions: 0` | — |
| Перенесённый git-каталог удалён (ошибка оператора, не агента) | прогон `state: "failed"`, остальные прогоны и фаза продолжают | `E_WORKTREE_BROKEN` |
| `--protect-git` не задан (`false`, по умолчанию) | поведение фазы байт-в-байт как до появления флага (recovery работает как раньше) | — |

Цена (см. также `docs/phases/00-cli-parse.ru.md` и `docs/phases/12-review-workspace.ru.md`):
opencode snapshot/patch export-части пропадают для **каждого** защищённого
прогона (нужен `/workspace/.git`, а он не примонтирован) — это плата за
гарантию, а не побочный баг.

## 4. Входные/выходные файлы

| Файл / каталог                          | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------------- | ------------- | -------------------- |
| `apps/<side>Version/run-<n>/`           | Чтение+git index | рабочее дерево     |
| `apps/agent-git/<side>/run-<n>/`        | Запись (opt)  | сохранённый чужой `.git` (шаг 2.c, только при `state: "git-replaced"`); не отчётный артефакт, живёт в `apps/` и удаляется вместе с ним ephemeral-очисткой/`gc --aggressive` |
| `diff/<side>/run-<n>/full.patch`        | Запись        | unified diff текст   |
| `diff/<side>/run-<n>/summary.json`      | Запись        | `DiffSummary`        |
| `diff/<side>/run-<n>/side.html`         | Запись (opt)  | HTML (diff2html)     |
| `$TMPDIR/testaipack-diff-index/…`       | Запись+удаление | временный `GIT_INDEX_FILE`, per-прогон, удаляется сразу после шагов 2.d–2.f |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                       | Код                  |
| --------------------------------------------------- | ----------------------------------------------- | -------------------- |
| Рабочее дерево не изменено агентом                  | `noChanges = true`, патч пустой                 | —                    |
| `destDir/.git` отсутствует, `apps/source/.git` есть | восстановлен из `apps/source`, `state: "git-restored"` | —             |
| `destDir/.git` отсутствует и `apps/source/.git` тоже отсутствует | прогон `failed`, остальные прогоны и фаза продолжают | `E_WORKTREE_BROKEN` |
| Сбой копирования при восстановлении `.git`          | прогон `failed`, фаза продолжает                | `E_WORKTREE_BROKEN`  |
| Сбой копирования — ENOSPC-сигнатура в тексте ошибки | вся фаза падает                                 | `E_DISK_FULL`        |
| Агент сделал `git init`                             | чужой `.git` перенесён (не удалён) в `apps/agent-git/<side>/run-<n>/`, восстановлен чистый из `apps/source`, `state: "git-replaced"` | — |
| Агент закоммитил свою работу (HEAD ≠ `apps/source`) | чужой `.git` перенесён в `apps/agent-git/…`, чистый `.git` восстановлен, коммиты агента видны в `full.patch`, `state: "git-replaced"` | — |
| Сбой переноса/восстановления при замене чужого `.git` | прогон `failed`, фаза продолжает              | `E_WORKTREE_BROKEN`  |
| Сбой переноса — ENOSPC-сигнатура в тексте ошибки    | вся фаза падает                                 | `E_DISK_FULL`        |
| HEAD `apps/source` не читается, `.git` прогона присутствует | прогон `failed` (проверить чужой `.git` нечем — не значит "здоров"), остальные прогоны и фаза продолжают | `E_WORKTREE_BROKEN` |
| `git add` упал (битый index)                        | прогон `failed`, фаза продолжает                | `E_WORKTREE_BROKEN`  |
| `git diff` упал                                     | прогон `failed`, фаза продолжает                | `E_WORKTREE_BROKEN`  |
| `git diff --numstat` упал                           | прогон `failed`, фаза продолжает                | `E_WORKTREE_BROKEN`  |
| `git add`/`diff`/`diff --numstat` упал с ENOSPC-сигнатурой в stderr | вся фаза падает (полный диск — не прогонная проблема) | `E_DISK_FULL` |
| Протухший `destDir/.git/index.lock` от убитого процесса агента | не мешает: фаза стейджит во временный `GIT_INDEX_FILE`, не в собственный index прогона | — |
| Нет места писать `full.patch` / `summary.json` / `side.html` | throw, вся фаза падает                | `E_DISK_FULL`        |
| `runInput.diffHtml === false`                       | `htmlPath` не задаётся                          | —                    |
| Очень большой diff (>10MB)                          | пишем как есть, warning в логе                  | —                    |
| Бинарный файл в diff                                | `git diff --numstat` пишет `-`/`-` для счётчиков | —                   |
|                                                     | этого файла → в `perFile` `additions: 0,`       |                      |
|                                                     | `deletions: 0` (у `FileChange` нет поля `binary`) |                    |
| Untracked файлы (созданы агентом)                   | попадают в diff через `git add -A`              | —                    |
| Удалённые файлы                                     | попадают в diff                                 | —                    |
| `--protect-git`: `appDirs`/`gitDirs` разной длины (недостижимо сегодня) | вся фаза падает раньше первого прогона стороны, ни один прогон не "проваливается" в обычный recovery | `E_WORKTREE_BROKEN` |
| Закоммиченный, но теперь игнорируемый файл (`dist/`, лок-файл), рядом с ним меняется другой файл | `read-tree HEAD` в шаге 2.d предзаполняет временный индекс — файл не показывается как удалённый | — |
| `apps/source` без единого коммита (unborn), рабочее дерево не тронуто | `noChanges = true`, `state: "ok"` (не `"failed"`)  | —                    |
| `apps/source` unborn, агент создал файлы            | `state: "ok"`, файлы в патче как `new file`     | —                    |
| `apps/source` unborn, у `destDir` появился коммит (агент закоммитил) | расценивается как чужой `.git`, `state: "git-replaced"` | — |
| Подготовка каталога `apps/agent-git/…` (`ensureDir`) упала | прогон `failed`, фаза продолжает                | `E_WORKTREE_BROKEN`  |
| Подготовка каталога `apps/agent-git/…` упала с ENOSPC-сигнатурой | вся фаза падает                          | `E_DISK_FULL`        |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: агент модифицировал 2 файла → `fullPatch` непустой,
  `summary` содержит `filesChanged: 2`, `additions`/`deletions` > 0,
  `noChanges = false`.
- ✅ no changes: рабочее дерево чистое → `fullPatch` пустой, `noChanges = true`.
- ✅ html generated: `runInput.diffHtml = true` → `htmlPath` задан, файл
  существует и содержит встроенный CSS.
- ✅ html skipped: `runInput.diffHtml = false` → `htmlPath` не задан.
- ✅ disk full: `ENOSPC` на записи патча → throw `E_DISK_FULL` с `runIndex`,
  фаза падает целиком.
- ✅ untracked files: агент создал `new-file.ts` → файл в diff через
  `git add -A`.
- ✅ binary file: добавлен PNG → патч содержит `Binary files ... differ`,
  `perFile` для этого файла даёт `additions: 0, deletions: 0` (нет
  отдельного поля `binary` в `FileChange`).
- ✅ восстановление `.git`: удалили `.git` из `destDir`, `apps/source/.git`
  цел → фаза успешна, `state: "git-restored"`, диф корректный
  (`summary.filesChanged` совпадает с реальными изменениями).
- ✅ восстановление невозможно: `.git` нет ни в `destDir`, ни в `apps/source`
  → прогон `state: "failed"`, `error.code E_WORKTREE_BROKEN`, фаза и остальные
  прогоны завершаются нормально.
- ✅ сбой копирования при восстановлении: `copyDir` падает → прогон `failed`,
  сообщение содержит `restore .git`.
- ✅ сбой копирования при восстановлении — ENOSPC: вся фаза падает,
  `error.code E_DISK_FULL`, прогон не изолируется.
- ✅ один сломанный прогон не валит остальные: при `runs ≥ 2` один прогон, у
  которого восстановление `.git` падает (например, сбой `copyDir`), не мешает
  остальным прогонам той же и другой стороны остаться `state: "ok"`.
- ✅ happy-path также проверяет `state: "ok"` на нетронутом прогоне (доказывает,
  что сравнение HEAD не даёт ложных срабатываний, когда прогон — чистая копия
  `apps/source`).
- ✅ агент сделал `git init`: чужой `.git` без коммитов (`rev-parse HEAD`
  падает) → перенесён в `apps/agent-git/<side>/run-<n>/` (не удалён, не
  засоряет сам diff), заменён на чистый, `state: "git-replaced"`, патч
  показывает изменение файла относительно чистого HEAD, а не добавление в
  пустое дерево.
- ✅ агент закоммитил свою работу: HEAD прогона отличается от `apps/source` →
  чужой `.git` перенесён, чистый восстановлен, `state: "git-replaced"`,
  закоммиченные изменения агента видны в `full.patch` (без замены патч был бы
  пустым).
- ✅ сбой переноса при замене чужого `.git`: `moveDir` падает → прогон
  `failed`, сообщение содержит `move foreign .git`.
- ✅ сбой переноса при замене чужого `.git` — ENOSPC: вся фаза падает,
  `error.code E_DISK_FULL`.
- ✅ HEAD `apps/source` не читается, `.git` прогона присутствует и цел →
  прогон `state: "failed"`, `error.code E_WORKTREE_BROKEN`, `fullPatch === ""`
  (не "ok" с пустым патчем) — проверка чужого `.git` невозможна, не пройдена.
- ✅ HEAD `apps/source` не читается **и** агент сделал `git init` + commit в
  своём дереве: прогон всё равно `state: "failed"` (не "ok" с пустым патчем —
  главный сценарий, который эта проверка обязана ловить: агент повредил
  `apps/source` и закоммитил собственную работу, `git add -A` в непроверенном
  чужом `.git` дал бы пустой diff).
- ✅ сбой `git add -A` / `git diff --cached` / `git diff --cached --numstat` →
  прогон `state: "failed"`, `error.code E_WORKTREE_BROKEN`, фаза как Effect не
  падает — остальные прогоны, агрегация и отчёт достраиваются.
- ✅ сбой `git add -A` с ENOSPC-сигнатурой в stderr → вся фаза падает,
  `error.code E_DISK_FULL`, прогон не изолируется.
- ✅ протухший `destDir/.git/index.lock` не мешает: прогон `state: "ok"`,
  дифф корректный (фаза стейджит во временный `GIT_INDEX_FILE`).
- ✅ временный index не задевает собственный index прогона: после фазы
  `git ls-files -s` и `git diff --cached` внутри `destDir` дают тот же
  результат, что и до вызова фазы.
- ✅ `--protect-git`, `gitDirs` короче `appDirs` (несовпадение длины) → вся
  фаза падает раньше первого прогона стороны, `error.code E_WORKTREE_BROKEN`,
  `reason: "git-dirs-count-mismatch"`; непарный прогон не получает `.git`
  обратно в примонтированное дерево.
- ✅ md/html-рендер: прогон `state: "failed"` рендерится как `diff failed —
  <message>` без ссылок на патч; `state: "git-restored"` / `"git-replaced"`
  рендерятся как обычная строка с пометкой `(git restored)` / `(git
  replaced)`; отсутствие поля `state` рендерится как `"ok"`.
- ❌ НЕ покрыто (ticket): семантический diff (AST-level) вместо текстового —
  ticket про v0.3.

## 7. Инварианты

- Для каждой пары `(side, n)` **кроме `state: "failed"`** существует
  `diff/<side>/run-<n>/full.patch` и `summary.json`. Для `"failed"` под этим
  путём не пишется ничего (каталог может существовать от `ensureDir`, файлов
  в нём нет).
- `DiffRunResult.noChanges === true` ⇔ `fullPatch` пустой — инвариант
  ограничен прогонами с `state !== "failed"`: у `"failed"` `noChanges ===
  false` и `fullPatch === ""` одновременно (сигнал "неизвестно", не "чисто").
- Если `runInput.diffHtml = true`, для каждой пары со `state !== "failed"`
  `DiffRunResult.htmlPath` задан.
- Диффы изолированы по парам: diff old/run-1 не зависит от old/run-2; сбой
  одного прогона (`E_WORKTREE_BROKEN`) не влияет на другие прогоны той же или
  другой стороны.
- `DiffSummary.perFile` суммы `additions` + `deletions` согласованы с
  `git diff --stat`.
- `state` отсутствует только в `report.json`, записанных до появления этого
  поля; в любом отчёте, написанном текущей фазой, `state` всегда явно задан.

## 8. Зависимости от других фаз

- Зависит от: **02 repo-clone** (рабочие деревья с `.git`), **06 run-side**
  (агент должен был модифицировать дерево; diff пустой, если не модифицировал).
- Блокирует: **09 judge** (судье нужны `fullPatch` с обеих сторон),
  **11 report-render** (Diff summary и файловые дельты в Secondary metrics
  рендерятся из `DiffSummary` этой фазы — единственный надёжный источник
  этих чисел, см. `docs/phases/07-aggregate.ru.md`).
- Параллелизуется с: **07 aggregate**, **09 judge** — все три читают независимые
  артефакты фазы 06.
