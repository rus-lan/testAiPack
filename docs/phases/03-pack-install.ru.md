# Фаза 03: pack-install

> Спека фазы. Контракт = `contract/phases/03-pack-install.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Доставить тестируемый pack (`skill`/`plugin`/`agent`/`command`/`mcp`/`all`) на
сторону **new**: клон/копию в `pack/<name>/` (для skill/agent/command/all),
определить финальный тип (`detectedType`) и сформировать `registeredIn` —
список секций opencode-config, куда pack должен быть зарегистрирован
(`skills`, `plugins`, `agents`, `commands`, `mcp`). Фаза 03 **не** модифицирует
`home/new/run-N/` — целевые каталоги создаются фазой 04. Сторона **old** pack-а
не получает ни на каком шаге.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.PackInstall` (см.
`contract/phases/03-pack-install.tsp`).

- Вход: `PackInstallInput` — `{ runInput: RunInput, manifest: Manifest,
  workspace: WorkspaceTree }`. Планируемые пути `home/{old,new}/run-{1..N}/`
  фаза 03 не использует — целевые HOME-каталоги создаются фазой 04; фаза 03
  только доставляет pack в `workspace.pack/`.
- Выход: `PackInstallResult` — `{ packPath: string, detectedType: PackType |
  null, installLogPath: string, registeredIn: string[] }`:
  - `packPath` — абсолютный путь к `pack/<name>/` (для skill/agent/command/all)
    или пустая строка / путь к pack-источнику для plugin/mcp, где клон/копия не
    требуется.
  - `detectedType` — финальный `PackType` после детекции; `null` в smoke-test
    режиме.
  - `installLogPath` — путь к `results/install.log`.
  - `registeredIn` — список секций opencode-config, куда pack зарегистрирован
    (например `["skills"]`, `["plugins"]`, `["agents","commands"]`). Это
    декларация, потребляемая фазой 04 при генерации `config/new.json` и при
    создании симлинков/файлов в HOME.
- Ошибки: `@error PackInstallError` — `{ code, message, packRef, context? }`,
  где `code` принимает только значения:
  - `E_PACK_INVALID_REF` — `packRef` не парсится ни одним правилом (см.
    алгоритм); либо детектированное `name` не является безопасным именем
    (см. security-примечание ниже); либо конечный путь доставки (`dest`)
    вышел за пределы `pack/` (defense-in-depth проверка `isPathWithin`
    перед любым `removeDir`). Smoke-test (`packRef` отсутствует) сюда
    **не** попадает — это no-op без ошибки.
  - `E_PACK_UNKNOWN_TYPE` — `--pack-type` указан как несуществующий тип.
  - `E_INSTALL_TIMEOUT` — таймаут доставки pack-а в `pack/` (git clone / copy
    превысили `runInput.timeouts.installSeconds`).
  - `E_INSTALL_FAILED` — любой другой сбой доставки: git clone частного репо,
    файл/каталог не найден, и т.п.

  Ошибки собственно plugin-установки (`opencode plugin <name>`) здесь **не**
  возникают — они в фазе 04 (`E_PACK_INSTALL_TIMEOUT` / `E_PACK_INSTALL_FAILED`).

  **Security — валидация имени и редактирование ошибок:**
  - `name`, полученное при детекции (`detectPack`, общая логика с фазой 00),
    должно быть одним безопасным сегментом пути: `/^[A-Za-z0-9._-]+$/`, и не
    `.`/`..` (для npm-плагинов проверка мягче — `name` может быть
    scoped-именем `@scope/name`, так как оно никогда не становится сегментом
    пути на диске, а передаётся прямо в `opencode plugin <name>`). Если имя
    небезопасно (например, резолвится в `..`) — `E_PACK_INVALID_REF` **до**
    любой файловой операции; раньше это не проверялось, и такое имя могло
    привести к тому, что `pack/<name>/` резолвился за пределы `pack/`, а
    последующая очистка каталога перед доставкой рекурсивно удаляла не то,
    что предполагалось (вплоть до корня рабочего дерева прогона).
  - Отдельно, перед любым `removeDir` конечного каталога доставки, есть
    рантайм-проверка `isPathWithin(packDir, dest)` — второй, независимый
    слой защиты на случай, если что-то всё же обошло валидацию имени.
  - Сообщения об ошибках никогда не несут секреты: inline `mcp:<name>:<config>`
    pack ref (конфиг может содержать API-ключи в `env`-блоке) усечён до
    `mcp:<name>` во всех контекстах ошибок; учётные данные, встроенные в
    clone URL (`https://user:token@host/...`), вырезаны из текста ошибки и
    stderr git.

## 3. Шаги алгоритма

1. Если `manifest.packRef` отсутствует (smoke-test режим) → вернуть
   `PackInstallResult` с `detectedType = null`, пустым `packPath` (или путём к
   `workspace.pack` как к пустому контейнеру), пустым `registeredIn`, в
   `installLogPath` пишем строку `"smoke-test: no pack"`.
2. Иначе определить финальный `detectedType`:
   - если `manifest.packType !== "auto"` → использовать его; невалидное
     значение → throw
     `PackInstallError({ code: "E_PACK_UNKNOWN_TYPE", packRef, context: { type } })`.
   - иначе применить правила детекции из фазы 00 (по префиксу `packRef`).
3. По типу — **доставка pack в `pack/<name>/`** (только этот шаг пишет на диск
   внутри фазы 03; регистрация в `home/new/` делается фазой 04):
   - **skill (git)**: `git clone --depth 1 <ref> workspace.pack/<name>/`.
     `name` = basename URL без `.git`. Таймаут
     `runInput.timeouts.installSeconds`. Сбой clone по таймауту →
     `E_INSTALL_TIMEOUT`; по exit code → `E_INSTALL_FAILED`.
     `registeredIn = ["skills"]`, `packPath = <abs>/pack/<name>/`.
   - **skill (local)**: копирование каталога в `workspace.pack/<name>/`.
     `name` = basename пути. Если путь не существует → throw
     `PackInstallError({ code: "E_PACK_INVALID_REF", packRef, context: { ref } })`.
     `registeredIn = ["skills"]`.
   - **plugin (npm)**: `name` = часть после `npm:`; в `pack/` ничего не
     клонируем (`packPath` остаётся пустым). `registeredIn = ["plugins"]` —
     фаза 04 запустит `opencode plugin <name>` внутри уже созданного
     `HOME=home/new/run-N`.
   - **agent / command**: `name` = часть после `agent:` / `command:`; если это
     URL или путь — клон/копия одного `.md` файла в `workspace.pack/<name>.md`.
     Файл не найден → `E_PACK_INVALID_REF`. `registeredIn = ["agents"]` (или
     `["commands"]`), `packPath = <abs>/pack/<name>.md`.
   - **mcp**: `name` = часть после `mcp:`; в `pack/` не клонируем.
     `registeredIn = ["mcp"]` — фаза 04 впишет блок в `config/new.json`.
     v0.3 — полная поддержка.
   - **all**: клонировать репо в `workspace.pack/<name>/`, обойти стандартные
     подпапки `skills/`, `agents/`, `commands/`, `plugins/`; для каждого
     найденного элемента добавить соответствующую секцию в `registeredIn`.
     `plugins/` сканируется **по расширению файла** — только записи вида
     `<name>.js` / `.mjs` / `.ts` / `.mts` / `.cjs`, и только реальные файлы
     (не подкаталоги); имя плагина — та же запись без расширения.
4. Дописать в `results/install.log` итог этапа доставки: тип, name, источник,
   длительность клон/копии, exit code. Строк про plugin-установку здесь ещё
   нет — их добавит фаза 04 после применения.
5. Вернуть `PackInstallResult { packPath, detectedType, installLogPath,
   registeredIn }`.

## 4. Входные/выходные файлы

| Файл / каталог                                      | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------------------------- | ------------- | -------------------- |
| `pack/<name>/`                                      | Запись        | клон / копия pack-а  |
| `results/install.log`                               | Дополнение    | текст, построчно     |

`registeredIn` (список секций opencode-config) возвращается в
`PackInstallResult` и затем читается фазой 04 (через опциональное поле
`packInstall` в `HomeIsolationInput`, не через файл). Сама регистрация
(symlink/file/plugin/config в `home/new/run-N/`) выполняется **фазой 04**,
потому что целевые каталоги существуют только после 04-шага создания
HOME-скелета.

## 5. Edge-cases и ошибки

| Кейс                                                     | Поведение                                            | Код                      |
| -------------------------------------------------------- | ---------------------------------------------------- | ------------------------ |
| `packRef` отсутствует (smoke-test)                       | no-op, лог `"smoke-test: no pack"`, `detectedType = null` | —                   |
| git clone pack-а по таймауту                             | fail прогона                                         | `E_INSTALL_TIMEOUT`      |
| git clone private pack без auth                          | fail + подсказка про `--git`/`--ssh`                 | `E_INSTALL_FAILED`       |
| local path не существует                                 | fail                                                 | `E_PACK_INVALID_REF`     |
| неизвестный префикс packRef                              | fail                                                 | `E_PACK_INVALID_REF`     |
| `--pack-type xyz` невалидный                             | fail                                                 | `E_PACK_UNKNOWN_TYPE`    |
| `--pack-type all`, но в репо нет стандартных подпапок    | warning + пустое `registeredIn`, но не fail          | —                        |
| plugin install (таймаут/сбой)                            | обрабатывается в **фазе 04** при применении          | — (через 04)             |
| `plugins/` содержит подкаталог `foo.js/` (не файл)       | пропускается, не регистрируется                      | —                        |
| `packRef` резолвится в небезопасное имя (например `..`)  | fail до файловых операций                            | `E_PACK_INVALID_REF`     |
| `dest` доставки вышел за пределы `pack/` (defense-in-depth) | fail, `removeDir` не вызывается                    | `E_PACK_INVALID_REF`     |

> Примечание: ошибки собственно plugin-установки (`opencode plugin <name>`)
> относятся к фазе 04 (`E_PACK_INSTALL_TIMEOUT` / `E_PACK_INSTALL_FAILED`) — там,
> где pack применяется к уже созданному `HOME=home/new/run-N`. Здесь фиксируются
> только ошибки **доставки** pack в `pack/` (clone/copy/local path) и валидации
> ref/type; для них зарезервированы коды `E_INSTALL_TIMEOUT` / `E_INSTALL_FAILED`.

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path skill git: `--pack github:owner/skill` → клон в
  `pack/skill/`, `detectedType = "skill"`, `registeredIn = ["skills"]`.
- ✅ happy-path plugin npm: `--pack npm:myplugin` → в `pack/` ничего не
  клонируется, `detectedType = "plugin"`, `registeredIn = ["plugins"]`
  (применяется фазой 04).
- ✅ happy-path agent: `--pack agent:./build.md` → файл скопирован в
  `pack/build.md`, `detectedType = "agent"`, `registeredIn = ["agents"]`.
- ✅ happy-path all: репо с подпапками `skills/` + `commands/` → `registeredIn`
  содержит обе секции.
- ✅ smoke-test: `packRef` отсутствует → no-op, `detectedType = null`,
  `installLogPath` содержит `"smoke-test: no pack"`.
- ✅ clone timeout: муляж git висит → throw `E_INSTALL_TIMEOUT`.
- ✅ clone failed (private repo): муляж git exit 1 + auth error → throw
  `E_INSTALL_FAILED`.
- ✅ invalid local path: `--pack ./nope` → throw `E_PACK_INVALID_REF`.
- ✅ unknown pack-type: `--pack-type xyz` → throw `E_PACK_UNKNOWN_TYPE`.
- ✅ unsafe pack name: ref резолвится в имя `..` (или другое небезопасное) →
  throw `E_PACK_INVALID_REF` до любой файловой операции.
- ✅ plugin scan by extension: `plugins/` содержит `a.js`, `b.mjs`, `c.txt`,
  подкаталог `d.js/` → регистрируются только `a` и `b`.
- ✅ error redaction: ошибка с inline `mcp:name:{"env":{"KEY":"secret"}}` в
  контексте содержит только `mcp:name`; ошибка git clone с
  `https://user:token@host/repo` в URL не содержит `user:token@` в
  сообщении/контексте.
- ❌ НЕ покрыто (ticket): полная mcp-семантика (v0.3) — фаза mcp возвращает
  `detectedType = "mcp"`, `registeredIn = ["mcp"]` и помечается
  `mcpUnsupported: true` в логе.

## 7. Инварианты

- После фазы pack **доставлен ровно один раз** в `pack/<name>/` для типов
  skill/agent/command/all (или не доставлен в smoke-test режиме и для
  plugin/mcp, где `pack/` не нужен).
- `detectedType` ∈ всех значений `PackType` либо `null` (только smoke-test).
- `registeredIn` — подмножество `{skills, plugins, agents, commands, mcp}`;
  пуст только в smoke-test режиме или при `all` без стандартных подпапок.
- Фаза 03 **не создаёт** ничего в `home/new/run-N/` — физическая регистрация
  (symlink/file/plugin/config) выполняется фазой 04 по `registeredIn` и
  `manifest.packType`.
- Сторона **old** pack-а не получает ни на каком шаге (проверяется фазой 05,
  baseline-identical gate).
- `results/install.log` существует и содержит хотя бы одну запись (даже в
  smoke-test режиме).
- Доставка пакета никогда не пишет/не удаляет что-либо за пределами
  `pack/<name>/` — имя проверяется на безопасность при детекции, и
  дополнительно рантайм-проверкой перед любым `removeDir`.
- Сообщения об ошибках и контекст ошибок никогда не содержат секретов из
  inline `mcp:`-конфига или credentials из clone URL.

## 8. Зависимости от других фаз

- Зависит от: **01 workspace-setup** (`Manifest`, `WorkspaceTree.pack`).
- Блокирует: **04 home-isolation** (нужно `registeredIn` и `detectedType` для
  регистрации pack в `home/new/` — передаётся через поле `packInstall` в
  `HomeIsolationInput`), **05
  preflight** (pack-visibility gate проверяет, что pack виден на стороне new).
- Параллелизуется с: **02 repo-clone** (clone тестируемого репо и доставка
  pack в `pack/` независимы).
- **Разделение с 04:** фаза 03 доставляет pack в `pack/` (skill/agent/command/all)
  и формирует `registeredIn` — список секций регистрации. Фаза 04 **применяет**
  pack — создаёт симлинки/файлы в `home/new/run-N/`, запускает
  `opencode plugin <name>` для plugin-типа, вписывает mcp-блок в `config/new.json`.
  Разделение обязательно: целевые каталоги `home/new/run-N/` существуют только
  после 04-шага создания HOME-скелета, а по схеме зависимостей 03 идёт раньше
  04.
