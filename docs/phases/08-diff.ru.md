# Фаза 08: diff

> Спека фазы. Контракт = `contract/phases/08-diff.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Снять git-diff рабочего дерева после прогона для каждой пары `(variant, n)`,
сохранить `full.patch`, сводную статистику `summary.json` и (опционально)
HTML `variant.html`. Диффы нужны судье (фаза 09) и отчёту (фаза 11).

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.Diff` (см. `contract/phases/08-diff.tsp`).

- Вход: `DiffInput` — `{ runInput: RunInput, manifest: Manifest, workspace:
  WorkspaceTree }`. Флаг `runInput.diffHtml` управляет генерацией HTML.
  Флаг `runInput.protectGit` переключает фазу на two-path git через
  `vt.gitDirs` (для каждого `VariantTree` в `workspace.variantTrees`) и
  полностью отключает recovery — см. раздел 3a.
- Выход: `DiffResultOutput` — `{ diffs: DiffResult[] }` (было `{ diff: { old,
  new } }`). Одна запись `DiffResult = { variant: string, runs:
  DiffRunResult[] }` **на каждый вариант**, в порядке
  `workspace.variantTrees`. Каждый `DiffRunResult = { runIndex: int32,
  fullPatch: string, summary: DiffSummary, htmlPath?: string, noChanges:
  boolean, state?: DiffRunState, error?: DiffRunError }`.
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
    `apps/agent-git/<variant>/run-<n>/` и заменён на чистый `.git`, дифф
    берётся относительно чистого HEAD (агентские коммиты попадают в патч).
  - `"failed"` — дифф не удалось снять; задан `error`; `fullPatch === ""`,
    `summary` нулевой, `noChanges === false`, `htmlPath` отсутствует, под
    `diff/<variant>/run-<n>/` ничего не записано.
- `DiffRunError = { code: "E_WORKTREE_BROKEN", message: string }`.
- Ошибки: `@error DiffError` — `{ code, message, variant: string, runIndex?:
  int32, context? }`, где `code` принимает одно из двух значений:
  - `E_DISK_FULL` — машинно-глобальная, не прогонная проблема: нет места писать
    `full.patch` / `summary.json` / `variant.html` (`ENOSPC`), либо сам git
    (`add`/`diff`/`diff --numstat`/`read-tree`) или копирование/перенос
    `.git`/подготовка `apps/agent-git/…` упали с ENOSPC-сигнатурой в тексте
    ошибки (узкий паттерн: `^ENOSPC:` в начале строки или `: no space left on
    device` в конце — не голая подстрока `ENOSPC`/`no space left`, потому что
    сопоставляемый текст может содержать выбранный агентом путь). Это
    единственный код, из-за которого падает вся фаза.
  - `E_WORKTREE_BROKEN` — повреждённое рабочее дерево прогона или отказ его
    проверить: нет `.git` и восстановить нечем, сбой копирования/переноса при
    восстановлении/замене (не-ENOSPC), упал `git add` / `git diff` / `git diff
    --numstat` (не-ENOSPC), либо HEAD `apps/source` недоступен и потому чужой
    `.git` нельзя ни подтвердить, ни опровергнуть (см. §3, шаг 1). Такой сбой
    изолируется на уровне одного прогона — фаза и отчёт всё равно завершаются.

`summary.json` (сериализованная `DiffSummary`) — структура не изменилась:
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
   rev-parse --verify -q HEAD` (`headState`, `src/util/git.ts`), различающее
   три исхода: `0` (коммит есть), `1` (unborn — легитимно), любой другой код
   («недоступен» — нет `.git`/повреждён). «Недоступен» НЕ означает «пропустить
   проверку и считать прогон здоровым» — без эталонного HEAD нельзя ни
   подтвердить, ни опровергнуть, что `.git` конкретного прогона свой, а не
   чужой. Поэтому каждый прогон, чей `.git` присутствует в этом состоянии
   (шаг 2.c ниже), помечается `state: "failed"`, `E_WORKTREE_BROKEN` — сбой
   изолирован на уровне прогона, остальные прогоны продолжают. Unborn — не
   «недоступен»: сравнение в шаге 2.c считает unborn `apps/source` и unborn
   `destDir` равными (`state: "ok"`).
2. Для **каждого `VariantTree`** в `workspace.variantTrees` (`diffVariant`,
   `{ concurrency: 1 }` — паралеллизм между вариантами не нужен, диффы
   дешевле самих прогонов), и внутри для каждого `runIndex ∈ 1..runs`
   (`diffOneRun`):
   a. `destDir = vt.apps[n-1]` (абсолютный путь `apps/<vt.name>/run-<n>/`).
   b. Проверить существование `destDir/.git`. Если нет → скопировать
      `apps/source/.git` в `destDir/.git` (`state: "git-restored"`). Если и в
      `apps/source` нет `.git`, или копирование упало — прогон помечается
      `state: "failed"` с `error.code E_WORKTREE_BROKEN`, остальные прогоны
      этого и других вариантов продолжают работу.
   c. Если `.git` присутствует, а HEAD `apps/source` недоступен (шаг 1) →
      прогон сразу `state: "failed"`, `E_WORKTREE_BROKEN`, `reason:
      "source-head-unreadable"`. Иначе сравнить состояние HEAD `destDir` с
      HEAD `apps/source` (`headsMatch`). Не совпадает → перенести (не
      удалить) `destDir/.git` в `apps/agent-git/<vt.name>/run-<n>/` — вне
      `destDir`, чтобы не попасть как untracked-контент в собственный же diff
      — и восстановить чистый `.git` из `apps/source/.git` (`state:
      "git-replaced"`). Перенесённый чужой `.git` живёт рядом с остальным
      `apps/` (значит, попадает под ту же очистку, что и `apps/` — см. §4).
      Сбой переноса/подготовки каталога/восстановления → прогон `state:
      "failed"`, `E_WORKTREE_BROKEN` (или `E_DISK_FULL` при ENOSPC-форме).
   d. Прочитать состояние HEAD *самого `destDir`* (после восстановления/замены
      выше, тем же `headState`, в защищённом режиме — через `protectGitDir`).
      Если это коммит → выполнить `git read-tree HEAD` в отдельный временный
      index-файл (`GIT_INDEX_FILE`, ещё пустой на этом шаге) — иначе `git add
      -A` на пустом индексе не отличит закоммиченный-но-теперь-игнорируемый
      файл от обычного untracked. Если HEAD unborn — `read-tree HEAD` не
      выполняется. Сбой → `E_WORKTREE_BROKEN` (или `E_DISK_FULL`).
   e. Выполнить `git add -A` в тот же временный index-файл, а не в собственный
      index прогона — так фаза не затирает то, что уже застейджил агент, и
      разовый прогон никогда не натыкается на протухший
      `destDir/.git/index.lock`. Сбой git → `E_WORKTREE_BROKEN` (прогон
      `failed`), ENOSPC-сигнатура → `E_DISK_FULL` (валит фазу).
   f. Выполнить `git diff --cached` (тот же временный index) → записать stdout в
      `diff/<vt.name>/run-<n>/full.patch`. Сбой git-команды → `E_WORKTREE_BROKEN`
      (прогон `failed`), ENOSPC-сигнатура → `E_DISK_FULL` (валит фазу).
      `ENOSPC` при записи файла на диск → тоже `DiffError({ code: "E_DISK_FULL",
      variant, runIndex: n })` — валит фазу целиком.
   g. Выполнить `git diff --cached --numstat` (тот же временный index) →
      распарсить в `DiffSummary`. Сбой команды → `E_WORKTREE_BROKEN` (или
      `E_DISK_FULL`).
   h. Если `full.patch` пустой → `noChanges = true`.
   i. Если `runInput.diffHtml === true`: сгенерировать `variant.html` через
      `diff2html` (self-contained HTML с встроенным CSS/JS), путь приписать в
      `htmlPath`. `ENOSPC` → `E_DISK_FULL`.
   j. Записать `summary.json` в `diff/<vt.name>/run-<n>/summary.json`.
3. Собрать `DiffResult` для **каждого варианта** (`{ variant: vt.name, runs:
   DiffRunResult[] }`), объединить в `DiffResultOutput { diffs: DiffResult[]
   }` и вернуть. Прогоны с `E_WORKTREE_BROKEN` попадают сюда как обычные
   записи со `state: "failed"` — фаза как Effect не падает из-за одного
   сломанного прогона; `E_DISK_FULL` остаётся фейлом всей фазы.

## 3a. `--protect-git`: recovery принципиально не запускается

Когда `runInput.protectGit === true`, для каждого `VariantTree` есть
персональный перенесённый git-каталог на каждый прогон (`vt.gitDirs[n-1]`,
см. `docs/phases/02-repo-clone.ru.md`, раздел 7.1). Ветвление проверяется
**до** шагов 2.b/2.c (`restoreGit`/`checkGitHead`/`replaceGit`) — эти три
функции физически не вызываются ни при каких условиях, пока прогон защищён,
потому что `restoreGit` скопировал бы `.git` обратно внутрь примонтированного
дерева и тем самым молча снял бы защиту:

1. Есть ли `vt.gitDirs[n-1]` на диске?
   - Да → `state: "ok"`. Проверка HEAD (шаг 1/2.c обычного пути) не выполняется —
     агент физически не может достать до перенесённого `.git` (не примонтирован
     в docker), так что расхождение HEAD означало бы вмешательство оператора
     хоста, а не поведение агента.
   - Нет (перенесённый каталог кем-то удалён — оператор, а не агент) → прогон
     `state: "failed"`, `error.code E_WORKTREE_BROKEN`, `reason: "no-git-dir"`,
     остальные прогоны и фаза продолжают как обычно.
2. `git add -A` / `git diff --cached` / `git diff --cached --numstat` идут в
   two-path форме: `git --git-dir=<vt.gitDirs[n-1]> --work-tree=<destDir> …`
   (`src/util/git.ts`, параметр `gitDir`), поверх ещё одного слоя — временного
   index-файла (шаг 2.d обычного пути). Без `--protect-git` `gitDir` не
   передаётся — форма команд байт-в-байт как раньше.
3. HEAD `apps/source` в защищённом режиме не читается вовсе.
4. `vt.apps`/`vt.gitDirs` — два параллельных массива одной длины по
   построению (`buildTreePaths`); фаза проверяет это явно перед тем, как их
   сопоставлять по индексу (`pairRunDirs`, на каждый `VariantTree`
   отдельно — рассинхрон в одном варианте не задевает остальные). Несовпадение
   длины валит диффы этого варианта раньше, чем запустится хоть один его
   прогон (`E_WORKTREE_BROKEN`, `reason: "git-dirs-count-mismatch"`).

Edge-cases (агент реагирует на защиту иначе, чем на обычный `.git`) —
не изменились относительно v1, теперь per variant:

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
| `apps/<variant>/run-<n>/`               | Чтение+git index | рабочее дерево     |
| `apps/agent-git/<variant>/run-<n>/`     | Запись (opt)  | сохранённый чужой `.git` (шаг 2.c, только при `state: "git-replaced"`); не отчётный артефакт, живёт в `apps/` и удаляется вместе с ним ephemeral-очисткой/`gc --aggressive` |
| `diff/<variant>/run-<n>/full.patch`     | Запись        | unified diff текст   |
| `diff/<variant>/run-<n>/summary.json`   | Запись        | `DiffSummary`        |
| `diff/<variant>/run-<n>/variant.html`   | Запись (opt)  | HTML (diff2html)     |
| `$TMPDIR/testaipack-diff-index/…`       | Запись+удаление | временный `GIT_INDEX_FILE`, per-прогон, удаляется сразу после шагов 2.d–2.f |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                       | Код                  |
| --------------------------------------------------- | ------------------------------------------------ | -------------------- |
| Рабочее дерево не изменено агентом                  | `noChanges = true`, патч пустой                 | —                    |
| `destDir/.git` отсутствует, `apps/source/.git` есть | восстановлен из `apps/source`, `state: "git-restored"` | —             |
| `destDir/.git` отсутствует и `apps/source/.git` тоже отсутствует | прогон `failed`, остальные прогоны и фаза продолжают | `E_WORKTREE_BROKEN` |
| Сбой копирования при восстановлении `.git`          | прогон `failed`, фаза продолжает                | `E_WORKTREE_BROKEN`  |
| Сбой копирования — ENOSPC-сигнатура в тексте ошибки | вся фаза падает                                 | `E_DISK_FULL`        |
| Агент сделал `git init`                             | чужой `.git` перенесён (не удалён) в `apps/agent-git/<variant>/run-<n>/`, восстановлен чистый из `apps/source`, `state: "git-replaced"` | — |
| Агент закоммитил свою работу (HEAD ≠ `apps/source`) | чужой `.git` перенесён в `apps/agent-git/…`, чистый `.git` восстановлен, коммиты агента видны в `full.patch`, `state: "git-replaced"` | — |
| Сбой переноса/восстановления при замене чужого `.git` | прогон `failed`, фаза продолжает              | `E_WORKTREE_BROKEN`  |
| Сбой переноса — ENOSPC-сигнатура в тексте ошибки    | вся фаза падает                                 | `E_DISK_FULL`        |
| HEAD `apps/source` не читается, `.git` прогона присутствует | прогон `failed` (проверить чужой `.git` нечем — не значит "здоров"), остальные прогоны и фаза продолжают | `E_WORKTREE_BROKEN` |
| `git add` / `diff` / `diff --numstat` упал          | прогон `failed`, фаза продолжает                | `E_WORKTREE_BROKEN`  |
| То же с ENOSPC-сигнатурой в stderr                   | вся фаза падает (полный диск — не прогонная проблема) | `E_DISK_FULL` |
| Протухший `destDir/.git/index.lock` от убитого процесса агента | не мешает: фаза стейджит во временный `GIT_INDEX_FILE`, не в собственный index прогона | — |
| Нет места писать `full.patch` / `summary.json` / `variant.html` | throw, вся фаза падает                | `E_DISK_FULL`        |
| Очень большой diff (>10MB)                          | пишем как есть, warning в логе                  | —                    |
| Бинарный файл в diff                                | `additions: 0, deletions: 0` в `perFile` (нет отдельного поля `binary`) | — |
| Untracked/удалённые файлы (агент)                   | попадают в diff через `git add -A`              | —                    |
| `--protect-git`: `vt.apps`/`vt.gitDirs` разной длины (недостижимо сегодня) | вся фаза падает раньше первого прогона этого варианта, ни один прогон не "проваливается" в обычный recovery | `E_WORKTREE_BROKEN` |
| Закоммиченный, но теперь игнорируемый файл (`dist/`, лок-файл), рядом с ним меняется другой файл | `read-tree HEAD` в шаге 2.d предзаполняет временный индекс — файл не показывается как удалённый | — |
| `apps/source` без единого коммита (unborn), рабочее дерево не тронуто | `noChanges = true`, `state: "ok"` (не `"failed"`)  | —                    |
| `apps/source` unborn, у `destDir` появился коммит (агент закоммитил) | расценивается как чужой `.git`, `state: "git-replaced"` | — |
| Подготовка каталога `apps/agent-git/…` (`ensureDir`) упала | прогон `failed`, фаза продолжает                | `E_WORKTREE_BROKEN`  |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: агент модифицировал 2 файла (любой вариант) → `fullPatch`
  непустой, `summary` содержит `filesChanged: 2`, `noChanges = false`.
- ✅ N-way: 3 варианта × 2 прогона → `diffs.length === 3`, каждая запись —
  свои 2 `DiffRunResult`; сломанный прогон в одном варианте не влияет на
  остальные варианты (изоляция по `(variant, runIndex)`).
- ✅ no changes / html generated / html skipped / disk full / untracked files
  / binary file — как раньше, атрибутировано `variant`.
- ✅ восстановление `.git` / сбой восстановления / ENOSPC / агент `git init`
  / агент закоммитил / сбой переноса при замене / HEAD `apps/source` не
  читается — все сценарии, как в v1, теперь per variant.
- ✅ один сломанный прогон не валит остальные: при 3 вариантах × 3 прогона,
  один прогон одного варианта с `state: "failed"` не мешает остальным
  прогонам ни этого, ни других вариантов.
- ✅ протухший index.lock / временный index не задевает собственный index —
  без изменений.
- ✅ `--protect-git`, `gitDirs` короче `apps` для одного варианта → диффы
  этого варианта падают раньше первого прогона, `error.code
  E_WORKTREE_BROKEN`, `reason: "git-dirs-count-mismatch"`; другие варианты
  не затронуты.
- ✅ md/html-рендер: `state: "failed"` рендерится без ссылок на патч; отсутствие
  поля `state` рендерится как `"ok"` (v1-совместимость).
- ❌ НЕ покрыто (ticket): семантический diff (AST-level) вместо текстового.

## 7. Инварианты

- Для каждой пары `(variant, n)` **кроме `state: "failed"`** существует
  `diff/<variant>/run-<n>/full.patch` и `summary.json`. Для `"failed"` под
  этим путём не пишется ничего.
- `DiffRunResult.noChanges === true` ⇔ `fullPatch` пустой — инвариант
  ограничен прогонами с `state !== "failed"`.
- Если `runInput.diffHtml = true`, для каждой пары со `state !== "failed"`
  `DiffRunResult.htmlPath` задан.
- Диффы изолированы по парам `(variant, runIndex)`: diff одного прогона не
  зависит от другого; сбой одного прогона (`E_WORKTREE_BROKEN`) не влияет на
  другие прогоны того же или другого варианта.
- `DiffSummary.perFile` суммы `additions` + `deletions` согласованы с
  `git diff --stat`.
- `state` отсутствует только в `report.json`, записанных до появления этого
  поля; в любом отчёте, написанном текущей фазой, `state` всегда явно задан.

## 8. Зависимости от других фаз

- Зависит от: **02 repo-clone** (рабочие деревья с `.git`, `workspace.variantTrees`),
  **06 run-side** (агент должен был модифицировать дерево; diff пустой, если не модифицировал).
- Блокирует: **09 judge** (судье нужны `fullPatch` каждого варианта),
  **11 report-render** (Diff summary и файловые дельты в Secondary metrics
  рендерятся из `DiffSummary` этой фазы).
- Параллелизуется с: **07 aggregate**, **09 judge** — все три читают независимые
  артефакты фазы 06.
