# Фаза 02: repo-clone

> Спека фазы. Контракт = `contract/phases/02-repo-clone.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Склонировать тестируемый репозиторий shallow-клоном в `apps/source/`, затем
скопировать его в `apps/{old,new}Version/run-{1..N}/` — по одной идентичной
копии на прогон на сторону. Гарантирует, что обе стороны стартуют с одного и
того же baseline рабочего дерева.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.RepoClone` (см. `contract/phases/02-repo-clone.tsp`).

- Вход: `RepoCloneInput` — `{ runInput: RunInput, manifest: Manifest,
  workspace: WorkspaceTree }`. URL репо, число прогонов и таймауты берутся из
  `runInput` (`runInput.repoUrl`, `runInput.runs`, `runInput.timeouts`).
- Выход: `RepoCloneResult` — `{ sourcePath: string, copyPaths: { old: string[];
  new: string[] }, cloneDurationMs: int64 }`. `sourcePath` — абсолютный путь к
  `apps/source/`. `copyPaths.old` / `copyPaths.new` — массивы абсолютных путей
  к `apps/{old,new}Version/run-{1..N}/` (по элементу на прогон).
- Ошибки: `@error RepoCloneError` — `{ code, message, repoUrl, context? }`, где
  `code` принимает только значения:
  - `E_REPO_TIMEOUT` — `git clone` превысил `runInput.timeouts.installSeconds`.
  - `E_REPO_CLONE_FAILED` — любой другой сбой clone: приватный репо без auth,
    несуществующий URL, повреждённый репо, сетевая ошибка, нет места на диске
    при копировании (`ENOSPC` детализируется в `message`).

  Недиск full здесь не выделен в отдельный код — `ENOSPC` уходит как
  `E_REPO_CLONE_FAILED` с детальным `message`.

## 3. Шаги алгоритма

1. `sourcePath = workspace.appsSource` (абсолютный путь к `apps/source/`).
2. Запустить `git clone --depth 1 <runInput.repoUrl> <sourcePath>` как child
   process с:
   - env, унаследованным от процесса testaipack (чтобы работал ssh-agent);
   - таймаутом `runInput.timeouts.installSeconds` (default 300s);
   - захватом stdout/stderr в буфер.
3. Если процесс превысил таймаут → kill, throw
   `RepoCloneError({ code: "E_REPO_TIMEOUT", repoUrl, context: { timeoutSec } })`.
4. Если exit code ≠ 0 → throw
   `RepoCloneError({ code: "E_REPO_CLONE_FAILED", repoUrl, context: { stderr } })`.
   В тексте ошибки, если stderr содержит `Permission denied (publickey)` или
   `Authentication failed`, добавить подсказку: «используйте `--ssh` / `--git`
   для расширения whitelist credentials (фаза 04)».
5. Проверить, что `<sourcePath>/.git` существует и непустой (защита от
   partial-clone). Если нет → throw
   `RepoCloneError({ code: "E_REPO_CLONE_FAILED", repoUrl, context: { reason: "no .git" } })`.
6. Заполнить `copyPaths` для каждой стороны: `copyPaths.old = workspace.appsOld`
   и `copyPaths.new = workspace.appsNew` (это планируемые пути run-N из
   `WorkspaceTree`). Для каждого пути выполнить `cp -r <sourcePath> <destPath>`
   (или платформенно-эквивалентный рекурсивный copy с сохранением прав и
   `.git/`). На `ENOSPC` → throw `E_REPO_CLONE_FAILED` с `context.reason =
   "disk full"`.
7. Если `runInput.protectGit === true`: для каждого `destPath` перенести
   `destPath/.git` в `<root>/gitdirs/<side>/run-N/` (позиционно из
   `workspace.gitDirsOld[i]` / `gitDirsNew[i]`) через `rename` (одна файловая
   система, без copy+delete fallback). Сбой переноса → throw
   `E_REPO_CLONE_FAILED` с `context.reason = "protect-git-move"`. Шаг
   выполняется **до** детерминизм-проверки, чтобы она проверяла именно
   финальный (перенесённый) layout, а не промежуточное состояние.
8. Детерминизм-проверка (baseline identical): для всех `destPath` посчитать
   `git rev-parse HEAD` и хэш `git ls-files -s`. Без `--protect-git` — обычным
   `git -C <destPath>`. С `--protect-git` — через two-path форму
   `git --git-dir=<gitDirsOld[i]|gitDirsNew[i]> --work-tree=<destPath>`, потому
   что `.git` уже перенесён шагом 7 и внутри `destPath` его больше нет.
   `sourcePath` (`apps/source/`) всегда однопутевой — его `.git` никуда не
   переносится ни при каких флагах. Все значения должны совпадать между собой
   и с `sourcePath`. Если есть расхождение → throw `E_REPO_CLONE_FAILED` с
   `context.reason = "non-deterministic copy"` (сигнал о повреждении при
   копировании).
9. `cloneDurationMs` = измеренное время clone-шага. Вернуть `RepoCloneResult`.

### 7.1 `--protect-git`: `gitdirs/` layout

```
<root>/
├── apps/{old,new}Version/run-N/     # рабочее дерево БЕЗ .git при protectGit
└── gitdirs/{old,new}/run-N/         # перенесённый .git (HEAD, objects/, …)
```

`gitdirs/{old,new}` (пустые базовые каталоги) создаются фазой 01 безусловно
(как `home/{old,new}`), чтобы skeleton не зависел от флага; конкретные
`run-N/` внутри них создаёт сам `rename` в шаге 7 — только для защищённых
прогонов. Каталог не примонтирован в docker (`docker-runner.ts` монтирует
только `apps/<side>Version/run-N` и HOME-дерево) — агент внутри контейнера
физически не видит `gitdirs/`; под `--isolation home` защита слабее (см.
`docs/phases/00-cli-parse.ru.md`, поле `protectGit`).

## 4. Входные/выходные файлы

| Файл / каталог                              | Чтение/Запись | Схема (TypeSpec/Zod) |
| ------------------------------------------- | ------------- | -------------------- |
| `apps/source/`                              | Запись        | git working tree     |
| `apps/{old,new}Version/run-{1..N}/`         | Запись        | копия `apps/source/` |
| `apps/source/.git`                          | Чтение        | валидный git-репо    |
| `gitdirs/{old,new}/run-{1..N}/` (только `--protect-git`) | Запись | перенесённый `.git` |

Фаза не читает метаданных из `raw/` или `results/`.

## 5. Edge-cases и ошибки

| Кейс                                                 | Поведение                                      | Код                    |
| ---------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| `git clone` длится дольше `timeouts.installSeconds`  | kill + fail прогона                            | `E_REPO_TIMEOUT`       |
| приватный репо, нет ssh-ключа / https-токена         | fail + подсказка про `--ssh`/`--git`           | `E_REPO_CLONE_FAILED`  |
| URL не существует (404)                              | fail                                           | `E_REPO_CLONE_FAILED`  |
| `cp -r` падает на `ENOSPC`                           | fail с `context.reason = "disk full"`          | `E_REPO_CLONE_FAILED`  |
| `source/.git` отсутствует после clone                | fail                                           | `E_REPO_CLONE_FAILED`  |
| копии разошлись по HEAD или ls-files                 | fail (non-deterministic copy)                  | `E_REPO_CLONE_FAILED`  |
| `--protect-git`: перенос `.git` в `gitdirs/` упал     | fail, `context.reason = "protect-git-move"`    | `E_REPO_CLONE_FAILED`  |
| `runs = 0` (теоретически, клирится в фазе 00)        | считаем ошибкой контракта                      | `E_REPO_CLONE_FAILED`  |
| shallow-clone привёл к detached HEAD без ветки       | нормально, `rev-parse HEAD` всё равно работает | —                      |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: публичный https-репо, `runs = 2` → `apps/source/` + 4 копии,
  все `rev-parse HEAD` идентичны, все `ls-files -s` хэши равны, `copyPaths`
  заполнены абсолютными путями.
- ✅ clone timeout: муляж команды `git`, который висит дольше
  `timeouts.installSeconds=5` → throw `E_REPO_TIMEOUT`, процесс убит.
- ✅ private repo no auth: муляж с stderr `Permission denied (publickey)` →
  throw `E_REPO_CLONE_FAILED`, `message` содержит подсказку про `--ssh`.
- ✅ disk full на `cp -r`: муляж `cp` с `ENOSPC` → throw `E_REPO_CLONE_FAILED`
  с `context.reason = "disk full"`.
- ✅ non-deterministic copy: одна из копий искусственно повреждена (удалён
  файл) → детерминизм-проверка ловит, throw `E_REPO_CLONE_FAILED`.
- ✅ detached HEAD shallow clone: `rev-parse HEAD` возвращает коммит, проверка
  проходит без ветки.
- ❌ НЕ покрыто (ticket): git LFS-объекты (могут тянуться долго / падать без
  auth) — отдельный ticket про `GIT_LFS_SKIP_SMUDGE`.

## 7. Инварианты

- После фазы `apps/source/` — валидный git-репо с `.git/` и хотя бы одним
  коммитом.
- Все `apps/{old,new}Version/run-N/` существуют и **побайтово идентичны**
  `apps/source/` по трекаемым файлам (одинаковые `HEAD` и одинаковый набор
  `ls-files -s`).
- Каждая `run-N/` копия имеет свою собственную `.git/` (независимые git-репо),
  чтобы последующий `git diff` в фазе 08 работал изолированно.
- `RepoCloneResult.copyPaths` содержит ровно `runs` путей на каждую сторону.
- `sourcePath` не модифицируется после этой фазы (только для чтения в 03+).

## 8. Зависимости от других фаз

- Зависит от: **01 workspace-setup** (`Manifest`, `WorkspaceTree` с путями и
  `runs`).
- Блокирует: **06 run-side** (нужны рабочие деревья, в которых агент будет
  что-то делать), **08 diff** (нужны git-копии для diff после прогона).
- Параллелизуется с: **03 pack-install** (pack-установка не зависит от
  рабочего дерева тестируемого репо).
