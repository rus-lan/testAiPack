# Фаза 04: home-isolation

> Спека фазы. Контракт = `contract/phases/04-home-isolation.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Собрать для **каждой пары `(variant, n)`** изолированный HOME
(`home/<variant>/run-N/`) с минимальным opencode-конфигом, скопировать auth по
whitelist, применить на HOME все паки, объявленные этим вариантом
(`variant.packs`), и сгенерировать по одному блоку `OPENCODE_CONFIG_CONTENT`
**на каждый вариант** (было: два фиксированных блока `baseline`/`new`).

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.HomeIsolation` (см.
`contract/phases/04-home-isolation.tsp`).

- Вход: `HomeIsolationInput` — `{ runInput: RunInput, manifest: Manifest,
  workspace: WorkspaceTree, packInstall?: PackInstallResult }`. Опциональное
  поле `packInstall` — результат фазы 03 (по одной `PackDelivery` на каждый
  пак реестра); отсутствует только когда фаза 03 вообще не вызывалась (тесты)
  или реестр пуст — тогда все варианты получают идентичные конфиги без
  паковых инструкций.
- Выход: `HomeIsolationResult` — `{ homeTrees: VariantHomes[], envVars:
  VariantEnv[], generatedConfigs: VariantConfig[] }`:
  - `homeTrees` / `envVars` / `generatedConfigs` — по одной записи **на
    каждый вариант**, в порядке `runInput.variants`. `VariantHomes = { name,
    trees: HomeTree[] }`, `VariantEnv = { name, envs: EnvVarSet[] }`,
    `VariantConfig = { name, config: string }`. Внутри `trees`/`envs` — по
    `runs` элементов (один на прогон), в порядке run-1..run-N. Это заменяет
    прежний `envVars[side: 0|1][runIndex-1]` — никакой позиционной индексации
    по стороне больше нет нигде в пайплайне.
  - `EnvVarSet`: `HOME`, `OPENCODE_DISABLE_PROJECT_CONFIG`,
    `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`,
    `OPENCODE_PURE`, опциональный `OPENCODE_CONFIG_CONTENT`, опциональный
    `PATH` (см. §3, шаг 6).
  - Каждый `VariantConfig.config` содержит поле `model`, если модель прогона
    определена (см. шаг 3 ниже), и поля `provider`/`small_model`/
    `enabled_providers`/`disabled_providers`, если они заданы у пользователя
    в реальном `~/.config/opencode/opencode.json` — копируются как есть, без
    фильтрации, и **идентично на КАЖДОМ варианте**.
- Ошибки: `@error HomeIsolationError` — `{ code, message, context? }`, где
  `code` принимает только значения:
  - `E_HOME_SETUP_FAILED` — нельзя создать структуру HOME, нет прав на
    symlink/запись, ROFS, либо пак ссылается на `pack/<name>/`, которого нет,
    либо у переданного `WorkspaceTree` нет пути для варианта/прогона.
  - `E_AUTH_MISSING` — нет вообще никакого auth (ни `~/.opencode/`, ни
    provider-конфигов) для конкретного `(variant, run)` — preflight
    auth-ping всё равно упадёт.
  - `E_DOCKER_FAILED` — `runInput.isolation === "docker"` и подготовка
    docker-контейнера завершилась ошибкой.
  - `E_PACK_INSTALL_TIMEOUT` — `opencode plugin <ref>` превысил
    `runInput.timeouts.installSeconds` (только для `detectedType = "plugin"`).
  - `E_PACK_INSTALL_FAILED` — `opencode plugin <ref>` упал с non-zero exit;
    либо объявленный пак не нашёлся в `packInstall.deliveries` (внутренняя
    рассинхронизация 03↔04 — реальный баг, а не пользовательская ошибка);
    либо два пака одного варианта (или пак и сам харнесс) регистрируют один и
    тот же ресурс — см. §7.

`EnvVarSet.OPENCODE_PURE`/`OPENCODE_DISABLE_DEFAULT_PLUGINS`/
`OPENCODE_DISABLE_EXTERNAL_SKILLS` выставляются в значение `pure` варианта —
**не** «`true` для old, `false` для new», как раньше. `pure` вычисляется как
`variant.pure ?? declaredPacks.length === 0` (решение D1,
`.research/n-way-variants/00-overview.md §5`): явный `variant.pure`
побеждает всегда; при отсутствии — вариант без объявленных паков чист по
умолчанию, вариант с паком(-ами) — нет. Для legacy-шима это воспроизводит
сегодняшнее хардкод-поведение байт-в-байт (`old.pure` не задан явно, значит
`true`, потому что `old.packs === []`; `new.pure === false` явно).

## 3. Шаги алгоритма

1. Определить модель и connectivity-настройки прогона одним чтением реального
   `~/.config/opencode/opencode.json` (`readSourceConnectivity`, читается один
   раз на весь прогон, не зависит от варианта/прогона; отсутствие файла,
   пустой файл или битый JSON — не ошибка фазы, просто все поля ниже остаются
   неопределены).
2. **Whole-run пре-пасс, ДО того как хоть одна HOME хоть одного варианта
   тронута** (`resolveAllVariantDeliveries`): для **каждого** варианта `v` из
   `runInput.variants` (последовательно, `{ concurrency: 1 }`) — резолвнуть
   `declaredPacks = packsOf(runInput, v)` (число паков на вариант не
   ограничено, Stage 2) в их `PackDelivery` из `packInstall.deliveries` по
   имени (отсутствие делавери у объявленного пака, когда `packInstall` вообще
   задан, — `E_PACK_INSTALL_FAILED`, внутренний баг связки 03↔04, не должно
   случаться на здоровом прогоне), затем сразу прогнать **коллизионную
   проверку** (`checkInstructionCollisions`, полная механика — §7) над ЕГО
   набором инструкций. Результат — `deliveries` каждого варианта закэширован
   и переиспользуется шагом 3 ниже (никогда не пересчитывается второй раз —
   один источник правды). Прогон падает здесь, если у ЛЮБОГО варианта есть
   коллизия — так что коллизия варианта №3 никогда не всплывёт уже после того,
   как HOME вариантов №1 и №2 полностью построены и `config/<name>.json`
   записан на диск (это было реальной находкой ревью-гейта — см. §7).
3. Для **каждого варианта** `v` из `runInput.variants` (`processVariant`,
   последовательно, `{ concurrency: 1 }`):
   a. `declaredPacks = packsOf(runInput, v)` (тот же чистый лукап, что и в
      шаге 2 — дёшево, пересчитать не жалко). Взять уже резолвленные и
      коллизионно-проверенные `deliveries` этого варианта (шаг 2, не
      пересчитываются повторно), собрать из них объединённые `instructions` и
      `mcpServers` (`flatMap`/`reduce` по всем деливери варианта — сколько бы
      их ни было).
   b. `pure = v.pure ?? declaredPacks.length === 0` (см. §2 выше).
   c. Модель варианта: `ownModel = effectiveOf(v, runInput.model, 'model')`;
      если `ownModel` не задан или явно пустая строка — падение на
      `sourceConnectivity.model` (та же ambient-модель, что и раньше).
      `provider`/`small_model`/`enabled_providers`/`disabled_providers` — те
      же поля из шага 1, **без** per-variant переопределения: либо есть в
      исходном конфиге целиком, либо отсутствуют — идентичны на всех
      вариантах.
   d. Собрать `configObj` (`buildConfigObject`): `$schema`, опциональные
      `model`/`provider`/`small_model`/`enabled_providers`/
      `disabled_providers`, единый агент `build` по стандартному шаблону
      оркестратора, и (только если у варианта есть объявленные паки и
      найденные `mcpServers` непусты) секция `mcp`. Сериализовать в `configStr`
      (`JSON.stringify`, stable keys) — это и есть `OPENCODE_CONFIG_CONTENT`
      этого варианта. Записать редактированную (secrets вычищены) копию в
      `config/<name>.json` для отладки/review-workspace (сам `configStr`,
      идущий в env, остаётся НЕ редактированным — иначе прогон не смог бы
      аутентифицироваться).
   e. Для **каждого прогона** `n ∈ 1..runs` этого варианта (`{ concurrency: 1
      }`):
      - вычислить `homeDir` из `workspace.variantTrees.find(t => t.name ===
        v.name).homes[n-1]`. Отсутствие пути (рассинхрон с фазой 01) →
        `E_HOME_SETUP_FAILED`.
      - создать структуру HOME:
        ```
        <homeDir>/
        ├── .config/opencode/{skills,agents,plugins,command}/   # пустые
        ├── .opencode/                                           # auth
        ├── .cache/opencode/
        ├── .local/share/opencode/
        └── .local/bin/            # только если ≥1 пак реестра объявляет setup (см. шаг 6)
        ```
        Сбой `mkdir` → `E_HOME_SETUP_FAILED`.
      - скопировать auth по whitelist (`runInput.auth`, `AuthWhitelist`).
        **Базовый whitelist** (всегда, если источник существует): `opencode`
        → `~/.opencode/`, `npmrc` → `~/.npmrc`, `anthropic`/`openai`/`gemini`
        → `~/.config/<provider>/`. **Расширяемый whitelist**: `aws` →
        `~/.aws/`, `ssh` → `~/.ssh/`, `git` → `~/.gitconfig`. Запрошенный, но
        отсутствующий на хосте ресурс → warning, продолжаем без него; если
        **ни один** источник auth не скопировался → `E_AUTH_MISSING`
        (`variant`, `runIndex`).
      - применить `instructions` этого варианта на `homeDir` (симлинк для
        skill, копия файла для agent/command, `opencode plugin <ref>` для
        plugin — таймаут `installSeconds`, non-zero exit / таймаут →
        `E_PACK_INSTALL_FAILED` / `E_PACK_INSTALL_TIMEOUT`, mcp-блок уже
        свёрнут в `configObj` на шаге d). Вариант, не объявивший ни одного
        пака, не получает НИ ОДНОЙ инструкции — на диске никакого следа
        чужого пака быть не должно (проверяется гейтом
        `foreign-pack-absent`, фаза 05).
      - собрать `HomeTree { basePath: homeDir, structure, copiedAuth }` и
        `EnvVarSet` через `buildEnvVars(homeDir, pure, configStr, pathValue)`
        (см. шаг 6 про `pathValue`).
   f. Вернуть `VariantResult { name: v.name, trees, envs, config: configStr }`.
4. Собрать `homeTrees: VariantHomes[]`, `envVars: VariantEnv[]`,
   `generatedConfigs: VariantConfig[]` — по одной записи на вариант,
   `map(r => ({ name: r.name, ...}))`, в порядке `runInput.variants`.
5. Вернуть `HomeIsolationResult { homeTrees, envVars, generatedConfigs }`.

### 6. PATH и `--pack-setup`: одинаковая видимость для всех вариантов

Если **хотя бы один** пак реестра объявляет `setup` — `.local/bin` попадает в
`PATH` **каждого** варианта (`anyPackDeclaresSetup`), независимо от того,
объявил ли конкретный вариант этот пак. Это сознательное решение симметрии
(`.research/n-way-variants/02-phases.md`, фаза 04): HOME-установленный бинарник
должен быть одинаково *достижим* везде, и только его *присутствие*
различается — иначе гейт 6 (`pack-functional`, фаза 05) не мог бы отличить
«бинарника нет» от «PATH его прячет» на вариантах, где пак не установлен.
`setupPathFor(homeDir, isolation, imagePath)` в docker-режиме использует
in-container путь (`/home/opencode/.local/bin:<imagePath>`), в host-режиме —
реальный путь на хосте (`<homeDir>/.local/bin:<текущий PATH процесса>`).

### 7. Коллизии регистрации между паками одного варианта (Stage 2)

С момента, когда вариант может объявить произвольное число паков (guard
`variant.packs.length ≤ 1` снят фазой 00 — см.
`docs/phases/00-cli-parse.ru.md`), два пака ОДНОГО варианта могут
регистрировать одну и ту же вещь: `applyInstruction` (шаг 3.e) — last-write-
wins, без мёрджа, так что без проверки один пак тихо затёр бы регистрацию
другого. `checkInstructionCollisions` ловит это ДО того, как хоть одна
инструкция применена — на уровне `RegistrationInstruction`, ещё не на диске.

**Ключ коллизии** (`instructionDestKey`) — сознательно ýже, чем пара
`(kind, name)`:

| `RegistrationInstruction.kind` | Ключ | Почему именно так |
|---|---|---|
| `skill` | `skill:<name>` | — |
| `file` (agent/command) | `file:<section>:<name>` | **Агент и команда с одинаковым `name` НЕ коллидируют** — они живут в разных секциях (`agents/`, `command/`), `section` — часть ключа. |
| `plugin`, npm-форма (`opencode plugin <module>`) | `plugin-module:<name>` | — |
| `plugin`, локальный файл | `plugin-file:<basename(target)>` | Коллизия — по имени ДОСТАВЛЕННОГО файла, не по `inst.name` (тот используется только для npm-формы). |
| `config` (mcp) | `mcp:<name>` | — |

Пара инструкций коллидирует, если у них совпал ключ **и** они пришли из
**разных** паков (`b.pack !== a.pack`) — свой собственный пак не может
коллидировать сам с собой; `findInstructionCollision` возвращает первую
такую пару в порядке деклараций.

**Харнесс-агент `build` защищён тем же механизмом.** `buildSkeleton` пишет
свой `agents/build.md` ДО применения любых инструкций пака, вне пакового
конвейера — без специального случая пак, доставляющий агента по имени
`build`, тихо затёр бы харнесс-файл, и это никогда бы не попало под общую
проверку «пак против пака». Решение — засеять коллизионную проверку одной
зарезервированной записью `{ key: 'file:agents:build', pack: '<testaipack
harness>', inst: {...} }` (`HARNESS_OWNER = '<testaipack harness>'`, строка
с пробелом и угловыми скобками — заведомо не проходит
`PACK_NAME_SAFE_RE`, так что не может случайно совпасть с настоящим именем
пака) ещё до того, как в список добавляются реальные паковые инструкции.
Пак, объявляющий агента `build`, теперь коллидирует с этой записью так же,
как коллидировал бы с другим паком — сообщение называет `<testaipack
harness>` вместо второго пака.

**Ошибка**: `E_PACK_INSTALL_FAILED`, сообщение `packs '<a>' and '<b>' both
deliver the same <kind> '<name>' for variant '<variant>'` (для `file` —
`file (<section>) '<name>'`, секция называется явно), контекст `{ variant,
packs: [a, b], kind, name, section? }`.

**Порядок относительно остального пайплайна**: коллизионная проверка — часть
whole-run пре-пасса (шаг 2 выше), т.е. запускается **для каждого варианта**
ДО того, как HOME хоть одного варианта тронут. Так коллизия на варианте №3
не всплывает только после того, как HOME вариантов №1/№2 уже полностью
построены и `config/<name>.json` уже на диске (это была ревью-гейт-находка —
изначальная версия проверяла коллизии внутри `processVariant`, то есть уже
ПОСЛЕ того, как предыдущие варианты отработали).

**Намеренное поведение, не баг**: два пака, доставляющие ОДИН И ТОТ ЖЕ
ресурс — тот же npm-модуль плагина, тот же mcp-сервер под тем же именем —
тоже падают с коллизией, даже если применение любого из двух было бы
идемпотентным (результат на диске был бы одинаковым). Коллизия на внешнем
ресурсе — почти всегда конфликт авторства конфигурации, а не осознанное
намерение поделиться; для намеренного шаринга уже есть штатный механизм —
один пак реестра, на который ссылаются `packs` НЕСКОЛЬКИХ вариантов (тогда
пак доставляется единожды, см. `docs/phases/03-pack-install.ru.md`, решение
D6). Fail-loud выбран сознательно вместо молчаливого no-op.

## 4. Входные/выходные файлы

| Файл / каталог                                    | Чтение/Запись | Схема (TypeSpec/Zod) |
| ------------------------------------------------- | ------------- | -------------------- |
| `home/<variant>/run-<n>/`                         | Запись        | структура HOME       |
| `home/<variant>/run-<n>/.config/opencode/{...}/`  | Запись        | пустые + инструкции объявленных этим вариантом паков |
| `home/<variant>/run-<n>/.opencode/`               | Запись        | копия `~/.opencode/` |
| `config/<variant>.json`                           | Запись        | `OpenCodeConfig` (редактированная копия) |

`generatedConfigs[*].config` — это **строки** (содержимое
`OPENCODE_CONFIG_CONTENT`), они же пишутся (редактированными) как
`config/<variant>.json` для отладки и для review-workspace.

Снимок того, что варианты реально использовали **после** запуска (эффективный
конфиг, установленные skills/agents/plugins/mcp/npm-зависимости, факт вызова)
сохраняется позже, фазой 06, в `config/.config/opencode/<variant>/` — см.
`docs/phases/06-run-side.ru.md`, раздел 9.

## 5. Edge-cases и ошибки

| Кейс                                                       | Поведение                                       | Код                       |
| ---------------------------------------------------------- | ----------------------------------------------- | ------------------------- |
| `~/.opencode/` существует, но пустой                       | Копируем как есть, не fail                      | —                         |
| Запрошен `--aws`, но `~/.aws` нет                          | warning, продолжаем без него                    | —                         |
| Нет вообще никакого auth (ни opencode, ни provider)        | fail для этого `(variant, run)` (preflight всё равно упадёт) | `E_AUTH_MISSING`   |
| symlink создать нельзя (ROFS / нет прав)                   | fail                                            | `E_HOME_SETUP_FAILED`     |
| пак ссылается на `pack/<name>/`, которого нет               | fail                                            | `E_HOME_SETUP_FAILED`     |
| объявленный пак отсутствует в `packInstall.deliveries`      | fail (рассинхрон 03↔04)                        | `E_PACK_INSTALL_FAILED`   |
| plugin install превысил таймаут                            | fail прогона                                    | `E_PACK_INSTALL_TIMEOUT`  |
| plugin install упал с non-zero exit                        | fail прогона                                    | `E_PACK_INSTALL_FAILED`   |
| `isolation = "docker"`, подготовка контейнера упала          | fail прогона                                    | `E_DOCKER_FAILED`         |
| smoke-test / вариант без паков                              | вариант получает конфигурацию без паковых инструкций | —                    |
| Ни один пак реестра не объявляет `setup`                    | `.local/bin` не создаётся, `PATH` не переопределяется | —                    |
| Повторный запуск с тем же runId (idempotent)                | пересоздаём структуру, перезаписываем           | —                         |
| Два пака одного варианта регистрируют один и тот же `skill`/`mcp`/npm-plugin-модуль/локальный plugin-файл | fail ДО применения любой инструкции этого прогона (whole-run пре-пасс), называет оба пака | `E_PACK_INSTALL_FAILED` |
| Агент и команда одного варианта делят имя (разные секции)   | НЕ коллизия — разные ключи (`file:agents:x` vs `file:command:x`) | —              |
| Пак объявляет агента по имени `build`                       | fail, коллидирует с харнесс-агентом (`<testaipack harness>` вместо второго пака) | `E_PACK_INSTALL_FAILED` |
| Два пака доставляют идентичный npm plugin-модуль (применение было бы идемпотентным) | fail всё равно — коллизия на внешнем ресурсе, а не результат на диске | `E_PACK_INSTALL_FAILED` |
| Вариант объявляет 3+ пака без коллизий                       | все применяются, ни один не ограничен числом      | —                         |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: legacy-шим (2 варианта), `runs = 2`, есть `~/.opencode/` →
  4 HOME-каталога, в каждом `.opencode/` скопирован; `generatedConfigs`
  содержит 2 валидных JSON-строки.
- ✅ N-way: 3 варианта (один чистый смоук, один с паком A, один с паком B) →
  purity выставлена только на смоук-варианте; инструкции пака A попадают
  только в HOME варианта A, пака B — только в HOME варианта B; `envVars`
  несёт имена вариантов без позиционной индексации (grep `envVars[0]`
  ничего не находит вне тестов).
- ✅ pack symlink (`detectedType = "skill"`): создан
  `home/<variant>/run-1/.config/opencode/skills/<name>` → `pack/<name>/`,
  symlink разыменовывается.
- ✅ pack file (`detectedType = "agent"`): файл скопирован в
  `home/<variant>/run-1/.config/opencode/agents/<name>.md`.
- ✅ pack plugin (`detectedType = "plugin"`): запускается
  `HOME=home/<variant>/run-1 opencode plugin <ref>`, в
  `home/<variant>/run-1/.config/opencode/plugins/` появляется модуль, в
  `results/install.log` — запись об успехе.
- ✅ plugin install failure: муляж `opencode plugin` exit 1 → throw
  `E_PACK_INSTALL_FAILED`.
- ✅ docker isolation failure: `isolation = "docker"`, подготовка
  контейнера упала → throw `E_DOCKER_FAILED`.
- ✅ вариант без объявленного пака не получает pack-файлы: после фазы в
  `home/<без-пака>/run-*/.config/opencode/` нет pack-файлов, `skills/`
  пустой.
- ✅ env composition: для варианта без паков (`pure` по умолчанию)
  `EnvVarSet` содержит `OPENCODE_PURE=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`;
  для варианта с явным `pure: false` они сняты, даже если у него есть паки.
- ✅ whitelist aws missing: `--aws`, но `~/.aws` нет → warning в логах, HOME
  создан без `.aws`, не fail.
- ✅ no auth at all: отсутствуют `~/.opencode/` и все provider-конфиги →
  throw `E_AUTH_MISSING`.
- ✅ symlink failure ROFS: целевая FS read-only → throw `E_HOME_SETUP_FAILED`.
- ✅ `variant.model` override: у одного варианта задан свой `model` → его
  конфиг содержит это значение, у остальных — глобальный/ambient.
- ✅ `runInput.model` не задан ни на одном варианте: все конфиги берут
  `model` из ambient `~/.config/opencode/opencode.json` (или не содержат поля
  `model` вовсе, если ambient-конфига тоже нет).
- ✅ custom provider: в реальном `~/.config/opencode/opencode.json` заданы
  `provider`/`small_model`/`enabled_providers`/`disabled_providers` →
  КАЖДЫЙ `generatedConfigs[*].config` содержит все четыре поля целиком и
  идентично.
- ✅ custom provider не задан: ни один конфиг не содержит ни одного из
  четырёх полей вовсе.
- ✅ `enabled_providers`/`disabled_providers`/`small_model` неожиданной формы
  → поле трактуется как отсутствующее, не throw.
- ✅ PATH fairness: пак реестра объявляет `setup`, но объявлен только на
  варианте A → `PATH` варианта B (не объявившего его) ВСЁ РАВНО содержит
  `.local/bin` (симметрия видимости — только бинарника там нет).
- ✅ multi-pack variant happy-path: вариант объявляет 2 непересекающихся пака
  (skill + agent) → оба применены в его HOME, `instructions` — объединение
  обоих, коллизий нет.
- ✅ skill vs skill collision: два пака одного варианта регистрируют skill
  с одним и тем же именем → throw `E_PACK_INSTALL_FAILED` до применения
  любой инструкции, сообщение и контекст называют оба пака.
- ✅ agent vs command same name — не коллизия: пак A доставляет agent `x`,
  пак B того же варианта доставляет command `x` → оба применяются успешно
  (разные секции, разные ключи).
- ✅ harness build-agent protection: пак доставляет agent `build` → throw
  `E_PACK_INSTALL_FAILED`, контекст называет `<testaipack harness>` вместо
  второго пака.
- ✅ identical npm plugin module on two packs — fails anyway: оба пака
  ссылаются на один и тот же npm-модуль плагина → throw
  `E_PACK_INSTALL_FAILED`, несмотря на то, что итоговый диск был бы
  одинаковым в любом случае (fail-loud, не idempotent no-op).
- ✅ whole-run pre-pass order: коллизия объявлена на 3-м варианте из трёх →
  фаза падает ДО того, как HOME первого и второго варианта созданы на диске
  (проверяется отсутствием `home/<1-й вариант>/run-1/` после throw).
- ✅ shared pack across variants — не коллизия: один и тот же пак реестра
  объявлен ДВУМЯ разными вариантами (не одним) → каждый вариант получает
  его независимо, коллизионная проверка (внутривариантная) молчит.
- ❌ НЕ покрыто (ticket): изоляция под macOS с sandbox-exec.

## 7. Инварианты

- После фазы для **каждой** пары `(variant, n)` существует полный
  HOME-скелет с пустыми `.config/opencode/{skills,agents,plugins,command}/`.
- Вариант, не объявивший пак, **не имеет** его в любых подкаталогах своего
  `.config/opencode/` (проверяется фазой 05, гейт `foreign-pack-absent`).
- Вариант, объявивший пак, **имеет** его видимым — либо symlink/файл в
  `.config/opencode/...`, либо установлен в `plugins/`, либо зарегистрирован
  в его `generatedConfigs` (mcp).
- `envVars[i].envs[n-1]` (`EnvVarSet`) содержит `HOME`,
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_CONFIG_CONTENT`.
  `OPENCODE_PURE`/`OPENCODE_DISABLE_DEFAULT_PLUGINS`/
  `OPENCODE_DISABLE_EXTERNAL_SKILLS` = `pure` этого варианта.
- Whitelist копируется идентично во все `home/<variant>/run-N/` (детерминизм
  auth-состояния между прогонами).
- Модель прогона и все connectivity-поля применяются **идентично на КАЖДОМ
  варианте**, если только вариант не переопределил их явно
  (`effectiveOf(v, ..., 'model')`) — расхождение между двумя генерируемыми
  конфигами, вызванное чем-то, кроме секции паков/явного оверрайда, было бы
  багом: оно незаметно ломало бы честность сравнения так же, как в v1
  ломало бы `--pure-baseline` (см. гейт 5/6 preflight,
  `docs/phases/05-preflight.ru.md`).
- Ни одна инструкция никогда не применяется молча поверх другой: если два
  пака одного варианта целятся в одно и то же место назначения (§7), фаза
  падает раньше, чем HOME хоть одного варианта тронут — never a silent
  last-write-wins на диске. Ключ коллизии — по фактическому месту
  назначения на диске/в конфиге (`instructionDestKey`), не по сырому `(kind,
  name)`: агент и команда с одинаковым именем не коллидируют (разные
  секции). Харнесс-агент `build` защищён тем же механизмом — засеян как
  зарезервированная запись до любых паковых инструкций. Проверка идёт
  per-variant (свой пак не может коллидировать сам с собой) и для ВСЕХ
  вариантов целиком до того, как HOME хоть одного из них тронут.

## 8. Зависимости от других фаз

- Зависит от: **01 workspace-setup** (`Manifest`, `WorkspaceTree.variantTrees`),
  **03 pack-install** (`PackInstallResult.deliveries` для применения паков —
  передаётся через опциональное поле `packInstall` в контрактном
  `HomeIsolationInput`; без него — все варианты без паковых инструкций).
- Блокирует: **05 preflight** (preflight проверяет HOME-структуру и
  pack-visibility/foreign-pack-absent per variant), **06 run-side** (нужны
  `envVars` и пути для запуска агента).
- Параллелизуется с: — (исполняется после 02+03, точка схода перед preflight).
