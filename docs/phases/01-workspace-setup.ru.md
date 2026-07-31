# Фаза 01: workspace-setup

> Спека фазы. Контракт = `contract/phases/01-workspace-setup.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Создать `.testaipack/<run-id>/` — изолированный каталог прогона со всем
скелетом поддиректорий **для каждого варианта**, сгенерировать `manifest.json`
и вернуть кортеж `(Manifest, WorkspaceTree)` — метаданные прогона и абсолютные
пути к поддиректориям, которые пробрасываются через все оставшиеся фазы.

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
  - `treePaths` — объект `WorkspaceTree`: `{ root, appsSource, pack, config,
    results, raw, diff, variantTrees: VariantTree[] }`. `variantTrees` — по
    одной записи `{ name, apps: string[], homes: string[], gitDirs: string[] }`
    на КАЖДЫЙ вариант эксперимента, в порядке конфига; каждый массив содержит
    `runs` путей (`run-1`…`run-N`). `gitDirs` заполняется всегда (как
    планируемые пути run-N), но каталоги на диске появляются только при
    `--protect-git` (фаза 02 переносит туда `.git`, см.
    `docs/phases/02-repo-clone.ru.md`).
- Ошибки: `@error WorkspaceSetupError` — `{ code, message, reason?, path?,
  context? }`, где `code` всегда `"E_HOME_SETUP_FAILED"` (других кодов фаза не
  имеет). `reason` ∈ `{ "already-exists", "not-a-directory", "mkdir-failed",
  "write-failed" }` уточняет причину.

`Manifest` (v2, пишется как `manifest.json`):

```jsonc
{
  "schemaVersion": 2,
  "runId": "2026-07-21_17-05-13_a1b2c3",
  "timestamp": "2026-07-21T17:05:13+03:00",
  "repoUrl": "...",
  "prompt": "... (глобальный дефолт, опционален)",
  "init": "... (опционален)",
  "hint": "... (опционален)",
  "verify": "... (опционален)",
  "runs": 3,
  "parallel": 2,
  "baseline": "old",
  "packs": [{ "name": "graphify", "ref": "https://...", "type": "skill" }],
  "variants": [
    { "name": "old", "packs": [], "pure": true },
    { "name": "new", "packs": ["graphify"], "pure": false }
  ],
  "isolation": "home",
  "opencodeVersion": "1.2.3 | \"unknown\"",
  "flagDefaults": {
    "dockerDowngraded": false,
    "configSource": "cli",
    "parallel": 2,
    "baseline": "old",
    "legacyShim": true
  }
}
```

`packs`/`variants` в манифесте — provenance-копии `RunInput.packs`/`variants`:
каждый `PackSpec.ref` редактируется тем же способом, что раньше применялся к
`packRef` (`redactUrlCredentials` + `safeRefDisplay`); текст per-variant
`prompt`/`init`/`hint` сохраняется как есть (verbatim), как раньше сохранялся
глобальный `init`.

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
4. Вычислить пути через `buildTreePaths(rootPath, runInput.runs, variantNames,
   2)` — чистая функция, реализующая раскладку каталогов (`variantNames =
   runInput.variants.map(v => v.name)`, порядок конфига). Для `schemaVersion:
   2` раскладка на КАЖДЫЙ вариант `<name>`:

   ```
   <rootPath>/
   ├── apps/source/                       # один клон-шаблон (общий для всех вариантов)
   ├── apps/<name>/run-{1..N}/            # рабочие копии варианта <name>
   ├── pack/                              # реестр паков; подпапки создаёт фаза 03
   ├── home/<name>/run-{1..N}/            # изолированные HOME варианта <name>
   ├── gitdirs/<name>/run-{1..N}/         # перенесённый .git, только при --protect-git
   ├── config/                            # сгенерированные opencode.json на вариант
   └── results/
       raw/<name>/                        # opencode export по прогонам варианта
       diff/<name>/                       # git-diff по прогонам варианта
   ```

   Число вариантов — не 2, а `runInput.variants.length` (обычно 2 в
   legacy-шиме, но variant-режим допускает произвольное N). `apps/<name>`,
   `home/<name>`, `gitdirs/<name>`, `raw/<name>`, `diff/<name>` **не** создают
   `run-N/`-поддиректории на этом шаге (их создают фазы 02/04 соответственно)
   — сама базовая директория на вариант создаётся здесь безусловно (одинаково
   для всех вариантов, независимо от флагов), только `run-N/` внутри неё —
   позже. Любой сбой `mkdir` → throw `E_HOME_SETUP_FAILED` с `reason:
   "mkdir-failed"`.

   Побочный эффект пробы версии (следующий шаг): сам бинарь opencode при
   `opencode --version` создаёт под переданным `HOME=<config>` свой XDG-скелет
   (`config/.config/opencode/`, `.cache/opencode/`, `.local/share/opencode/`) —
   пустой, потому что `--version` завершается раньше, чем opencode доходит до
   загрузки конфига. Это не мёртвый код и не бага — `config/.config/opencode/`
   позже заполняется фазой 06 (`captureOpencodeConfig`, см.
   `docs/phases/06-run-side.ru.md`, раздел 9), которая переиспользует этот же
   путь как место снимка эффективного конфига и зависимостей — теперь один
   подкаталог на каждый вариант, `config/.config/opencode/<name>/`.
5. Сериализовать `Manifest` в `<rootPath>/manifest.json` (pretty-print,
   stable key order). Сбой записи → `E_HOME_SETUP_FAILED` с `reason:
   "write-failed"`. Если `rootPath` оказался файлом, а не каталогом → `reason:
   "not-a-directory"`.
6. Заполнить `WorkspaceTree.variantTrees`: по одному `VariantTree { name,
   apps, homes, gitDirs }` на вариант — `apps`/`homes`/`gitDirs` содержат
   `runs` **планируемых** путей (сами `run-N/`-каталоги ещё не созданы; фазы
   02/04 их создадут и будут использовать эти записи).
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
- `run-input.json` — итоговый (resolved) `RunInput` (v2, `schemaVersion: 2`),
  каким его реально использует прогон (`outputPath` уже разрешён относительно
  `--output`), записывается сразу после того, как этот `RunInput` собран,
  перед фазой 02. Редактируются те же поля, что и в `Manifest` (`repoUrl`,
  каждый `packs[*].ref`) — см. `redactRunInput` в `src/cli/pipeline.ts`.
- `error.json` — сериализованный `PhaseError` (`serializePhaseError`,
  `src/errors.ts`), пишется, если прогон падает на любой фазе ≥ 02 (через
  `Effect.tapError` вокруг всего, что идёт после фазы 01). Падение самих фаз
  00/01 — записывать `error.json` некуда (`rootPath` ещё не создан или
  вызывающая сторона о нём не знает), поведение как раньше: только
  scrollback.

### 3.1 v1-совместимость раскладки (`buildTreePaths`, параметр `schemaVersion`)

`buildTreePaths(rootPath, runs, variants, schemaVersion)` — чистая функция
`(rootPath, runs, variantNames, 1 | 2)`, воспроизводящая одну и ту же
раскладку и во время создания workspace (эта фаза, всегда `schemaVersion:
2`), и позже, без обращения к диску (`report --rebuild`, `src/cli/rebuild.ts`
— для v1-воркспейсов с `schemaVersion: 1`). Единственное различие между
версиями — имя каталога `apps/*`:

| | v1 (`schemaVersion: 1`) | v2 (`schemaVersion: 2`) |
|---|---|---|
| `apps/<...>` | `apps/oldVersion`, `apps/newVersion` (хардкод-суффикс `Version`) | `apps/<name>` (имя варианта как есть) |
| `home/<...>` | `home/old`, `home/new` | `home/<name>` |
| `gitdirs/<...>` | `gitdirs/old`, `gitdirs/new` | `gitdirs/<name>` |

`home`/`gitdirs` никогда не несли суффикс `Version` ни в одной версии — рассинхрон
только в `apps/`. Это единственное, что отличает layout свежесозданного v2-воркспейса
(эта фаза) от layout, который `rebuild` реконструирует для workspace, созданного до
появления n-way variants (`.research/n-way-variants/01-contract.md §7`).

## 4. Входные/выходные файлы

| Файл                       | Чтение/Запись | Схема (TypeSpec/Zod) |
| -------------------------- | ------------- | -------------------- |
| `<workspaceRoot>/manifest.json` | Запись   | `Manifest` (v2)       |
| `<workspaceRoot>/run-input.json` | Запись (оркестратором, не фазой 01) | `RunInput` (v2) |
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
| N вариантов (N > 2, variant-режим)                  | По N записей в `variantTrees`, `raw/<name>`, `diff/<name>` — без хардкода на 2 | — |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: пустой `cwd`, `runInput.workspacePath = "./.testaipack"`,
  legacy-шим (2 варианта) → создаётся скелет на оба варианта, `manifest.json`
  соответствует Zod-схеме `Manifest` (v2), `.gitignore` пополняется строкой
  `.testaipack/`, `WorkspaceSetupResult` содержит `manifest`, `rootPath` и
  заполненный `treePaths.variantTrees` (2 записи).
- ✅ N-way: variants `[a, b, c]`, `runs = 2` → 6 app-путей, 6 home-путей, 6
  git-путей, 3 raw-каталога, 3 diff-каталога — по одному на вариант плюс
  общий `apps/source/`; `manifest.json` содержит `packs`/`variants`/`baseline`/
  `parallel`.
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
- ✅ gitignore dedup / missing / uses actual entry — как раньше, без изменений.
- ✅ v1 layout byte-for-byte: `buildTreePaths(root, 2, ['old','new'], 1)`
  воспроизводит дореформенную раскладку (`apps/oldVersion`, `apps/newVersion`,
  `home/old`, `home/new`) — гарантия, на которой стоит `rebuild` для
  workspace старше n-way variants.
- ✅ v2 layout не несёt суффикс `Version`: `buildTreePaths(root, 2, ['old','new'], 2)`
  → `apps/old`, `apps/new` (без `Version`), в отличие от v1.
- ✅ манифест несёт редактированные `ref`: `packs[*].ref` не содержит
  `user:token@` из исходного URL пака.
- ❌ НЕ покрыто (ticket): создание каталогов на сетевой FS с race-condition
  между `stat` и `mkdir` (отдельный ticket по сетевой FS).

## 7. Инварианты

- После фазы `rootPath` существует и содержит ровно скелет выше — на
  КАЖДЫЙ вариант эксперимента, не только на `old`/`new`.
- `manifest.json` валиден по Zod-схеме `Manifest` (v2, `schemaVersion: 2`) и
  содержит snapshot всех опций прогона, включая реестр паков и полный список
  вариантов (достаточно для `testaipack report <run-id>` без повторного
  парсинга CLI).
- `WorkspaceTree.variantTrees` содержит ровно `runInput.variants.length`
  записей, в том же порядке, что и `runInput.variants`; каждая запись несёт
  **планируемые** пути run-N (сами каталоги создаются фазами 02 и 04).
- `.gitignore` проекта содержит `<basename workspaceDir>/` — фактическое имя
  используемой рабочей директории, а не всегда `.testaipack/` (если только
  не было ошибки записи — тогда warning в логах, но инвариант ослаблен).
- `runId` глобально уникален в пределах машины на момент создания (timestamp +
  6 hex с энтропией ≈ 16 млн на секунду).
- `buildTreePaths` — чистая функция без side-effects, детерминированная по
  `(rootPath, runs, variantNames, schemaVersion)`; `rebuild` полагается на
  это, чтобы реконструировать пути без повторного создания workspace.

## 8. Зависимости от других фаз

- Зависит от: **00 cli-parse** (получает `RunInput`, v2).
- Блокирует: **02 repo-clone**, **03 pack-install** (обеим нужны `Manifest` и
  `WorkspaceTree` с путями); через них — все остальные фазы.
- Параллелизуется с: — (точка схода перед 02/03, сама по себе не параллелится).
