# Фаза 03: pack-install

> Спека фазы. Контракт = `contract/phases/03-pack-install.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Доставить **каждый** пак из реестра эксперимента (`runInput.packs`) в
собственный каталог `pack/<packName>/` (`skill`/`agent`/`command`/`all`; для
`plugin`/`mcp` файловая доставка не нужна — регистрация целиком происходит в
фазе 04), определить финальный тип (`detectedType`) и сформировать
`registeredIn` — список секций opencode-config, куда пак должен быть
зарегистрирован (`skills`, `plugins`, `agents`, `commands`, `mcp`), плюс
декларативный список `instructions`, которым фаза 04 физически применяет пак
внутри HOME-ов вариантов, объявивших его. Фаза 03 **не** модифицирует
`home/<variant>/run-N/` — целевые каталоги создаёт и заполняет фаза 04.

Каждый пак реестра **доставляется ровно один раз** (решение D6,
`.research/n-way-variants/00-overview.md §5`) — если два варианта ссылаются на
один и тот же пак по имени, атрибуция «какой вариант его использует»
целиком лежит на фазах 04/04b/05, эта фаза про неё ничего не знает.
Smoke-test-режим (пустой реестр `runInput.packs === []`) — no-op, `deliveries:
[]`.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.PackInstall` (см.
`contract/phases/03-pack-install.tsp`).

- Вход: `PackInstallInput` — `{ runInput: RunInput, manifest: Manifest,
  workspace: WorkspaceTree }`. Планируемые пути `home/<variant>/run-{1..N}/`
  фаза 03 не использует — целевые HOME-каталоги создаёт фаза 04; фаза 03
  только доставляет паки в `workspace.pack/`.
- Выход: `PackInstallResult` — `{ deliveries: PackDelivery[], installLogPath:
  string }`. Одна запись `PackDelivery` **на каждый пак реестра**:
  `{ pack: string, packPath: string, detectedType: PackType | null,
  registeredIn: string[] }` (плюс локальное расширение `PackDeliveryExt`,
  `src/phases/03-pack-install.ts`, добавляющее `instructions:
  RegistrationInstruction[]` — та же внутренняя связка 03↔04, что была раньше,
  теперь per-pack, а не единственная запись):
  - `pack` — имя пака из реестра (`PackSpec.name`).
  - `packPath` — абсолютный путь к `pack/<name>/` (для skill/agent/command/all)
    или пустая строка для plugin/mcp, где клон/копия не требуется.
  - `detectedType` — финальный `PackType` после детекции.
  - `registeredIn` — список секций opencode-config, куда этот пак
    зарегистрирован (например `["skills"]`, `["plugins"]`,
    `["agents","commands"]`). Это декларация, потребляемая фазой 04 при
    генерации конфига и создании симлинков/файлов в HOME **каждого варианта,
    который объявил этот пак** (`packsOf(runInput, variant)`, см. фазу 00).
  - `installLogPath` — путь к `results/install.log`.
- Ошибки: `@error PackInstallError` — `{ code, message, packRef, context? }`,
  где `code` принимает только значения:
  - `E_PACK_INVALID_REF` — `pack.ref` не парсится ни одним правилом (см.
    алгоритм); либо детектированное `name` не является безопасным именем
    (см. security-примечание ниже); либо конечный путь доставки (`dest`)
    вышел за пределы `pack/` (defense-in-depth проверка `isPathWithin`
    перед любым `removeDir`). Пустой реестр (`runInput.packs === []`) сюда
    **не** попадает — это no-op без ошибки.
  - `E_PACK_UNKNOWN_TYPE` — `PackSpec.type` указан как несуществующий тип.
  - `E_INSTALL_TIMEOUT` — таймаут доставки пака в `pack/` (git clone / copy
    превысили `runInput.timeouts.installSeconds`).
  - `E_INSTALL_FAILED` — любой другой сбой доставки: git clone частного репо,
    файл/каталог не найден, и т.п.

  Ошибки собственно plugin-установки (`opencode plugin <name>`) здесь **не**
  возникают — они в фазе 04 (`E_PACK_INSTALL_TIMEOUT` / `E_PACK_INSTALL_FAILED`),
  теперь per (variant, pack).

  **Security — валидация имени и редактирование ошибок:**
  - Имя пака (`PackSpec.name`) провалидировано ещё в фазе 00
    (`PACK_NAME_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, не `.`/`..`) —
    эта фаза полагается на уже провалидированное имя как на сегмент пути
    `pack/<name>/`, но для skill/agent/command дополнительно перепроверяет
    ref-производное имя внутри `detectPack` тем же правилом, до любой файловой
    операции.
  - Отдельно, перед любым `removeDir` конечного каталога доставки, есть
    рантайм-проверка `isPathWithin(packDir, dest)` — второй, независимый
    слой защиты на случай, если что-то всё же обошло валидацию имени.
  - Сообщения об ошибках никогда не несут секреты: inline `mcp:<name>:<config>`
    pack ref усечён до `mcp:<name>` во всех контекстах ошибок; учётные данные,
    встроенные в clone URL (`https://user:token@host/...`), вырезаны из текста
    ошибки и stderr git (`redactUrlCredentials`/`safeRefDisplay`) — тот же
    редактор, который защищает и `packShortName` в фазе 00, применяется здесь
    независимо, потому что фаза 03 работает с `ref` напрямую, а не только с
    производным именем.

## 3. Шаги алгоритма

1. Если `runInput.packs.length === 0` (пустой реестр — smoke-test или
   variant-режим без единого пака) → вернуть `PackInstallResult { deliveries:
   [], installLogPath }`, в `installLogPath` записать строку `"smoke-test: no
   pack\n"`.
2. Иначе, **для каждого `PackSpec` в `runInput.packs` независимо**
   (`Effect.forEach`, порядок реестра сохраняется в результате):
   a. `packDir = path.join(workspace.pack, pack.name)` — своя подпапка на
      КАЖДЫЙ пак, `ensureDir`.
   b. Определить финальный `detectedType`:
      - если `pack.type` задан явно (уже продетектирован фазой 00 для тех
        паков, у которых `type` не был указан пользователем — см.
        `docs/phases/00-cli-parse.ru.md`, шаг 12) → использовать его;
      - иначе — `detectPack(pack.ref)` по префиксу `ref` (тот же алгоритм,
        что и в фазе 00, `src/pack/detector.ts`). Невалидный ref → throw
        `PackInstallError({ code: "E_PACK_INVALID_REF", packRef, pack: pack.name })`.
   c. По типу — **доставка пака в `pack/<name>/`** (только этот шаг пишет на
      диск внутри фазы 03; регистрация в `home/<variant>/` делается фазой 04):
      - **skill (git)**: `git clone --depth 1 <ref> pack/<name>/`.
        Таймаут `runInput.timeouts.installSeconds`. Сбой clone по таймауту →
        `E_INSTALL_TIMEOUT`; по exit code → `E_INSTALL_FAILED`.
        `registeredIn = ["skills"]`, `packPath = <abs>/pack/<name>/`.
      - **skill (local)**: копирование каталога в `pack/<name>/`. Путь не
        существует → throw `E_PACK_INVALID_REF`. `registeredIn = ["skills"]`.
      - **plugin (npm)**: в `pack/` ничего не клонируем (`packPath` остаётся
        пустым). `registeredIn = ["plugins"]` — фаза 04 запустит
        `opencode plugin <ref>` внутри HOME каждого объявившего его варианта.
      - **agent / command**: если это URL или путь — клон/копия одного `.md`
        файла в `pack/<name>/<basename>.md`. Файл не найден → `E_PACK_INVALID_REF`.
        `registeredIn = ["agents"]` (или `["commands"]`).
      - **mcp**: в `pack/` не клонируем. `registeredIn = ["mcp"]` — фаза 04
        впишет блок в конфиг каждого объявившего его варианта.
      - **all**: клонировать репо в `pack/<name>/`, обойти стандартные
        подпапки `skills/`, `agents/`, `commands/`, `plugins/`; для каждого
        найденного элемента добавить соответствующую секцию в `registeredIn`.
        `plugins/` сканируется **по расширению файла** — только записи вида
        `<name>.js` / `.mjs` / `.ts` / `.mts` / `.cjs`, и только реальные файлы
        (не подкаталоги); имя плагина — та же запись без расширения.
   d. Дописать в `results/install.log` итог доставки этого пака: `[<pack.name>]
      installed <type> <detected.name> via <source>; sections=[...]`. Строк
      про plugin-установку здесь ещё нет — их добавит фаза 04 после
      применения (теперь с указанием варианта).
3. Собрать `deliveries: PackDelivery[]` (одна запись на пак, порядок реестра)
   и вернуть `PackInstallResult { deliveries, installLogPath }`.

## 4. Входные/выходные файлы

| Файл / каталог                                      | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------------------------- | ------------- | -------------------- |
| `pack/<packName>/`                                  | Запись        | клон / копия пака, на каждый пак реестра |
| `results/install.log`                               | Дополнение    | текст, построчно, по одной записи на пак |

`registeredIn`/`instructions` (список секций opencode-config и декларативных
инструкций регистрации) возвращаются в `PackInstallResult.deliveries[*]` и
затем читаются фазой 04 (через опциональное поле `packInstall` в
`HomeIsolationInput`, не через файл). Сама регистрация (symlink/file/plugin/
config в `home/<variant>/run-N/`) выполняется **фазой 04**, для каждого
варианта, объявившего этот пак (`packsOf(runInput, variant)`), потому что
целевые каталоги существуют только после 04-шага создания HOME-скелета.

## 5. Edge-cases и ошибки

| Кейс                                                     | Поведение                                            | Код                      |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------ |
| `runInput.packs.length === 0` (реестр пуст)               | no-op, лог `"smoke-test: no pack"`, `deliveries: []` | —                   |
| git clone пака по таймауту                                | fail прогона                                         | `E_INSTALL_TIMEOUT`      |
| git clone private пака без auth                           | fail + подсказка про `--git`/`--ssh`                 | `E_INSTALL_FAILED`       |
| local path не существует                                  | fail                                                 | `E_PACK_INVALID_REF`     |
| неизвестный префикс `ref`                                 | fail                                                 | `E_PACK_INVALID_REF`     |
| `PackSpec.type` невалидный                                 | fail                                                 | `E_PACK_UNKNOWN_TYPE`    |
| `type: "all"`, но в репо нет стандартных подпапок          | warning + пустое `registeredIn`, но не fail          | —                        |
| plugin install (таймаут/сбой)                              | обрабатывается в **фазе 04** при применении (per variant) | — (через 04)         |
| `plugins/` содержит подкаталог `foo.js/` (не файл)          | пропускается, не регистрируется                     | —                        |
| два варианта ссылаются на один и тот же пак по имени        | пак доставляется один раз; атрибуция — вне этой фазы | —                        |
| `pack.ref` резолвится в небезопасное имя (например `..`)   | fail до файловых операций                            | `E_PACK_INVALID_REF`     |
| `dest` доставки вышел за пределы `pack/<name>/` (defense-in-depth) | fail, `removeDir` не вызывается               | `E_PACK_INVALID_REF`     |

> Примечание: ошибки собственно plugin-установки (`opencode plugin <name>`)
> относятся к фазе 04 (`E_PACK_INSTALL_TIMEOUT` / `E_PACK_INSTALL_FAILED`) — там,
> где пак применяется к уже созданному `HOME=home/<variant>/run-N`. Здесь
> фиксируются только ошибки **доставки** пака в `pack/` (clone/copy/local
> path) и валидации ref/type; для них зарезервированы коды
> `E_INSTALL_TIMEOUT` / `E_INSTALL_FAILED`.

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path skill git: реестр из одного пака, ref = `github:owner/skill`
  → клон в `pack/<name>/`, `detectedType = "skill"`, `registeredIn =
  ["skills"]`.
- ✅ happy-path plugin npm: `ref = "npm:myplugin"` → в `pack/<name>/` ничего
  не клонируется, `detectedType = "plugin"`, `registeredIn = ["plugins"]`
  (применяется фазой 04).
- ✅ happy-path agent: `ref = "agent:./build.md"` → файл скопирован в
  `pack/<name>/build.md`, `detectedType = "agent"`, `registeredIn = ["agents"]`.
- ✅ happy-path all: репо с подпапками `skills/` + `commands/` → `registeredIn`
  содержит обе секции.
- ✅ N-way registry: реестр из 2 паков (skill + command) → 2 записи в
  `deliveries`, каждая под своим `pack/<name>/`, независимые
  `installLogPath`-строки.
- ✅ smoke-test: `runInput.packs === []` → no-op, `deliveries: []`,
  `installLogPath` содержит `"smoke-test: no pack"`.
- ✅ clone timeout: муляж git висит → throw `E_INSTALL_TIMEOUT`.
- ✅ clone failed (private repo): муляж git exit 1 + auth error → throw
  `E_INSTALL_FAILED`.
- ✅ invalid local path: `ref = "./nope"` → throw `E_PACK_INVALID_REF`.
- ✅ unknown pack-type: `type: "xyz"` → throw `E_PACK_UNKNOWN_TYPE`.
- ✅ unsafe pack name: ref резолвится в имя `..` (или другое небезопасное) →
  throw `E_PACK_INVALID_REF` до любой файловой операции.
- ✅ plugin scan by extension: `plugins/` содержит `a.js`, `b.mjs`, `c.txt`,
  подкаталог `d.js/` → регистрируются только `a` и `b`.
- ✅ error redaction: ошибка с inline `mcp:name:{"env":{"KEY":"secret"}}` в
  контексте содержит только `mcp:name`; ошибка git clone с
  `https://user:token@host/repo` в URL не содержит `user:token@` в
  сообщении/контексте.
- ✅ multi-pack variant: вариант объявляет 2 пака реестра → оба доставлены
  независимо в свои `pack/<name1>/`/`pack/<name2>/`, `deliveries` содержит
  обе записи; фаза 03 сама не знает, что оба пака делят один вариант —
  доставка была per-pack с самого начала (сколько бы паков ни объявил
  какой-либо вариант в конфиге), проверка коллизий регистрации живёт в
  фазе 04 (см. `docs/phases/04-home-isolation.ru.md`), не здесь.

## 7. Инварианты

- После фазы каждый пак из `runInput.packs` доставлен **ровно один раз** в
  `pack/<name>/` для типов skill/agent/command/all (или не доставлен для
  типов plugin/mcp, где `pack/` не нужен).
- `deliveries.length === runInput.packs.length` (по записи на каждый пак,
  даже в smoke-test-режиме — тогда `deliveries === []` и
  `runInput.packs === []` совпадают тривиально).
- `detectedType` ∈ всех значений `PackType`.
- `registeredIn` — подмножество `{skills, plugins, agents, commands, mcp}`;
  пуст только при `type: "all"` без стандартных подпапок.
- Фаза 03 **не создаёт** ничего в `home/<variant>/run-N/` — физическая
  регистрация (symlink/file/plugin/config) выполняется фазой 04 по
  `registeredIn` и по тому, какие варианты объявили этот пак
  (`variant.packs`).
- Вариант, не объявивший пак, не получает его ни на каком шаге (проверяется
  фазой 05, гейт `foreign-pack-absent`).
- `results/install.log` существует и содержит хотя бы одну запись (даже в
  smoke-test-режиме).
- Доставка пака никогда не пишет/не удаляет что-либо за пределами
  `pack/<name>/` — имя уже провалидировано фазой 00, и дополнительно
  рантайм-проверкой перед любым `removeDir`.
- Сообщения об ошибках и контекст ошибок никогда не содержат секретов из
  inline `mcp:`-конфига или credentials из clone URL.

## 8. Зависимости от других фаз

- Зависит от: **00 cli-parse** (`RunInput.packs` — реестр, уже
  провалидированный и с определёнными там, где возможно, типами), **01
  workspace-setup** (`Manifest`, `WorkspaceTree.pack`).
- Блокирует: **04 home-isolation** (нужны `registeredIn`/`instructions` и
  `detectedType` каждого пака для регистрации в HOME объявивших его
  вариантов — передаётся через поле `packInstall` в `HomeIsolationInput`),
  **05 preflight** (гейты 4/5 проверяют, что declared-пак виден в своих
  вариантах и не виден в чужих).
- Параллелизуется с: **02 repo-clone** (clone тестируемого репо и доставка
  паков в `pack/` независимы).
- **Разделение с 04:** фаза 03 доставляет паки в `pack/<name>/`
  (skill/agent/command/all) и формирует `registeredIn` — список секций
  регистрации на каждый пак. Фаза 04 **применяет** пак — создаёт
  симлинки/файлы в `home/<variant>/run-N/` для каждого варианта, объявившего
  его, запускает `opencode plugin <ref>` для plugin-типа, вписывает mcp-блок
  в конфиг. Разделение обязательно: целевые каталоги `home/<variant>/run-N/`
  существуют только после 04-шага создания HOME-скелета, а по схеме
  зависимостей 03 идёт раньше 04.
