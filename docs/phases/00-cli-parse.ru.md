# Фаза 00: cli-parse

> Спека фазы. Контракт = `contract/phases/00-cli-parse.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Распарсить аргументы командной строки `testaipack run`, слить их с опциональным
`.testaipack/config.json`, провалидировать и выдать на выходе canonical
`RunInput` (`schemaVersion: 2`) — единственное, что видят все downstream-фазы.
Любая ошибка здесь фейлит весь прогон до создания workspace.

С n-way variants (`.research/n-way-variants/00-overview.md`) фаза работает в
одном из двух режимов:

- **variant-режим** — конфиг-файл содержит ключ `variants`: `RunInput.packs`/
  `variants`/`baseline`/`parallel` собираются напрямую из `variants`/`packs` в
  `.testaipack/config.json` (у variant-режима нет CLI-флагов для описания
  самих вариантов — только конфиг-файл).
- **legacy-режим** (по умолчанию, если `variants` в конфиге нет) — классические
  флаги `--pack`/`--prompt`/`--init`/`--init-side`/`--pure-baseline`/… **дезагарируются**
  этой же фазой в ровно два варианта `old`/`new` (см. §3.4). Этот путь
  поддерживается бессрочно, не помечен deprecated.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.CliParse` (см. `contract/phases/00-cli-parse.tsp`).

- Вход: `CliParseInput` — `{ argv: string[], cwd: string, configFile?: string }`.
  Первый элемент `argv` — имя субкоманды (`run` / `review` / `report` /
  `compare` / `gc` / `list` / `init` / `doctor`); эта фаза обрабатывает только
  ветку `run`, остальные передаются дальше без изменений.
- Выход: `CliParseResult` — `{ runInput: RunInput, configSource: "cli" |
  "config" | "merged" }`. `configSource` фиксирует, откуда взялись значения
  итоговой конфигурации (`"merged"`, если хотя бы одно значение из CLI и хотя
  бы одно из config-файла; variant-режим всегда добавляет `"config"` в этот
  расчёт, потому что сам список вариантов идёт только из файла).
- Ошибки: `@error CliParseError` — `{ code, message, context? }`, где `code`
  принимает только значения:
  - `E_CONFIG_INVALID` — `.testaipack/config.json` есть, но не парсится или
    нарушает Zod-схему `ConfigFile`; любая из десятков валидаций ниже (§3, §5);
    итоговый `RunInput` не проходит `runInputSchema` (защитная финальная
    проверка).
  - `E_MODEL_UNAVAILABLE` — значение `--model` или `--preflight-model` не
    соответствует паттерну `provider/model` / `provider:model`
    (`MODEL_REF_PATTERN`). Это только проверка формата: фактическую
    доступность модели у провайдера эта фаза не проверяет — этим займётся
    `05 preflight`.

`RunInput` (v2, общий тип из `contract/main.tsp`) содержит: `schemaVersion: 2`,
`repoUrl`, `prompt?` (глобальный дефолт, опционален — валиден эффективный
промпт на каждый вариант, см. ниже), `promptFiles?`, `init?` (глобальный
дефолт), `initFiles?`, `hint?` (глобальный дефолт — преемник `packHint`),
`verify?`, `model?`, `runs`, **`parallel`** (int32, дефолт 2 — максимум
вариантов, исполняемых одновременно в фазе 06), **`baseline`** (имя варианта,
дефолт — имя первого варианта), **`packs: PackSpec[]`** (реестр паков
эксперимента, может быть пуст), **`variants: VariantSpec[]`** (минимум один),
`isolation`, `dockerNetwork?`, `opencodeVersion?`, `auth`, `judge?`,
`judgeFiles?`, `preflightEnabled`, `preflightModel?`, `formats`, `outputPath`,
`diffHtml`, `protectGit`, `collapseRepeats`, `timelineMode`, `timeouts`,
`workspacePath`, `logLevel`, `pricingPath?`. `Side`/`InitSide` **удалены** из
контракта — на wire их больше нет ни в каком виде.

`PackSpec` (регистр паков): `{ name, ref, type?, setup?, check? }`. `name` —
ключ реестра, на который ссылается `VariantSpec.packs`; `ref` — тот же смысл,
что у старого `RunInput.packRef` (git URL / npm-pkg / локальный путь /
`mcp:<name>:<config>`).

`VariantSpec` (одно плечо эксперимента): `{ name, packs: string[], prompt?,
init?, model?, hint?, pure?, verify?, exercise?, allowPacks? }`.
`prompt`/`init`/`model`/`hint`/`verify` — опциональные оверрайды
одноимённого глобального поля `RunInput`; отсутствие поля наследует глобальное
значение, явная пустая строка (`""`) явно ОТКЛЮЧАЕТ наследование (решение D7,
`.research/n-way-variants/00-overview.md §5`) — это единственный способ
сказать «у этого варианта нет init/hint/verify, даже если у остальных есть».
`pure?` — управляет тремя переменными чистоты (фаза 04); дефолт
`packs.length === 0` (D1). `exercise?` — преемник `--pack-exercise`, теперь
per-variant. `allowPacks?` — имена паков, чей `check` разрешено «неожиданно»
пройти в HOME этого варианта без провала гейта 6 (преемник
`--allow-baseline-tool`, теперь per-(variant, pack), см.
`docs/phases/05-preflight.ru.md`).

Ключевые поля `RunInput`:

- `packs` / `variants` — единственный источник правды о том, кто и с чем
  сравнивается. В legacy-режиме их строит **эта же фаза** десугаром флагов
  (см. §3.4); в variant-режиме они читаются из `config.json` как есть (после
  `@file`-резолва текстовых полей и разрешения имён паков, см. §3.2–§3.3).
- `baseline` — имя варианта, с которым сравниваются остальные. По умолчанию —
  имя первого варианта в списке (`variants[0].name`). В legacy-режиме это
  всегда `"old"`.
- `parallel` — максимум вариантов, выполняемых параллельно в фазе 06
  (`Effect.all(variants.map(runOneVariant), { concurrency: parallel })`).
  Прогоны **внутри** одного варианта всегда последовательны. Дефолт `2` —
  сохраняет сегодняшнее поведение двустороннего шима (`old ‖ new`).
- `hint` — глобальный дефолт-текст, добавляемый к промпту КАЖДОГО варианта, у
  которого нет собственного `hint`; при явном `--pack-hint`/config-file-ключе
  `packHint` — тот же эффект (устаревший алиас `--hint`, оставлен ради
  существующих скриптов).
- `auth` (`AuthWhitelist`) — boolean-флаги на каждый источник credentials
  (`opencode`, `npmrc`, `anthropic`, `openai`, `gemini`, `aws`, `ssh`, `git`),
  потребляется фазой 04.
- `protectGit` — `false` по умолчанию (`--protect-git` / `--no-protect-git`).
  Если `true`: фаза 02 переносит `.git` каждого прогона за пределы примонтированного
  дерева (`gitdirs/<variant>/run-N/`, см. `docs/phases/02-repo-clone.ru.md`), фаза 08
  работает с ним через `--git-dir`/`--work-tree` и **не** запускает восстановление
  `.git` (см. `docs/phases/08-diff.ru.md`, раздел про protect-git). Цена: exports
  теряют snapshot/patch-части opencode (нужен `/workspace/.git`), а
  `review.code-workspace` (фаза 12) теряет git-декорации в редакторе для защищённых
  прогонов. При `isolation = "home"` защита слабая — предупреждение печатается один раз
  (`src/cli/pipeline.ts`, `protectGitHomeWarning`).
- `timeouts` (`TimeoutConfig`) — `preflightSeconds`, `runSeconds`,
  `verifySeconds`, `installSeconds`, `watchdogSeconds`, опциональный
  `totalSeconds`.
- `model` — необязательная модель (`provider/model` или `provider:model`) —
  глобальный дефолт для КАЖДОГО варианта; свой `model` на варианте
  переопределяет его. Приоритет: `--model` (CLI) > `model` в
  `.testaipack/config.json` > ambient-модель из реального
  `~/.config/opencode/opencode.json` пользователя (второй уровень fallback —
  в фазе 04). Флаг не задан ⇒ `RunInput.model === undefined`.
- `dockerNetwork` — необязательный `docker run --network <mode>` для
  `--isolation=docker` (флаг `--docker-network`). Свободная строка, не enum.
  Не задан ⇒ `--network` не передаётся в `docker run`. Игнорируется в
  `home`-изоляции.

## 3. Шаги алгоритма

1. Разобрать `argv` (собственный токенайзер по таблицам `VALUE_FLAGS`/
   `BOOLEAN_FLAGS`, `src/phases/00-cli-parse.ts`); извлечь субкоманду. Если это
   не `run` — вернуть `CliParseResult` без валидации run-специфичных флагов.
2. Прочитать `.testaipack/config.json` относительно `cwd`, если файл существует
   (`configFileSchema`, `.strict()` — неизвестный ключ фейлит парсинг). Если
   существует, но не валиден как JSON или не проходит Zod-схему →
   `E_CONFIG_INVALID`.
3. **Определить режим**: `variants` присутствует в конфиге ⇒ variant-режим;
   иначе ⇒ legacy-режим (§3.4).
4. **В variant-режиме** — сразу проверить, что ни один из
   variant-shaping-легаси-ключей/флагов не задан одновременно с `variants`:
   `--pack`/`packRef`, `--pack-type`/`packType`, `--pure-baseline`/
   `--no-pure-baseline`/`pureBaseline`, `--init-side`/`initSide`,
   `--pack-setup`/`packSetup`, `--pack-check`/`packCheck`,
   `--pack-exercise`/`packExercise`, `--allow-baseline-tool`/
   `allowBaselineTool`, `--pack-hint`/`packHint`. Нарушение → `E_CONFIG_INVALID`
   с `reason: "legacy-flag-with-variants"`, называющим конкретный ключ.
   `--hint`/`hint` (новый глобальный дефолт) в этот список **не входит** —
   он разрешён в обоих режимах.
5. Слить `config-file` ← `CLI` для глобальных полей (`prompt`, `init`, `model`,
   `verify`, `judge`, `runs`, `isolation`, `formats`, timeouts, auth, …):
   CLI побеждает; отсутствующее в CLI берётся из файла; иначе — дефолт.
   `configSource` = `"cli"`/`"config"`/`"merged"` по факту, откуда что взято
   (variant-режим всегда учитывается как вклад `"config"`, даже если все
   остальные поля пришли из CLI — сам список вариантов идёт только из файла).
6. Обработать `--prompt`/`--init`/`--judge`: значение вида `@path` читается как
   файл, путь приписывается в `promptFiles`/`initFiles`/`judgeFiles`.
   Несуществующий файл → `E_CONFIG_INVALID` (`reason: "file-not-found"`).
   Несколько `@file` конкатенируются через `\n\n` в порядке флагов. В
   variant-режиме то же `@file`-разрешение применяется и к per-variant
   `prompt`/`init`/`hint` (каждое поле — отдельным вызовом `resolveTextSpecs`,
   `resolveOneVariantText`). Глобальный `prompt` в v2 — **опционален**:
   вместо «`--prompt` обязателен» проверяется, что у КАЖДОГО варианта есть
   эффективный (свой или унаследованный) непустой промпт — см. шаг 9.
7. Валидировать `--runs ≥ 1` → `E_CONFIG_INVALID` (`reason: "runs-min"`).
   `--parallel ≥ 1` (дефолт `2`, константа `DEFAULT_PARALLEL`) →
   `E_CONFIG_INVALID` (`reason: "parallel-min"`).
8. Валидировать `--isolation ∈ {home, docker}`; при `docker` и недоступном
   демоне — понизить до `home`, записать `flagDefaults.dockerDowngraded: true`
   (сама фаза чистая, warning печатает `dockerDowngradeWarning` в
   `src/cli/pipeline.ts`, до `reporter.header`).
9. Валидировать `--timeline-mode`, `--log-level`, `--model`/`--preflight-model`
   (`MODEL_REF_PATTERN`, `E_MODEL_UNAVAILABLE` при несовпадении).
10. **Legacy-режим — десугар** (`desugarLegacy`, §3.4 ниже) строит
    `packs`/`variants`/`baseline` из классических флагов. **Variant-режим** —
    берёт `config.variants`/`config.packs` как есть (после `@file`-резолва).
11. **Валидация вариантов** (оба режима, после построения списка):
    - хотя бы один вариант (`reason: "no-variants"`, недостижимо в legacy-режиме);
    - имена ∈ `VARIANT_NAME_RE = ^[a-z0-9][a-z0-9-]{0,31}$` (`reason:
      "invalid-variant-name"`), не `"source"` (`reason:
      "reserved-variant-name"` — коллизия с `apps/source`), уникальны
      (`reason: "duplicate-variant-name"`);
    - каждая запись `variant.packs` резолвится в реестр: если имя уже
      зарегистрировано — используется как есть; если это «голая» ссылка
      (bare ref, не имя) — автоматически регистрируется новый `PackSpec` с
      именем `packShortName(ref)` (решение D4); совпадение имени с другим
      `ref` → `E_CONFIG_INVALID` (`reason: "pack-name-collision"`);
    - имена паков реестра ∈ `PACK_NAME_SAFE_RE = ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
      (`reason: "invalid-pack-name"`), уникальны (`reason:
      "duplicate-pack-name"`) — паковое имя становится сегментом пути
      `pack/<name>/` (фаза 03), поэтому валидируется здесь, а не только внутри
      `detectPack`;
    - `variant.allowPacks` резолвится к существующим именам реестра (`reason:
      "unknown-pack-ref"`);
    - **Stage 1 guard**: `variant.packs.length ≤ 1` (`reason:
      "multi-pack-stage2"`) — многопаковые варианты запланированы на Stage 2,
      сейчас упираются в явную ошибку, а не в молчаливое усечение;
    - `variant.exercise` требует ≥1 пака на самом варианте ИЛИ хотя бы один
      пак где-либо в прогоне (`reason: "pack-setup-without-pack"` — то же имя
      причины, что и у legacy-эквивалента ниже, ради единообразия сообщений);
    - `baseline` называет существующий вариант (`reason: "unknown-baseline"`);
    - у каждого варианта есть эффективный непустой промпт: `effectiveOf(v,
      runInput.prompt, 'prompt')` ≠ `undefined`/`""` (`reason:
      "prompt-required"`, называет вариант).
12. Определить `PackType` для каждого `PackSpec` без явного `type` —
    `detectPack(ref)` (та же логика детекции по префиксу `ref`, что раньше жила
    только в фазе 03): `npm:` → `plugin`, `mcp:` → `mcp`, `agent:`/`command:` →
    `agent`/`command`, git-подобный URL или локальный путь → `skill`.
    Невалидный ref → `E_CONFIG_INVALID`.
13. Проверить, что хотя бы один формат отчёта указан (`--format` по умолчанию
    `["md"]`); `all` раскрывается в `["md","html","json","yaml"]`.
14. Собрать `RunInput { schemaVersion: 2, ... }`, провалидировать финально
    против `runInputSchema` (защитный последний шаг — рассинхрон логики выше
    со схемой ловится здесь, а не молча уходит в фазу 01).
15. Вернуть `CliParseResult { runInput, configSource }` (плюс локальное
    расширение `flagDefaults`, `dockerImage?`, `outputPathProvided` —
    внутренний контракт оркестратора, не часть `contract/phases/00-cli-parse.tsp`).

### 3.1 Общие функции для остальных фаз (`src/phases/00-cli-parse.ts`, реэкспортированы)

```ts
export const VARIANT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const RESERVED_VARIANT_NAMES: ReadonlySet<string> = new Set(['source'])
export const packShortName = (ref: string): string => { /* короткое сравнимое имя из ref, credentials уже вычищены */ }
export const effectiveOf = (v: VariantSpec, g: string | undefined, key: 'prompt'|'init'|'model'|'hint'|'verify'): string | undefined
export const packsOf = (runInput: RunInput, v: VariantSpec): readonly PackSpec[]        // variant.packs → PackSpec[]
export const foreignPacksOf = (runInput: RunInput, v: VariantSpec): readonly PackSpec[] // union(others) − own
export const baselineOf = (runInput: RunInput): VariantSpec
```

`effectiveOf` — единственное место, где живёт правило D7: свой непустой
`v[key]` побеждает; свой `v[key] === ""` явно отключает наследование
(результат `undefined`); отсутствие поля наследует глобальное `g`. Каждая
downstream-фаза (04, 06, …) читает per-variant `prompt`/`init`/`model`/
`hint`/`verify` **только** через эту функцию — прямое чтение `variant.prompt`
без фоллбэка на глобаль было бы багом.

`packShortName` — короткое сравнимое имя из ref: срезает префикс
`npm:`/`mcp:`/`agent:`/`command:`, payload `mcp:name:config`, хвостовой
`.git`, берёт последний `/`-сегмент. **Важно**: `ref` сначала пропускается
через `redactUrlCredentials` — имя, в отличие от самого `ref`, попадает в
provenance (манифест, отчёт, промпт судьи) без редактирования, так что
`https://user:token@host/...` не должен просочиться в имя через этот путь
(раньше это было отдельным известным риском — теперь закрыто здесь же, в
точке, где имя порождается).

### 3.2 Config-схема (`configFileSchema`, `.strict()`)

Новые (n-way) ключи, все опциональные: `variants: VariantSpec[]`,
`packs: PackSpec[]`, `baseline: string`, `parallel: number`, `hint: string`.
Все ключи legacy-поверхности (`packRef`, `packType`, `prompt`, `init`,
`initSide`, `pureBaseline`, `packSetup`, `packCheck`, `packExercise`,
`allowBaselineTool`, `packHint`, …) остаются в схеме без изменений — legacy-
режим их читает как раньше; variant-режим их отвергает на шаге 4.

### 3.3 Новые флаги (`VALUE_FLAGS`, `src/phases/00-cli-parse.ts`)

| Флаг | dest | Семантика |
|---|---|---|
| `--parallel <n>` | `parallel` | Максимум вариантов, исполняемых конкурентно фазой 06. |
| `--baseline <name>` | `baseline` | Имя варианта-эталона. |
| `--hint <text>` | `hint` | Глобальный дефолт-hint, применяемый к каждому варианту без своего `hint`. Алиас `--pack-hint` (`packHint`) — тот же destination-эффект, оставлен для существующих скриптов. |

Ни `--variants`, ни `--packs` **не существуют как CLI-флаги** — список
вариантов и реестр паков описываются только в `config.json` (variant-режим
задаётся исключительно конфигом). CLI-флаги `--variant`/`--variant2`
принадлежат субкоманде `compare`, не `run` — см.
`docs/phases/README.ru.md` и раздел compare в корневом `README.md`.

### 3.4 Legacy-шим: точная десугаровка (`desugarLegacy`)

Когда `variants` в конфиге нет, эта фаза строит **ровно два** варианта из
классических флагов:

```
packs:    packRef ? [{ name: packShortName(packRef), ref: packRef,
                       type?: packType, setup?: packSetup, check?: packCheck }] : []
variants: [
  { name: 'old', packs: [], pure: pureBaseline,                 # default true
    init: initSide ∈ {both, old} ? initText : undefined,
    allowPacks: allowBaselineTool && packRef ? [packName] : undefined },
  { name: 'new', packs: packRef ? [packName] : [], pure: false,
    init: initSide ∈ {both, new} ? initText : undefined,
    exercise: packExercise },
]
baseline: 'old'
hint (global): packHint ?? hint     # наследуется ОБОИМИ вариантами — тот же текст, что раньше
```

`--pack-setup`/`--pack-check`/`--pack-exercise` без `--pack` → `E_CONFIG_INVALID`
(`reason: "pack-setup-without-pack"`) — как и раньше, эти флаги настраивают
рантайм самого пака под тестом. `--pack-check` без preflight (`--no-preflight`)
→ `E_CONFIG_INVALID` (`reason: "pack-check-without-preflight"`) — гейту 6
негде выполниться.

`flagDefaults.legacyShim: !variantMode` — единственное место, по которому
`src/cli/pipeline.ts` отличает легаси-инвокацию от variant-режима постфактум
(нужно `legacyShimImpureBaselineWarning`, см. ниже); `flagDefaults` также
несёт `dockerDowngraded`, `configSource`, `parallel`, `baseline`.
`initSide` в `flagDefaults` больше не отражается отдельно — per-variant поле
`init` в манифесте раскрывает тот же факт (кто из `old`/`new` реально получил
`--init`).

### 3.5 `--no-pure-baseline` теперь по-настоящему меняет поведение (D2)

До этой фичи `--no-pure-baseline` не доходил до переменных окружения нигде,
кроме эвристики предупреждения — флаг был декоративным вне парсера. Теперь
`variants[old].pure = false` реально отключает `OPENCODE_PURE`/
`OPENCODE_DISABLE_DEFAULT_PLUGINS`/`OPENCODE_DISABLE_EXTERNAL_SKILLS` на
baseline-варианте (фаза 04). Раз в жизни прогона, только для legacy-шима
(`flagDefaults.legacyShim === true`) и только когда `old.pure === false`,
`src/cli/pipeline.ts` (`legacyShimImpureBaselineWarning`) печатает
однострочное предупреждение в stderr, объясняющее поведенческое изменение —
variant-режим об этом молчит: там `pure: false` на любом варианте — обычный
осознанный выбор, не сюрприз.

### 3.6 Contamination-предупреждение обобщено на N вариантов

`initPackContaminationWarnings` (`src/cli/pipeline.ts`) больше не завязана на
пару `old`/`new` — для КАЖДОГО «чистого» варианта (`pure ?? packs.length ===
0`) и КАЖДОГО чужого пака (`foreignPacksOf`) она проверяет, не упоминает ли
эффективный `init`+`prompt` варианта короткое имя этого пака; при совпадении —
предупреждение в stderr, называющее конкретную пару (вариант, пак). Один
прогон может напечатать несколько таких строк (одна на каждую подозрительную
пару), в отличие от единственного глобального warning в v1.

## 4. Входные/выходные файлы

| Файл                              | Чтение/Запись | Схема (TypeSpec/Zod) |
| ---------------------------------- | ------------- | -------------------- |
| `.testaipack/config.json`         | Чтение        | `ConfigFile`         |
| файлы по ссылкам `@file` в флагах | Чтение        | UTF-8 текст (глобальные и per-variant `prompt`/`init`/`hint`) |

Фаза не пишет на диск; её результат живёт только в памяти и передаётся в
`workspace-setup`.

## 5. Edge-cases и ошибки

| Кейс                                              | Поведение                                                  | Код                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| `.testaipack/config.json` не существует           | Игнорируем, все значения из CLI + defaults                 | —                            |
| config.json есть, но битый JSON / нарушает схему  | Fail прогона, exit 64                                      | `E_CONFIG_INVALID`           |
| Ни у одного варианта нет эффективного промпта     | Fail прогона, называет вариант                              | `E_CONFIG_INVALID` (`prompt-required`) |
| `@file` указывает на несуществующий путь          | Fail прогона                                               | `E_CONFIG_INVALID`           |
| `--runs 0` или отрицательное                      | Fail прогона (`runs-min`)                                  | `E_CONFIG_INVALID`           |
| `--parallel 0` или отрицательное                  | Fail прогона (`parallel-min`)                               | `E_CONFIG_INVALID`           |
| `--isolation docker`, демон недоступен            | Warning + fallback на `home`, прогон продолжается          | — (downgrade)                |
| `--pack` не задан (legacy-режим)                  | Smoke-test: пустой `packs`, оба варианта без паков          | —                            |
| Неизвестный флаг                                   | Fail прогона, exit 64                                      | `E_CONFIG_INVALID`           |
| `--format all`                                     | Раскрыть в `[md, html, json, yaml]`                        | —                            |
| `variants` в конфиге + любой legacy-shaping-флаг  | Fail (`legacy-flag-with-variants`, называет ключ)          | `E_CONFIG_INVALID`           |
| Дубль/зарезервированное/невалидное имя варианта   | Fail, называет вариант                                      | `E_CONFIG_INVALID`           |
| `baseline` называет неизвестный вариант            | Fail (`unknown-baseline`)                                   | `E_CONFIG_INVALID`           |
| `variant.packs.length > 1`                         | Fail (`multi-pack-stage2` — Stage 2 ещё не реализован)      | `E_CONFIG_INVALID`           |
| Bare-ref в `variant.packs` сталкивается по имени с уже зарегистрированным паком другого `ref` | Fail (`pack-name-collision`) | `E_CONFIG_INVALID` |
| `variant.allowPacks` называет неизвестный пак      | Fail (`unknown-pack-ref`)                                    | `E_CONFIG_INVALID`           |
| `--init` похож на триггер пака, `pure` вариант     | Warning в stderr на каждую подозрительную пару (вариант, чужой пак) | — |
| Legacy-шим, `--no-pure-baseline`                    | `variants[old].pure = false` (реально снимает чистоту); одна строка warning в stderr | — |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path (legacy): `run <url> --prompt "fix bug"` без config-файла →
  `RunInput` с `variants = [old, new]`, `baseline = "old"`, `packs = []`,
  `runs = 3`, `parallel = 2`, `isolation = "home"`, `formats = ["md"]`,
  `configSource = "cli"`.
- ✅ config-file + CLI override: config задаёт `runs: 5`, CLI передаёт
  `--runs 2` → итоговое `runs = 2` (CLI побеждает), `configSource = "merged"`.
- ✅ `@file` промпт: `--prompt @prompts/fix.md` → `prompt` содержит
  содержимое файла, путь приписан в `promptFiles`.
- ✅ docker-downgrade: `--isolation docker`, демон не отвечает →
  `RunInput.isolation = "home"`, `flagDefaults.dockerDowngraded = true`.
- ✅ legacy-shim снапшот: `--pack X --prompt P` → ровно 2 варианта `old`/`new`,
  `baseline: "old"`, реестр из одного пака, `old.pure === true`,
  `new.pure === false`, `new.packs === [packName]`.
- ✅ `--no-pure-baseline`: `variants[old].pure === false`,
  `flagDefaults.legacyShim === true`, `legacyShimImpureBaselineWarning`
  печатает одну строку (проверяется отдельно, `src/cli/pipeline.test.ts`).
- ✅ variant-режим, конфиг с `variants` + legacy-флаг (`--pack`/`--pure-baseline`/
  `--init-side`/…) → `E_CONFIG_INVALID`, `reason: "legacy-flag-with-variants"`,
  контекст называет offending-ключ.
- ✅ variant-режим, 3 варианта (`a`, `b`, `c`), `baseline: "b"`, реестр из 2
  паков, у одного варианта bare-ref в `packs` → auto-регистрируется пак с
  именем `packShortName(ref)`; порядок вариантов сохраняется как в конфиге.
- ✅ дубликат/зарезервированное/невалидное имя варианта (`source`, `""`,
  `UPPER`) → каждое отдельный `E_CONFIG_INVALID` с точным `reason`.
- ✅ `baseline` называет отсутствующий вариант → `E_CONFIG_INVALID`
  (`unknown-baseline`).
- ✅ `variant.packs.length === 2` → `E_CONFIG_INVALID` (`multi-pack-stage2`).
- ✅ у одного варианта нет ни своего, ни унаследованного промпта (глобальный
  `prompt` не задан, `variant.prompt` не задан) → `E_CONFIG_INVALID`
  (`prompt-required`, называет вариант).
- ✅ `variant.prompt: ""` явно отключает наследование глобального `prompt` →
  тот же `prompt-required`, если других источников для этого варианта нет.
- ✅ `--parallel 4` парсится в `RunInput.parallel = 4`; без флага — `2`.
- ✅ `--baseline new` (legacy-режим) переопределяет дефолтный `"old"`.
- ✅ `--hint`/`--pack-hint` — оба маппятся в `RunInput.hint`, взаимозаменяемы.
- ✅ pack-type auto-detect: `--pack npm:myplugin` → `plugin`; `--pack
  github:owner/skill` → `"skill"`; `--pack ./local/skill` → `"skill"`.
- ✅ missing effective prompt → `E_CONFIG_INVALID`, exit 64.
- ✅ invalid `--runs 0` / `--parallel 0` → `E_CONFIG_INVALID`.
- ✅ invalid `@file` path → `E_CONFIG_INVALID`.
- ✅ invalid `--isolation foo` → `E_CONFIG_INVALID`.
- ✅ model format invalid: `--model`/`--preflight-model` не соответствует
  паттерну → `E_MODEL_UNAVAILABLE`.
- ✅ `--model` через config-file и CLI — приоритет как в §3.5 общего правила
  merge.
- ✅ contamination-warning generalized: `pure`-вариант с `init`, упоминающим
  чужой пак → warning называет и вариант, и пак; несколько подозрительных пар
  → несколько строк.
- ❌ НЕ покрыто (ticket): `compare <id1> <id2>` — валидация run-id в отдельной
  субкоманде, не в этой фазе.
- ❌ НЕ покрыто (ticket): Stage 2 (`variant.packs.length > 1`) — снятие guard'а
  запланировано отдельным work package (`WP16`).

## 7. Инварианты

- После фазы `RunInput` полностью заполнен: любое downstream-чтение должно
  находить значение без `undefined`-фоллбэков там, где поле не объявлено
  опциональным.
- `RunInput.variants.length ≥ 1`; каждое имя варианта уникально, валидно,
  не зарезервировано.
- `RunInput.baseline` называет реально существующий вариант.
- `RunInput.parallel ≥ 1`, `RunInput.runs ≥ 1`.
- У каждого варианта есть эффективный (свой или унаследованный из
  `RunInput.prompt`) непустой промпт — гарантия, которую downstream-фазы
  могут читать через `effectiveOf(v, runInput.prompt, 'prompt')` без
  дополнительных проверок.
- Каждая запись `variant.packs`/`variant.allowPacks` резолвится к
  существующему `PackSpec.name` в `RunInput.packs`.
- Stage 1: `variant.packs.length ≤ 1` для КАЖДОГО варианта (снимается в
  Stage 2).
- `RunInput.schemaVersion === 2` всегда — эта фаза никогда не порождает v1-
  форму; v1-совместимость целиком лежит на слое чтения (`src/compat/legacy.ts`),
  не на этой фазе.
- Никаких побочных эффектов на диск: фаза чистая и детерминированная
  (только чтение файлов по известным путям).

## 8. Зависимости от других фаз

- Зависит от: — (это вход в pipeline).
- Блокирует: **01 workspace-setup** (получает `RunInput`), а через него — все
  остальные фазы. Любая ошибка здесь обрывает весь прогон до создания
  workspace.
- Параллелизуется с: — (ничем; синхронный вход).
