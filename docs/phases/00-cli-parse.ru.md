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
  - `E_MODEL_UNAVAILABLE` — значение `--model` или `--preflight-model` не
    соответствует паттерну `provider/model` / `provider:model`
    (`MODEL_REF_PATTERN`). Это только проверка формата: фактическую
    доступность модели у провайдера эта фаза не проверяет — этим займётся
    `05 preflight`.
  - Прочие ошибки валидации (`--prompt` обязателен, `--runs` ≥ 1, `--isolation`
    ∈ {home, docker}, неизвестный флаг, неразрешимый `@file`) тоже уходят в
    `CliParseError` с кодом `E_CONFIG_INVALID`, детальным `message` и exit code
    64 (EX_USAGE).

`RunInput` (общий тип из `contract/main.tsp`) содержит: `repoUrl`, `packRef?`,
`packType?`, `prompt`, `promptFiles?`, `init?`, `initFiles?`, `initSide`
(`InitSide`), `verify?`, `runs` (int32), `isolation` (`IsolationMode`),
`dockerNetwork?`, `opencodeVersion?`, `auth` (`AuthWhitelist`), `pureBaseline`
(boolean), `judge?`, `judgeFiles?`, `preflightEnabled` (boolean),
`preflightModel?`, `model?`, `formats` (`OutputFormat[]`), `outputPath`,
`diffHtml` (boolean), `protectGit` (boolean), `collapseRepeats` (boolean),
`timelineMode` (`TimelineMode`), `timeouts` (`TimeoutConfig`),
`workspacePath`, `logLevel` (`LogLevel`), `pricingPath?`. Все поля
обязательные, кроме явно помеченных `?`.

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
- `initSide` (`InitSide`: `both | new | old`) — `both` по умолчанию (`--init-side
  <side>`). Определяет, какая сторона(ы) фазы 06 реально выполняет `--init` (см.
  `docs/phases/06-run-side.ru.md`). `both` верно для подготовки окружения
  (установка зависимостей и т.п.), которая нужна обеим сторонам для честного
  сравнения — историческое и единственное поведение до появления флага. Но если
  `--init` — это на самом деле ТРИГГЕР тестируемого пакета (например, slash-команда
  `/graphify .`), `both` ломает `--pure-baseline`: baseline-сторона тоже получает
  триггер, не находит команду и способна сама поставить и вызвать пакет —
  реальный инцидент, из-за которого появился флаг. `new` отправляет `--init`
  только на сторону с пакетом; `old` — только на baseline (редкий кейс). Если
  `--pure-baseline` включён (default) и `initSide` ∈ {`both`, `old`}, а текст
  `--init` похож на упоминание пакета (совпадает короткое имя пакета из `--pack`,
  включая слэш-триггер вида `/<name>`), `src/cli/pipeline.ts`
  (`initPackContaminationWarning`) печатает warning в stderr — не fail, просто
  громкий сигнал, что сравнение может быть загрязнено. Значение сохраняется в
  `flagDefaults.initSide` (см. шаг 6 и `Manifest.flagDefaults`) — у самого отчёта
  нет отдельной секции "параметры прогона", это единственное место, где значение
  видно постфактум.
- `protectGit` — `false` по умолчанию (`--protect-git` / `--no-protect-git`).
  Если `true`: фаза 02 переносит `.git` каждого прогона за пределы примонтированного
  дерева (`gitdirs/<side>/run-N/`, см. `docs/phases/02-repo-clone.ru.md`), фаза 08
  работает с ним через `--git-dir`/`--work-tree` и **не** запускает восстановление
  `.git` (см. `docs/phases/08-diff.ru.md`, раздел про protect-git). Цена: exports
  теряют snapshot/patch-части opencode (нужен `/workspace/.git`), а
  `review.code-workspace` (фаза 12) теряет git-декорации в редакторе для защищённых
  прогонов — обе стороны платы явно задокументированы, не только здесь. При
  `isolation = "home"` защита слабая (агент работает без песочницы, может дойти до
  `gitdirs/` по пути) — предупреждение печатается один раз (`src/cli/pipeline.ts`).
- `timeouts` (`TimeoutConfig`) — `preflightSeconds`, `runSeconds`,
  `verifySeconds`, `installSeconds`, `watchdogSeconds`, опциональный
  `totalSeconds`.
- `model` — необязательная модель (`provider/model` или `provider:model`) для
  **обеих** сторон прогона. Приоритет: `--model` (CLI) > `model` в
  `.testaipack/config.json` > ambient-модель из реального
  `~/.config/opencode/opencode.json` пользователя — второй уровень fallback
  применяется уже в фазе 04 (см. `docs/phases/04-home-isolation.ru.md`), эта
  фаза лишь передаёт значение (или его отсутствие) дальше. Флаг не задан ⇒
  `RunInput.model === undefined` ⇒ поведение полностью совпадает с состоянием
  до появления флага. Валидируется тем же паттерном, что и `preflightModel`
  (см. `E_MODEL_UNAVAILABLE` выше).
- `dockerNetwork` — необязательный `docker run --network <mode>` для
  `--isolation=docker` (флаг `--docker-network`). Свободная строка, не enum:
  Docker принимает `bridge`/`host`/`none`, `container:<name>` и произвольные
  имена пользовательских сетей — enum сузил бы это без пользы, а невалидное
  значение всё равно упадёт с понятной ошибкой на `docker run`. Флаг не задан
  ⇒ `RunInput.dockerNetwork === undefined` ⇒ `--network` вообще не передаётся
  в `docker run` (сегодняшнее поведение, дефолтный bridge Docker). Игнорируется
  в `home`-изоляции. Потребляется фазами 04/05/06 (см. `docker-runner.ts`
  `buildDockerRunArgs`).

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
   отвечает на `docker info` (быстрая проверка с таймаутом 3s) — понизить до
   `home`, не фейля прогон. В `RunInput` записать уже пониженное значение, а в
   `flagDefaults` (поле `Manifest`, см. фазу 01) приписать флаг
   `dockerDowngraded: true`. Фаза 00 сама остаётся чистой (никаких
   `console`/stderr здесь) — фактический warning печатает orchestrator
   (`src/cli/pipeline.ts`, `dockerDowngradeWarning`), читая этот флаг сразу
   после вызова `cliParse`, до `reporter.header`.
7. Валидировать `--timeline-mode ∈ {side-by-side, tree-diff, merged}`,
   `--log-level ∈ {debug, info, warn, error}`, `--init-side ∈ {both, new, old}`.
   Любое нарушение → `E_CONFIG_INVALID`. `--init-side` без флага и без
   config-file → `both` (`DEFAULT_INIT_SIDE`), записывается в
   `flagDefaults.initSide`, чтобы значение было видно постфактум в отчёте и
   манифесте. Если `--pure-baseline`
   включён (default) и резолвенный `initSide` ∈ {`both`, `old`}, а текст `--init`
   похож на упоминание пакета из `--pack` — orchestrator
   (`src/cli/pipeline.ts`, `initPackContaminationWarning`) печатает warning в
   stderr тем же способом, что и `dockerDowngradeWarning` выше (фаза 00 сама
   ничего не печатает). Выбор IDE для review-workspace (`vscode | cursor |
   code-insiders`) и параметр `--review-run` живут в `flagDefaults` и фазой 00
   отдельно не валидируются.
8. Валидировать `--model <provider/model>` (и независимо `--preflight-model`)
   тем же паттерном `provider/model` / `provider:model`; несоответствие формату
   → `E_MODEL_UNAVAILABLE`. Слияние `--model` ← config-file `model` ← default
   идёт по общему правилу шага 3 (CLI побеждает); при отсутствии обоих
   `RunInput.model` не задаётся.
9. Определить `packType` (если не задан `--pack-type` явно) по префиксу
   `packRef`:
   - `npm:<name>` → `plugin`
   - `mcp:<name>` → `mcp`
   - `agent:<path>` → `agent`, `command:<path>` → `command`
   - `https://…git`, `git@…`, `github:…` → `skill` (дефолтный для git-like refs)
   - `/abs/path` или `./rel` → `skill` (локальный)
   - `--pack` отсутствует → `packRef` не задаётся (smoke-test).
10. Проверить, что хотя бы один формат отчёта указан (`--format` по умолчанию
    `["md"]`); `all` раскрывается в `["md","html","json","yaml"]`.
11. Вернуть `CliParseResult { runInput, configSource }`.

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
| `--init-side` не задан                             | `RunInput.initSide = "both"` (историческое поведение)      | —                            |
| Невалидный `--init-side foo`                       | Fail прогона, exit 64                                      | `E_CONFIG_INVALID`           |
| `--init` похож на триггер `--pack`, `--pure-baseline` on, `initSide` ∈ {both, old} | Warning в stderr (не fail), см. `initPackContaminationWarning` | — |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: минимальный `run <url> --prompt "fix bug"` без config-file →
  `RunInput` без `packRef`, `runs = 3`, `isolation = "home"`, `formats =
  ["md"]`, `pureBaseline = true`, `configSource = "cli"`.
- ✅ config-file + CLI override: config задаёт `runs: 5`, CLI передаёт
  `--runs 2` → итоговое `runs = 2` (CLI побеждает), `configSource = "merged"`.
- ✅ `@file` промпт: `--prompt @prompts/fix.md` → `prompt` содержит
  содержимое файла, путь приписан в `promptFiles`; несколько файлов
  конкатенированы в порядке флагов.
- ✅ docker-downgrade (эта фаза, `00-cli-parse.test.ts`): `--isolation docker`,
  демон не отвечает → `RunInput.isolation = "home"`,
  `flagDefaults.dockerDowngraded = true`. Сам stderr-warning — не эта фаза, см.
  `dockerDowngradeWarning` в `src/cli/pipeline.test.ts`.
- ✅ `--docker-network host` парсится в `RunInput.dockerNetwork = "host"`;
  без флага поле отсутствует.
- ✅ smoke-test: `run <url> --prompt "x"` без `--pack` → поле `packRef`
  отсутствует.
- ✅ pack-type auto-detect: `--pack npm:myplugin` → `packType = "plugin"`;
  `--pack github:owner/skill` → `"skill"`; `--pack ./local/skill` → `"skill"`.
- ✅ missing `--prompt` → throw `E_CONFIG_INVALID`, exit 64.
- ✅ invalid `--runs 0` → throw `E_CONFIG_INVALID`, exit 64.
- ✅ invalid `@file` path → throw `E_CONFIG_INVALID`.
- ✅ invalid `--isolation foo` → throw `E_CONFIG_INVALID`.
- ✅ model format invalid: `--model` или `--preflight-model` не соответствует
  паттерну `provider/model` / `provider:model` → throw `E_MODEL_UNAVAILABLE`.
- ✅ `--model` flag: `--model anthropic/claude-x` → `RunInput.model =
  "anthropic/claude-x"`.
- ✅ `--model` через config-file: `.testaipack/config.json` задаёт `model`,
  `--model` в CLI не передан → `RunInput.model` берётся из файла; если оба
  заданы — CLI побеждает.
- ✅ `--model` не задан (ни CLI, ни config-file) → `RunInput.model` остаётся
  `undefined`, downstream-поведение (фаза 04) не меняется.
- ✅ `--init-side` не задан → `RunInput.initSide = "both"`.
- ✅ `--init-side new` / `--init-side old` парсятся в `RunInput.initSide`.
- ✅ config-file `initSide` учитывается; CLI `--init-side` побеждает над ним.
- ✅ резолвенный `initSide` пишется в `flagDefaults.initSide`.
- ✅ invalid `--init-side foo` → throw `E_CONFIG_INVALID`.
- ✅ contamination-warning (не эта фаза, `src/cli/pipeline.test.ts`,
  `initPackContaminationWarning`): `--pure-baseline` on, `initSide` ∈
  {`both`,`old`}, `--init` содержит короткое имя пакета из `--pack` → warning в
  stderr, упоминает `--init-side new`; `initSide = "new"` уже само по себе
  снимает предупреждение, как и `--pure-baseline` off или `--init`, не
  упоминающий пакет.
- ✅ init-side routing (не эта фаза, `06-run-side.test.ts`): `initSide = "new"`
  на стороне `old` → `--init` пропускается (`run` вызывается один раз, без
  `--continue`), лог содержит `[INIT] skipped on side=old (--init-side new)`;
  на стороне `new` — выполняется как обычно.
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
- `RunInput.initSide` всегда одно из `{both, new, old}`; `flagDefaults.initSide`
  зеркалирует резолвенное значение тем же путём, что `dockerDowngraded`.
- Никаких побочных эффектов на диск: фаза чистая и детерминированная
  (только чтение файлов по известным путям).

## 8. Зависимости от других фаз

- Зависит от: — (это вход в pipeline).
- Блокирует: **01 workspace-setup** (получает `RunInput`), а через него — все
  остальные фазы. Любая ошибка здесь обрывает весь прогон до создания
  workspace.
- Параллелизуется с: — (ничем; синхронный вход).
