# Фаза 04: home-isolation

> Спека фазы. Контракт = `contract/phases/04-home-isolation.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Собрать для каждой пары `(side, n)` изолированный HOME (`home/<side>/run-N/`)
с минимальным opencode-конфигом, скопировать auth по whitelist, применить pack
(симлинки/файлы/plugin/mcp-блок) на стороне **new** и сгенерировать два блока
`OPENCODE_CONFIG_CONTENT` — `baseline` для old и `new` для new.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.HomeIsolation` (см.
`contract/phases/04-home-isolation.tsp`).

- Вход: `HomeIsolationInput` — `{ runInput: RunInput, manifest: Manifest,
  workspace: WorkspaceTree, packInstall?: PackInstallResult }`. Опциональное
  поле `packInstall` — результат фазы 03 (явная связь pack-install →
  home-isolation); фаза 04 применяет pack на стороне **new** по
  `packInstall.detectedType` и `packInstall.registeredIn`. Поле отсутствует в
  smoke-test режиме (`packRef` не задан) — тогда фаза генерирует идентичные
  конфиги для обеих сторон.
- Выход: `HomeIsolationResult` — `{ homeTrees: { old: HomeTree[]; new:
  HomeTree[] }, envVars: EnvVarSet[][], generatedConfigs: { baseline: string;
  new: string } }`:
  - `homeTrees` — по одному `HomeTree` (поля `basePath`, `structure[]`,
    `copiedAuth[]`) на каждый run-N, отдельно для `old` и `new`.
  - `envVars` — двумерный массив `EnvVarSet` с осями
    `[side: 0=old, 1=new][runIndex-1]`, один набор переменных окружения на
    каждую пару `(side, n)`. `EnvVarSet`: `HOME`,
    `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`,
    `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_PURE`, опциональный
    `OPENCODE_CONFIG_CONTENT`.
  - `generatedConfigs.baseline` — строка с `OPENCODE_CONFIG_CONTENT` для old
    (pure-baseline).
  - `generatedConfigs.new` — строка с `OPENCODE_CONFIG_CONTENT` для new
    (включает mcp-блок, если pack — mcp).
- Ошибки: `@error HomeIsolationError` — `{ code, message, context? }`, где
  `code` принимает только значения:
  - `E_HOME_SETUP_FAILED` — нельзя создать структуру HOME, нет прав на
    symlink/запись, ROFS, либо pack ссылается на `pack/<name>/`, которого нет.
  - `E_AUTH_MISSING` — нет вообще никакого auth (ни `~/.opencode/`, ни
    provider-конфигов), preflight auth-ping всё равно упадёт.
  - `E_DOCKER_FAILED` — `runInput.isolation === "docker"` и подготовка
    docker-контейнера завершилась ошибкой (v0.3; в v0.1 фаза работает только в
    home-mode).
  - `E_PACK_INSTALL_TIMEOUT` — `opencode plugin <name>` превысил
    `runInput.timeouts.installSeconds` (только для `detectedType = "plugin"`).
  - `E_PACK_INSTALL_FAILED` — `opencode plugin <name>` упал с non-zero exit
    или иной ошибкой установки (только для `detectedType = "plugin"`).

`EnvVarSet` для `old` дополнительно выставляет
`OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`,
`OPENCODE_PURE=1`; для `new` эти pure-baseline флаги сняты.

## 3. Шаги алгоритма

1. Для каждой пары `(side, n)`, `side ∈ {old, new}`, `n ∈ 1..runs`:
   a. Вычислить `homeDir = workspace.homeOld[n-1]` (или `homeNew[n-1]`) и
      создать структуру:
      ```
      <homeDir>/
      ├── .config/opencode/{skills,agents,plugins,command}/   # пустые
      ├── .opencode/                                           # auth
      ├── .cache/opencode/
      └── .local/share/opencode/
      ```
      Сбой `mkdir` → throw
      `HomeIsolationError({ code: "E_HOME_SETUP_FAILED", context: { side, n, reason: "mkdir-failed" } })`.
   b. Скопировать auth по whitelist. **Базовый whitelist** (всегда, если
      источник существует), согласно `runInput.auth` (`AuthWhitelist`):
      - `opencode` → `~/.opencode/` → `<homeDir>/.opencode/` (opencode auth).
      - `npmrc` → `~/.npmrc` → `<homeDir>/.npmrc` (для npm-based pack-ов).
      - `anthropic` → `~/.config/anthropic/`, `openai` → `~/.config/openai/`,
        `gemini` → `~/.config/gemini/` → аналогично в
        `<homeDir>/.config/<provider>/`.
      **Расширяемый whitelist** (дополнительные флаги):
      - `aws` → `~/.aws/` → `<homeDir>/.aws/`
      - `ssh` → `~/.ssh/` → `<homeDir>/.ssh/`
      - `git` → `~/.gitconfig` → `<homeDir>/.gitconfig`
      Если запрошенный в whitelist ресурс отсутствует на хосте → warning в
      лог, продолжаем без него. Но если **все** auth-источники отсутствуют
      (нет `~/.opencode/`, нет provider-конфигов) → throw
      `HomeIsolationError({ code: "E_AUTH_MISSING", context: { side, n } })`,
      потому что preflight auth-ping всё равно упадёт.
2. Применить **pack** (только для `side = new`, читая `input.packInstall` —
   `PackInstallResult` из контрактного Input; в smoke-test режиме поле
   отсутствует и шаг пропускается):
   - `detectedType = "skill"` → создать
     `<homeDir>/.config/opencode/skills/<name>` → `pack/<name>/`.
   - `detectedType = "agent" | "command"` → скопировать файл в
     `<homeDir>/.config/opencode/<agents|command>/<name>.md`.
    - `detectedType = "plugin"` → запустить
      `HOME=<homeDir> opencode plugin <name>` с таймаутом
      `runInput.timeouts.installSeconds`. Команда ставит пакет в
      `<homeDir>/.config/opencode/plugins/`. Таймаут → throw
      `E_PACK_INSTALL_TIMEOUT`; non-zero exit / иной сбой → throw
      `E_PACK_INSTALL_FAILED`. Результат (exit code, длительность) дописать в
      `results/install.log`.
   - `detectedType = "mcp"` → сохранить блок для вставки в `generatedConfigs.new`.
   Существующий symlink/файл перезаписывается. Сбой symlink (ROFS) →
   `E_HOME_SETUP_FAILED`.
   Для `side = old` pack **не применяется** — pack там отсутствует.
3. Сгенерировать `generatedConfigs.baseline` — `OPENCODE_CONFIG_CONTENT` для
   old:
   - минимальный `opencode.json` с одним агентом `build` по стандартному
     шаблону оркестратора;
   - пустые секции `skills`, `agents`, `plugins`, `command`, `mcp`.
   Сериализация через `JSON.stringify` (stable keys).
4. Сгенерировать `generatedConfigs.new` — то же, что baseline, плюс:
   - для plugin: ничего дополнительно (pack уже установлен в
     `home/new/run-N/.config/opencode/plugins/`);
   - для mcp: вставить блок из инструкции в секцию `mcp`;
   - для skill/agent/command: ничего дополнительно в конфиге не нужно
     (видимость через файлы/симлинки).
5. Собрать `EnvVarSet` для каждой пары (см. секцию 2). На каждую пару — один
   `EnvVarSet`; все наборы собираются в двумерный массив `envVars[side][run]`.
6. Вернуть `HomeIsolationResult { homeTrees, envVars, generatedConfigs }`.

## 4. Входные/выходные файлы

| Файл / каталог                                    | Чтение/Запись | Схема (TypeSpec/Zod) |
| ------------------------------------------------- | ------------- | -------------------- |
| `home/<side>/run-<n>/`                            | Запись        | структура HOME       |
| `home/<side>/run-<n>/.config/opencode/{...}/`     | Запись        | пустые + pack на new |
| `home/<side>/run-<n>/.opencode/`                  | Запись        | копия `~/.opencode/` |
| `config/baseline.json`                            | Запись        | `OpenCodeConfig`     |
| `config/new.json`                                 | Запись        | `OpenCodeConfig`     |

`generatedConfigs.baseline` и `generatedConfigs.new` — это **строки** (содержимое
`OPENCODE_CONFIG_CONTENT`), они же пишутся как `config/baseline.json` и
`config/new.json` для отладки и для review-workspace.

## 5. Edge-cases и ошибки

| Кейс                                                       | Поведение                                       | Код                       |
| ---------------------------------------------------------- | ----------------------------------------------- | ------------------------- |
| `~/.opencode/` существует, но пустой                       | Копируем как есть, не fail                      | —                         |
| Запрошен `--aws`, но `~/.aws` нет                          | warning, продолжаем без него                    | —                         |
| Нет вообще никакого auth (ни opencode, ни provider)        | fail (preflight всё равно упадёт)               | `E_AUTH_MISSING`          |
| `--ssh` и приватный pack, но ключ не подходит              | не падает здесь — упадёт в фазе 03 clone        | — (через 03)              |
| symlink создать нельзя (ROFS / нет прав)                   | fail                                            | `E_HOME_SETUP_FAILED`     |
| pack ссылается на `pack/<name>/`, которого нет             | fail                                            | `E_HOME_SETUP_FAILED`     |
| plugin install (kind: plugin) превысил таймаут             | fail прогона                                    | `E_PACK_INSTALL_TIMEOUT`  |
| plugin install (kind: plugin) упал с non-zero exit         | fail прогона                                    | `E_PACK_INSTALL_FAILED`   |
| `isolation = "docker"`, подготовка контейнера упала (v0.3) | fail прогона                                    | `E_DOCKER_FAILED`         |
| smoke-test: pack отсутствует                               | new-сторона получает ту же конфигурацию, что old| —                         |
| Повторный запуск с тем же runId (idempotent)               | пересоздаём структуру, перезаписываем           | —                         |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: `runs = 2`, есть `~/.opencode/` → 4 HOME-каталога, в каждом
  `.opencode/` скопирован; `generatedConfigs.baseline` и
  `generatedConfigs.new` валидны как JSON.
- ✅ pack symlink (`detectedType = "skill"`): создан
  `home/new/run-1/.config/opencode/skills/<name>` → `pack/<name>/`, symlink
  разыменовывается.
- ✅ pack file (`detectedType = "agent"`): файл скопирован в
  `home/new/run-1/.config/opencode/agents/<name>.md`.
- ✅ pack plugin (`detectedType = "plugin"`): запускается
  `HOME=home/new/run-1 opencode plugin <name>`, в
  `home/new/run-1/.config/opencode/plugins/` появляется модуль, в
  `results/install.log` — запись об успехе.
- ✅ plugin install failure: муляж `opencode plugin` exit 1 → throw
  `E_PACK_INSTALL_FAILED`.
- ✅ docker isolation failure (v0.3): `isolation = "docker"`, подготовка
  контейнера упала → throw `E_DOCKER_FAILED`.
- ✅ old не имеет pack: после фазы в `home/old/run-*/.config/opencode/`
  нет pack-файлов, `skills/` пустой.
- ✅ env composition: для old `EnvVarSet` содержит `OPENCODE_PURE=1`,
  `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`; для new они сняты.
- ✅ whitelist aws missing: `--aws`, но `~/.aws` нет → warning в логах, HOME
  создан без `.aws`, не fail.
- ✅ no auth at all: отсутствуют `~/.opencode/` и все provider-конфиги →
  throw `E_AUTH_MISSING`.
- ✅ smoke-test: pack отсутствует → new-сторона получает структуру,
  идентичную old (кроме pure-baseline флагов).
- ✅ symlink failure ROFS: целевая FS read-only → throw `E_HOME_SETUP_FAILED`.
- ❌ НЕ покрыто (ticket): изоляция под macOS с sandbox-exec (v0.3).
- ❌ НЕ покрыто (ticket): docker-isolation happy-path (v0.3) — здесь только
  home-mode.

## 7. Инварианты

- После фазы для **каждой** пары `(side, n)` существует полный HOME-скелет с
  пустыми `.config/opencode/{skills,agents,plugins,command}/`.
- Для `side = old`: pack **отсутствует** в любых подкаталогах
  `home/old/run-N/.config/opencode/` (проверяется фазой 05).
- Для `side = new`: pack **виден** — либо symlink/файл в
  `.config/opencode/...`, либо установлен в `plugins/` (plugin-тип), либо
  зарегистрирован в `generatedConfigs.new` (mcp).
- `envVars[side][n-1]` (`EnvVarSet`) содержит `HOME`,
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_CONFIG_CONTENT`. Для old
  добавлены pure-baseline флаги.
- Whitelist копируется идентично во все `home/<side>/run-N/` (детерминизм
  auth-состояния между прогонами).

## 8. Зависимости от других фаз

- Зависит от: **01 workspace-setup** (`Manifest`, `WorkspaceTree.homeOld`,
  `WorkspaceTree.homeNew`), **03 pack-install** (`PackInstallResult` для
  применения pack — передаётся через опциональное поле `packInstall` в
  контрактном `HomeIsolationInput`; без него это smoke-test).
- Блокирует: **05 preflight** (preflight проверяет HOME-структуру и
  pack-visibility), **06 run-side** (нужны `envVars` и пути для запуска
  агента).
- Параллелизуется с: — (исполняется после 02+03, точка схода перед preflight).
