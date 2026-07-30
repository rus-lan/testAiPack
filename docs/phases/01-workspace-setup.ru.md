# Фаза 01: workspace-setup

> Спека фазы. Контракт = `contract/phases/01-workspace-setup.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Создать `.testaipack/<run-id>/` — изолированный каталог прогона со всем
скелетом поддиректорий, сгенерировать `manifest.json` и вернуть кортеж
`(Manifest, WorkspaceTree)` — метаданные прогона и абсолютные пути к
поддиректориям, которые пробрасываются через все оставшиеся фазы.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.WorkspaceSetup` (см.
`contract/phases/01-workspace-setup.tsp`).

- Вход: `WorkspaceSetupInput` — `{ runInput: RunInput, runId: string }`.
  `runId` формируется вызывающей стороной (cli-parse или оркестратор) и
  передаётся уже готовым.
- Выход: `WorkspaceSetupResult` — `{ manifest: Manifest, rootPath: string,
  treePaths: WorkspaceTree }`:
  - `manifest` — объект `Manifest` (он же сериализуется в `manifest.json`).
  - `rootPath` — абсолютный путь к `.testaipack/<run-id>/`.
  - `treePaths` — объект `WorkspaceTree` с абсолютными путями ко всем
    поддиректориям скелета: `root`, `appsSource`, `appsOld[]`, `appsNew[]`,
    `pack`, `homeOld[]`, `homeNew[]`, `gitDirsOld[]`, `gitDirsNew[]`, `config`,
    `results`, `raw`, `diff`. `gitDirsOld`/`gitDirsNew` — пути под `gitdirs/`,
    заполняются всегда (как планируемые пути run-N), но каталоги на диске
    появляются только при `--protect-git` (фаза 02 переносит туда `.git`,
    см. `docs/phases/02-repo-clone.ru.md`).
- Ошибки: `@error WorkspaceSetupError` — `{ code, message, reason?, path?,
  context? }`, где `code` всегда `"E_HOME_SETUP_FAILED"` (других кодов фаза не
  имеет). `reason` ∈ `{ "already-exists", "not-a-directory", "mkdir-failed",
  "write-failed" }` уточняет причину.

`Manifest` (пишется как `manifest.json`):

```jsonc
{
  "runId": "2026-07-21_17-05-13_a1b2c3",
  "timestamp": "2026-07-21T17:05:13+03:00",
  "repoUrl": "...",
  "packRef": "... | null",
  "packType": "skill | plugin | ... | auto",
  "prompt": "...",
  "init": "... | null",
  "verify": "... | null",
  "runs": 3,
  "isolation": "home",
  "opencodeVersion": "1.2.3 | null",
  "flagDefaults": {
    "dockerDowngraded": false
    /* снимок всех не-обязательных флагов и их source (cli/config/default) */
  }
}
```

`opencodeVersion` — либо `runInput.opencodeVersion` (флаг `--opencode-version`, чистая
метка прогона, ничего не переключает), либо результат пробы `opencode --version`. При
`runInput.isolation === "docker"` проба выполняется **внутри того же docker-образа**,
который фаза 04 использует для самих прогонов (`input.dockerImage ?? DEFAULT_OPENCODE_IMAGE`)
— иначе в манифест попадает версия хостового бинаря, которая может не совпадать с версией,
реально закреплённой в образе (`Dockerfile.opencode` `ARG OPENCODE_VERSION`). Проба
best-effort с таймаутом 5s: недоступный образ или ошибка пробы → `opencodeVersion =
"unknown"`, фаза не падает.

## 3. Шаги алгоритма

1. `runId` приходит на вход уже сформированным (`WorkspaceSetupInput.runId`).
2. Вычислить `rootPath = path.resolve(runInput.workspacePath, runId)`. Если
   `runInput.workspacePath` относительный — относительно `cwd` процесса.
3. Если `rootPath` уже существует и не пуст → throw
   `WorkspaceSetupError({ code: "E_HOME_SETUP_FAILED", reason: "already-exists",
   path: rootPath })` (защита от коллизии run-id).
4. Создать дерево каталогов (одним проходом `fs.mkdir(..., { recursive: true })`):

   ```
   <rootPath>/
   ├── apps/source/
   ├── apps/oldVersion/
   ├── apps/newVersion/
   ├── pack/
   ├── home/old/
   ├── home/new/
   ├── gitdirs/old/
   ├── gitdirs/new/
   ├── config/
   └── results/raw/old/
       results/raw/new/
       results/diff/old/
       results/diff/new/
   ```
   На этом этапе `apps/*/run-N/` и `home/*/run-N/` **не** создаются — их
   создают фазы 02 (repo-clone) и 04 (home-isolation) соответственно.
   Любой сбой `mkdir` → throw `E_HOME_SETUP_FAILED` с `reason: "mkdir-failed"`.

   Побочный эффект пробы версии (следующий шаг): сам бинарь opencode при
   `opencode --version` создаёт под переданным `HOME=<config>` свой XDG-скелет
   (`config/.config/opencode/`, `.cache/opencode/`, `.local/share/opencode/`) —
   пустой, потому что `--version` завершается раньше, чем opencode доходит до
   загрузки конфига. Это не мёртвый код и не бага — `config/.config/opencode/`
   позже заполняется фазой 06 (`captureOpencodeConfig`, см.
   `docs/phases/06-run-side.ru.md`, раздел 9), которая переиспользует этот же
   путь как место снимка эффективного конфига и зависимостей.
5. Сериализовать `Manifest` в `<rootPath>/manifest.json` (pretty-print,
   stable key order). Сбой записи → `E_HOME_SETUP_FAILED` с `reason:
   "write-failed"`. Если `rootPath` оказался файлом, а не каталогом → `reason:
   "not-a-directory"`.
6. Заполнить `WorkspaceTree` абсолютными путями: `appsOld = [<rootPath>/
   apps/oldVersion/run-1, …, run-<runs>]` и аналогично `appsNew`, `homeOld`,
   `homeNew` (на этом шаге это только планируемые пути — каталогов run-N ещё
   нет; фазы 02/04 их создадут и будут использовать эти записи).
7. Обновить корневой `.gitignore` проекта: добавить строку `<basename
   workspaceDir>/` (basename реальной директории `runInput.workspacePath` —
   по умолчанию `.testaipack/`, но для `--workspace foo` это будет `foo/`, а
   не хардкод `.testaipack/`), если её ещё нет. Файл `.gitignore` создаётся
   при отсутствии. Ошибка записи gitignore — warning, не фейлит прогон
   (workspace уже работает).
8. Вернуть `WorkspaceSetupResult { manifest, rootPath, treePaths }`.

**Дополнительные артефакты рядом с `manifest.json`, не принадлежащие этой
фазе.** Оркестратор (`runPipeline`, `src/cli/pipeline.ts`) — не сама фаза 01
— пишет в `rootPath` ещё два файла post-mortem/rebuild-назначения, оба
best-effort (сбой записи — warning, прогон не падает):
- `run-input.json` — итоговый (resolved) `RunInput`, каким его реально
  использует прогон (`outputPath` уже разрешён относительно `--output`),
  записывается сразу после того, как этот `RunInput` собран, перед фазой 02.
  Редактируются те же два поля, что и в `Manifest` (`repoUrl`, `packRef`) —
  см. `redactRunInput` в `src/cli/pipeline.ts`.
- `error.json` — сериализованный `PhaseError` (`serializePhaseError`,
  `src/errors.ts`), пишется, если прогон падает на любой фазе ≥ 02 (через
  `Effect.tapError` вокруг всего, что идёт после фазы 01). Падение самих фаз
  00/01 — записывать `error.json` некуда (`rootPath` ещё не создан или
  вызывающая сторона о нём не знает), поведение как раньше: только
  scrollback.

## 4. Входные/выходные файлы

| Файл                       | Чтение/Запись | Схема (TypeSpec/Zod) |
| -------------------------- | ------------- | -------------------- |
| `<workspaceRoot>/manifest.json` | Запись   | `Manifest`           |
| `<workspaceRoot>/run-input.json` | Запись (оркестратором, не фазой 01) | `RunInput` |
| `<workspaceRoot>/error.json` | Запись (оркестратором, при падении фазы ≥ 02) | `PhaseError` (`SerializedPhaseError`) |
| `.gitignore` (в корне cwd) | Чтение+Запись | текст, `<basename workspaceDir>/` добавляется один раз |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                         | Код                  |
| --------------------------------------------------- | ------------------------------------------------- | -------------------- |
| `workspaceRoot` уже существует и пуст               | Переиспользуем (idempotent)                       | —                    |
| `workspaceRoot` уже существует и не пуст            | Fail прогона                                      | `E_HOME_SETUP_FAILED`|
| Нельзя создать каталог (ROFS / нет прав)            | Fail прогона                                      | `E_HOME_SETUP_FAILED`|
| `config.workspace` указывает на файл, не каталог    | Fail прогона                                      | `E_HOME_SETUP_FAILED`|
| Коллизия run-id (крайне маловероятно)               | Fail прогона с явным сообщением                   | `E_HOME_SETUP_FAILED`|
| `.gitignore` уже содержит `<basename workspaceDir>/` | Не дублируем                                     | —                    |
| `.gitignore` не существует                          | Создаём с одной строкой `<basename workspaceDir>/` | —                   |
| `.gitignore` нельзя записать                        | Warning, прогон продолжается                      | —                    |
| `--workspace foo` (не `.testaipack`)                | В `.gitignore` пишется `foo/`, а не `.testaipack/` | —                    |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: пустой `cwd`, `runInput.workspacePath = "./.testaipack"` →
  создаётся скелет, `manifest.json` соответствует Zod-схеме `Manifest`,
  `.gitignore` пополняется строкой `.testaipack/`, `WorkspaceSetupResult`
  содержит `manifest`, `rootPath` и заполненный `treePaths`.
- ✅ custom workspace name: `runInput.workspacePath` указывает на каталог
  `myworkspace` (не `.testaipack`) → `.gitignore` пополняется строкой
  `myworkspace/`, не `.testaipack/`.
- ✅ run-id формат (если генерируется вызывающей стороной): регулярка
  `^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}$`.
- ✅ idempotent empty dir: повторный запуск с тем же `runId` поверх пустого
  `rootPath` не падает.
- ✅ non-empty dir: существующий непустой `rootPath` → throw
  `E_HOME_SETUP_FAILED` с `reason: "already-exists"`.
- ✅ path is a file: `runInput.workspacePath` указывает на файл → throw
  `E_HOME_SETUP_FAILED` с `reason: "not-a-directory"`.
- ✅ gitignore dedup: в `.gitignore` уже есть `.testaipack/` → повторного
  добавления нет, остальные строки сохранены.
- ✅ gitignore missing: `.gitignore` не существует → создаётся с единственной
  строкой.
- ✅ gitignore uses actual entry: `updateGitignore` вызывается с записью,
  вычисленной из `path.basename(workspaceDir)`, а не с зашитым по умолчанию
  значением.
- ❌ НЕ покрыто (ticket): создание каталогов на сетевой FS с race-condition
  между `stat` и `mkdir` (отдельный ticket по сетевой FS).

## 7. Инварианты

- После фазы `rootPath` существует и содержит ровно скелет выше.
- `manifest.json` валиден по Zod-схеме `Manifest` и содержит snapshot всех
  опций прогона (достаточно для `testaipack report <run-id>` без повторного
  парсинга CLI).
- `WorkspaceTree` содержит абсолютные пути ко всем поддиректориям скелета;
  записи `appsOld/appsNew/homeOld/homeNew` — это **планируемые** пути run-N
  (сами каталоги создаются фазами 02 и 04).
- `.gitignore` проекта содержит `<basename workspaceDir>/` — фактическое имя
  используемой рабочей директории, а не всегда `.testaipack/` (если только
  не было ошибки записи — тогда warning в логах, но инвариант ослаблен).
- `runId` глобально уникален в пределах машины на момент создания (timestamp +
  6 hex с энтропией ≈ 16 млн на секунду).

## 8. Зависимости от других фаз

- Зависит от: **00 cli-parse** (получает `RunInput`).
- Блокирует: **02 repo-clone**, **03 pack-install** (обеим нужны `Manifest` и
  `WorkspaceTree` с путями); через них — все остальные фазы.
- Параллелизуется с: — (точка схода перед 02/03, сама по себе не параллелится).
