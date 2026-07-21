# Фаза 00: cli-parse

> Спека фазы. Контракт = `contract/phases/00-cli-parse.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Распарсить аргументы командной строки `testaipack run`, слить их с опциональным
`.testaipack/config.json`, провалидировать и выдать на выходе canonical
`RunInput` — единственное, что видят все downstream-фазы. Любая ошибка здесь
фейлит весь прогон до создания workspace.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.CliParse` (см. `contract/phases/00-cli-parse.tsp`).

- Вход: `CliParseInput` — `{ argv: string[], cwd: string, configFile?: string }`.
  Первый элемент `argv` — имя субкоманды (`run` / `review` / `report` /
  `compare` / `gc` / `list` / `init` / `doctor`); эта фаза обрабатывает только
  ветку `run`, остальные передаются дальше без изменений.
- Выход: `CliParseResult` — `{ runInput: RunInput, configSource: "cli" |
  "config" | "merged" }`. `configSource` фиксирует, откуда взялись значения
  итоговой конфигурации.
- Ошибки: `@error CliParseError` — `{ code, message, context? }`, где `code`
  принимает только значения:
  - `E_CONFIG_INVALID` — `.testaipack/config.json` есть, но не парсится или
    нарушает Zod-схему `ConfigFile`.
  - `E_MODEL_UNAVAILABLE` — запрошенная модель недоступна у провайдера auth
    (определяется заранее по whitelist auth).
  - Прочие ошибки валидации (`--prompt` обязателен, `--runs` ≥ 1, `--isolation`
    ∈ {home, docker}, неизвестный флаг, неразрешимый `@file`) тоже уходят в
    `CliParseError` с кодом `E_CONFIG_INVALID`, детальным `message` и exit code
    64 (EX_USAGE).

`RunInput` (общий тип из `contract/main.tsp`) содержит: `repoUrl`, `packRef?`,
`packType?`, `prompt`, `promptFiles?`, `init?`, `initFiles?`, `verify?`, `runs`
(int32), `isolation` (`IsolationMode`), `opencodeVersion?`, `auth`
(`AuthWhitelist`), `pureBaseline` (boolean), `judge?`, `judgeFiles?`,
`preflightEnabled` (boolean), `preflightModel?`, `formats` (`OutputFormat[]`),
`outputPath`, `diffHtml` (boolean), `collapseRepeats` (boolean), `timelineMode`
(`TimelineMode`), `timeouts` (`TimeoutConfig`), `workspacePath`, `logLevel`
(`LogLevel`), `pricingPath?`. Все поля обязательные, кроме явно помеченных `?`.

Ключевые поля `RunInput`:

- `packRef` — строка, по которой `pack-install` определит тип пакета.
  Отсутствие поля (optional) означает **smoke-test режим** (baseline vs
  baseline, pack-фаза становится no-op, см. фазу 03).
- `prompt` / `init` / `verify` — уже прочитанный из `@file` или переданный
  строкой текст. Соответствующие `*Files?: string[]` хранят пути исходных
  `@file`-ов (несколько `@file` конкатенируются в порядке флагов через `\n\n`).
- `auth` (`AuthWhitelist`) — boolean-флаги на каждый источник credentials
  (`opencode`, `npmrc`, `anthropic`, `openai`, `gemini`, `aws`, `ssh`, `git`),
  потребляется фазой 04.
- `pureBaseline` — `true` по умолчанию; если `true`, baseline-сторона получает
  `OPENCODE_PURE=1` (см. `EnvVarSet` в фазе 04).
- `timeouts` (`TimeoutConfig`) — `preflightSeconds`, `runSeconds`,
  `verifySeconds`, `installSeconds`, `watchdogSeconds`, опциональный
  `totalSeconds`.

## 3. Шаги алгоритма

1. Разобрать `argv` через `clipanion`/`citty`; извлечь субкоманду. Если это не
   `run` — вернуть `CliParseResult` с пометкой `subcommand` в `configSource` и
   выйти (эта фаза не валидирует флаги не-`run` команд).
2. Прочитать `.testaipack/config.json` относительно `cwd`, если файл существует,
   и записать путь в `CliParseInput.configFile`. Если существует, но не валиден
   как JSON или не проходит Zod-схему `ConfigFile` → throw
   `CliParseError({ code: "E_CONFIG_INVALID", context: { file, zodError } })`.
3. Слить `config-file` ← `CLI`: значения из CLI побеждают; отсутствующие в CLI
   берутся из файла; если ни там ни там нет — берётся значение по умолчанию из
   таблицы флагов. `configSource` = `"cli"` если всё из CLI, `"config"` если всё
   из файла, `"merged"` если смешание.
4. Обработать `--prompt` и `--init`/`--judge`: если значение имеет форму
   `@path` — прочитать файл и приписать путь в `promptFiles`/`initFiles`/
   `judgeFiles`. Несуществующий файл → throw
   `CliParseError({ code: "E_CONFIG_INVALID", context: { reason: "file not found", path } })`.
   Несколько `@file` конкатенировать в порядке следования флагов. Если значения
   нет ни в `--prompt`, ни в config-file и субкоманда `run` → throw
   `CliParseError({ code: "E_CONFIG_INVALID", context: { reason: "--prompt required" } })`.
5. Валидировать `--runs ≥ 1`; иначе `E_CONFIG_INVALID({ reason: "runs must be ≥1" })`.
6. Валидировать `--isolation ∈ {home, docker}`. Если `docker`, но демон не
   отвечает на `docker info` (быстрая проверка с таймаутом 3s) — выдать
   warning в stderr и прозрачно понизить до `home`, не фейля прогон. В `RunInput`
   записать уже пониженное значение, а в `flagDefaults` (поле `Manifest`, см.
   фазу 01) приписать флаг `dockerDowngraded: true`.
7. Валидировать `--timeline-mode ∈ {side-by-side, tree-diff, merged}`,
   `--log-level ∈ {debug, info, warn, error}`. Любое нарушение →
   `E_CONFIG_INVALID`. Выбор IDE для review-workspace (`vscode | cursor |
   code-insiders`) и параметр `--review-run` живут в `flagDefaults` и фазой 00
   отдельно не валидируются.
8. Определить `packType` (если не задан `--pack-type` явно) по префиксу
   `packRef`:
   - `npm:<name>` → `plugin`
   - `mcp:<name>` → `mcp`
   - `agent:<path>` → `agent`, `command:<path>` → `command`
   - `https://…git`, `git@…`, `github:…` → `skill` (дефолтный для git-like refs)
   - `/abs/path` или `./rel` → `skill` (локальный)
   - `--pack` отсутствует → `packRef` не задаётся (smoke-test).
9. Проверить, что хотя бы один формат отчёта указан (`--format` по умолчанию
   `["md"]`); `all` раскрывается в `["md","html","json","yaml"]`.
10. Вернуть `CliParseResult { runInput, configSource }`.

## 4. Входные/выходные файлы

| Файл                              | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------- | ------------- | -------------------- |
| `.testaipack/config.json`         | Чтение        | `ConfigFile`         |
| файлы по ссылкам `@file` в флагах | Чтение        | UTF-8 текст          |

Фаза не пишет на диск; её результат живёт только в памяти и передаётся в
`workspace-setup`.

## 5. Edge-cases и ошибки

| Кейс                                              | Поведение                                                  | Код                          |
| ------------------------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| `.testaipack/config.json` не существует           | Игнорируем, все значения из CLI + defaults                 | —                            |
| config.json есть, но битый JSON                   | Fail прогона, exit 64                                      | `E_CONFIG_INVALID`           |
| `--prompt` не задан и нет в config                | Fail прогона, exit 64                                      | `E_CONFIG_INVALID`           |
| `@file` указывает на несуществующий путь          | Fail прогона                                               | `E_CONFIG_INVALID`           |
| `--runs 0` или отрицательное                      | Fail прогона                                               | `E_CONFIG_INVALID`           |
| `--isolation docker`, демон недоступен            | Warning + fallback на `home`, прогон продолжается          | — (downgrade)                |
| `--pack` не задан                                  | Smoke-test режим: `packRef = null`                         | —                            |
| Неизвестный флаг                                   | Fail прогона, exit 64                                      | `E_CONFIG_INVALID`           |
| `--format all`                                     | Раскрыть в `[md, html, json, yaml]`                        | —                            |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: минимальный `run <url> --prompt "fix bug"` без config-file →
  `RunInput` без `packRef`, `runs = 3`, `isolation = "home"`, `formats =
  ["md"]`, `pureBaseline = true`, `configSource = "cli"`.
- ✅ config-file + CLI override: config задаёт `runs: 5`, CLI передаёт
  `--runs 2` → итоговое `runs = 2` (CLI побеждает), `configSource = "merged"`.
- ✅ `@file` промпт: `--prompt @prompts/fix.md` → `prompt` содержит
  содержимое файла, путь приписан в `promptFiles`; несколько файлов
  конкатенированы в порядке флагов.
- ✅ docker-downgrade: `--isolation docker`, демон не отвечает → warning в
  stderr, `RunInput.isolation = "home"`, `flagDefaults.dockerDowngraded = true`.
- ✅ smoke-test: `run <url> --prompt "x"` без `--pack` → поле `packRef`
  отсутствует.
- ✅ pack-type auto-detect: `--pack npm:myplugin` → `packType = "plugin"`;
  `--pack github:owner/skill` → `"skill"`; `--pack ./local/skill` → `"skill"`.
- ✅ missing `--prompt` → throw `E_CONFIG_INVALID`, exit 64.
- ✅ invalid `--runs 0` → throw `E_CONFIG_INVALID`, exit 64.
- ✅ invalid `@file` path → throw `E_CONFIG_INVALID`.
- ✅ invalid `--isolation foo` → throw `E_CONFIG_INVALID`.
- ✅ model unavailable: запрошена модель, для которой нет auth у провайдера →
  throw `E_MODEL_UNAVAILABLE`.
- ❌ НЕ покрыто (ticket): `compare <id1> <id2>` — валидация существования обоих
  run-id делается в отдельной субкоманде, не в этой фазе.

## 7. Инварианты

- После фазы `RunInput` полностью заполнен: любое downstream-чтение должно
  находить значение без `undefined`-фоллбэков (все обязательные поля
  не-optional).
- `prompt` ≠ пустой строке для субкоманды `run`.
- `runs ≥ 1`, `isolation` уже понижено до `home` если docker-демена нет.
- `flagDefaults.dockerDowngraded` (зеркалируется в `Manifest` фазой 01)
  однозначно отличает явный запрос `docker` от default `home`, чтобы отчёт мог
  показать предупреждение пользователю.
- Никаких побочных эффектов на диск: фаза чистая и детерминированная
  (только чтение файлов по известным путям).

## 8. Зависимости от других фаз

- Зависит от: — (это вход в pipeline).
- Блокирует: **01 workspace-setup** (получает `RunInput`), а через него — все
  остальные фазы. Любая ошибка здесь обрывает весь прогон до создания
  workspace.
- Параллелизуется с: — (ничем; синхронный вход).
