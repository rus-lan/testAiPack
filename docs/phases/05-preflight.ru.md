# Фаза 05: preflight

> Спека фазы. Контракт = `contract/phases/05-preflight.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Последовательно прогнать 6 gate-проверок, чтобы убедиться: opencode
запускается на каждом варианте, auth работает, агент `build` доступен, каждый
объявленный пак виден именно там, где объявлен, **не** виден на чужих
вариантах, и (если задан `check`) реально функционален. Любой провал обрывает
прогон раньше, чем начнутся дорогие N-вариантные запуски. `--no-preflight`
пропускает фазу целиком.

Раньше (два фиксированных плеча) было 5 именованных гейтов, причём пятый
(`baseline-identical`) заново повторял гейты 1–3 для стороны `old`. С N
вариантами гейты 1–3 и так уже проходят по КАЖДОМУ варианту в общем цикле —
повторный прогон для «стороны old» стал бы избыточным дублем, поэтому он
убран; вместо него гейт 5 переименован в `foreign-pack-absent` и отвечает
только за свою собственную проверку — «чужой пак не просочился». Итог — 6
именованных гейтов, каждый проходит по всем нужным вариантам внутри себя.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.Preflight` (см. `contract/phases/05-preflight.tsp`).

- Вход: `PreflightInput` — `{ runInput: RunInput, manifest: Manifest,
  homesForCheck: VariantHomesForCheck[] }`. `VariantHomesForCheck = { name,
  homes: HomeCheckTarget[] }` — по одной записи на **каждый** вариант, а
  внутри — по одному `HomeCheckTarget = { homeDir, pathOverride? }` на
  каждый HOME варианта (не только run-1 — гейт 6 обходит их все, см. §3).
  Заменяет прежний `homePaths: { old: string; new: string }` — там, где
  раньше было ровно два пути, теперь произвольное число вариантов ×
  произвольное число прогонов.
- Выход: `PreflightResult` — `{ checks: PreflightCheck[], allPassed: boolean,
  exitCode: 0 | 2 | 3, logPath: string }`. `PreflightCheck = { name: string,
  variant: string, passed: boolean, durationMs: int64, details?: string }`
  (`variant` — было `side: Side`). `exitCode ∈ {0, 2, 3}`: 0 — все проверки
  прошли, 2 — общий сбой (гейты 1, 2, 3 или 5), 3 — пак не виден там, где
  должен (гейт 4), либо не функционален там, где должен (гейт 6, отдельный
  код `E_PACK_CHECK_FAILED`, см. ниже).
- Ошибки: `@error PreflightError` — `{ code, phase: "preflight", check,
  variant, message, context? }`, где `code` принимает только значения:
  - `E_PREFLIGHT_TIMEOUT` — отдельная проверка превысила свой таймаут.
  - `E_PREFLIGHT_FAILED` — провалились гейты 1, 2, 3 или 5 (exit 2). Поле
    `check` ∈ `{ "opencode-launch", "auth-ping", "build-agent",
    "pack-visibility", "foreign-pack-absent" }` уточняет гейт.
  - `E_PREFLIGHT_PACK_INVISIBLE` — провалился гейт 4 — объявленный пак не
    виден в HOME варианта, который его объявил (exit 3).
  - `E_PACK_CHECK_FAILED` — провалился гейт 6 — `check` пака либо не прошёл
    там, где должен (`declared-not-functional`), либо неожиданно прошёл там,
    где не должен (`foreign-tool-present`, без `allowPacks`); timeout внутри
    гейта 6 — отдельно, инфра-ошибка (exit 2).
  - `E_AUTH_MISSING` — нет auth для модели (поднимается, если гейт 2
    обнаружил полное отсутствие credentials).

## 3. Шаги алгоритма

Если `runInput.preflightEnabled === false` → записать в `results/preflight.log`
строку `"preflight skipped (--no-preflight)"`, вернуть
`PreflightResult { checks: [], allPassed: true, exitCode: 0, logPath }`, выйти.

Иначе прогоняем 6 гейтов последовательно (`Effect.reduce`, fail-fast —
провал любого прерывает цепочку). Каждый гейт пишет в `results/preflight.log`
свой результат построчно (`[CHECK] <gate> [<variant>] PASSED|FAILED (<ms>ms)
<details>`). Внутри гейта варианты/паки перебираются в порядке конфига —
сообщение об ошибке детерминировано.

**Гейт 1 — opencode-launch** (для КАЖДОГО варианта, run-1 HOME):

1. Запустить `HOME=<homeDir> opencode --version` с таймаутом 10s.
2. exit ≠ 0 или таймаут → throw
   `PreflightError({ code: "E_PREFLIGHT_FAILED", check: "opencode-launch", variant, message })`
   (exit code 2). Если таймаут — `code: "E_PREFLIGHT_TIMEOUT"`.

**Гейт 2 — auth-ping** (для КАЖДОГО варианта, run-1 HOME):

3. Запустить
   `HOME=<homeDir> opencode run --agent build --format json "reply with the single word OK"`,
   с `--model <effectiveOf(variant, runInput.model, 'model')>`, если у
   варианта (своё или унаследованное) есть эффективная модель — иначе без
   явного `--model`: модель приходит из сгенерированного конфига этого
   варианта (`OPENCODE_CONFIG_CONTENT`, фаза 04), т.е. пинг всегда бьёт по
   той же модели, что будет использовать сам прогон этого варианта.
   Таймаут 30s. `--preflight-model` на этот гейт не влияет — он выбирает
   только модель LLM-судьи (фаза 09).
4. Стримить JSON; ждать первого assistant-message. Если за 30s его нет →
   `PreflightError({ code: "E_PREFLIGHT_TIMEOUT", check: "auth-ping", variant })`.
   Если в стриме есть HTTP 429 / auth error →
   `PreflightError({ code: "E_PREFLIGHT_FAILED", check: "auth-ping", variant, ... })`.
   Полное отсутствие credentials →
   `PreflightError({ code: "E_AUTH_MISSING", check: "auth-ping", variant })`.
   Текст ответа не валидируется (гейт проверяет только, что модель отвечает).

**Гейт 3 — build-agent доступен** (для КАЖДОГО варианта, run-1 HOME):

5. Проверить, что файл `agents/build.md` существует в
   `<homeDir>/.config/opencode/agents/build.md`. Если нет →
   `PreflightError({ code: "E_PREFLIGHT_FAILED", check: "build-agent", variant })`.
   (Этот файл создан фазой 04 из стандартного шаблона оркестратора.)

**Гейт 4 — pack-visibility** (для КАЖДОГО варианта, по КАЖДОМУ паку, который
этот вариант объявил, `packsOf(runInput, variant)`, run-1 HOME):

6. Если `pack.type === "skill"`:
   a. Проверить, что файл `pack/<name>/SKILL.md` существует. Если нет →
      `PreflightError({ code: "E_PREFLIGHT_PACK_INVISIBLE", check:
      "pack-visibility", variant })`.
   b. Зонд-промпт: `HOME=<homeDir> opencode run --agent build --format json
      "list available skills"` (таймаут 30s, дешёвая модель). Парсим ответ; если
      в тексте ассистента встречается имя пака → ok. Иначе →
      `E_PREFLIGHT_PACK_INVISIBLE`.
7. Если `pack.type === "plugin"`: проверить, что файл
   `home/<variant>/run-1/.config/opencode/plugins/<name>.js` существует. Иначе →
   `E_PREFLIGHT_PACK_INVISIBLE`.
8. Если `pack.type === "agent" | "command"`: проверить существование файла в
   `home/<variant>/run-1/.config/opencode/<agents|command>/<name>.md`. Иначе →
   `E_PREFLIGHT_PACK_INVISIBLE`.
9. Если `pack.type === "mcp"`: запустить `HOME=<homeDir> opencode mcp list`
   (таймаут 10s) и проверить, что в выводе присутствует имя. Иначе →
   `E_PREFLIGHT_PACK_INVISIBLE`.
10. Вариант без объявленных паков (`packsOf(...).length === 0`, включая
    smoke-test) — гейт для него тривиально проходит (нечего проверять) — как
    раньше «пустая» сторона.

**Исключение гейта 4 — пак, доставленный только через `setup`.** Фаза 03
может не найти у пака ни одного skill/agent/command/plugin-файла для
регистрации (например graphify: `SKILL.md` генерирует его собственный CLI
при установке, в самом репозитории его нет) — тогда `instructionsOfPack`
возвращает пустой список. Пустой список — НЕ «нечего проверять» (это
отличается от «нет объявленных паков» в п.10 выше): для такого пака это
единственное свидетельство присутствия, какое вообще есть у гейта 4.
Поэтому:
- Если у пака при этом нет и `PackSpec.setup` — гейт падает жёстко:
  `E_PREFLIGHT_FAILED`, «no registration instructions recorded — visibility
  cannot be proven» (exit 2). Пак без единого файла регистрации и без
  `setup` не может считаться доставленным никак.
- Если `setup` задан — гейт **проходит**, но НЕ заявляет подтверждение:
  `details` не начинается с `pack-visibility [...]` (единственная строка,
  которую `resolvePackVisibilityConfirmed` в `cli/pipeline.ts` читает как
  доказательство), поэтому downstream (карта видимости, `visibilityConfirmed`
  в отчёте) честно несёт «не подтверждена». Если у пака к тому же задан
  `check` — присутствие вместо этого доказывает гейт 6 (exit 0 в каждом HOME
  каждого объявившего варианта); если `check` тоже не задан — видимость
  этого пака preflight вообще никак не проверяет, о чём `details` говорит
  явно.

**Гейт 5 — foreign-pack-absent** (для КАЖДОГО варианта, по КАЖДОМУ ЧУЖОМУ
паку, `foreignPacksOf(runInput, variant)` = объединение паков всех ДРУГИХ
вариантов минус свой набор, run-1 HOME):

11. Для каждой пары (вариант V, чужой пак P) — проверить fail-loud
    существование каждой инструкции P в `.config/opencode/` варианта V
    (`homeSubExistsOrFail`). Любой найденный след → `PreflightError({ code:
    "E_PREFLIGHT_FAILED", check: "foreign-pack-absent", variant: V.name })`
    (exit 2), с деталями, называющими (V, P, вид инструкции). Пак, разделяемый
    несколькими вариантами, не входит ни в чей «чужой» набор — гейты 4/5
    требуют его видимым во всех объявивших и отсутствующим во всех остальных,
    без частных случаев.

**Исключение гейта 5 — симметрично гейту 4.** Тот же пак, доставленный
только через `setup` (пустой список инструкций), у гейта 5 означает
«отсутствие никогда не проверялось» — не «нечего искать». Без `setup` —
жёсткий fail, `E_PREFLIGHT_FAILED`, «no registration instructions recorded
for foreign pack — absence cannot be proven». С `setup` — гейт проходит без
подтверждения, `details` называет пак и явно говорит: absence not confirmed
by gate 5 for this variant; отсутствие вместо этого доказывает
foreign-must-fail-направление гейта 6 (ненулевой exit `check` в HOME
варианта, который пак не объявлял), если у пака задан `check`.

**Гейт 6 — pack-functional** (для КАЖДОГО пака с `check`, во **всех** HOME
**каждого** варианта — не только run-1, см. §3.1):

12. Запустить `pack.check` через `runShellInHome` (тот же PATH-механизм, что
    в фазе 04b) в каждом `HomeCheckTarget` каждого варианта.
    - в HOME варианта, объявившего этот пак → должен выйти 0; ЛЮБОЙ ненулевой
      код (включая 127 «command not found») — провал, `reason:
      "declared-not-functional"` (было `new-side-not-functional`) →
      `E_PACK_CHECK_FAILED`, exit 3.
    - в HOME варианта, НЕ объявившего этот пак → должен выйти НЕнулевым
      кодом; неожиданный успех (exit 0) → `reason: "foreign-tool-present"`
      (было `baseline-already-has-tool`) → `E_PACK_CHECK_FAILED`, exit 3—
      **если** только `pack.name ∉ variant.allowPacks` (преемник
      `--allow-baseline-tool`, теперь per-(вариант, пак)): тогда это
      понижается до overridden-pass, а сводная строка явно называет число
      обойдённых HOME.
    - таймаут где угодно → инфра-сбой, `E_PACK_CHECK_FAILED` exit 2
      (`timedOut: true`).
    Пак без `check` — гейт для него помечен `skipped (no check)`,
    `passed: true` — не путать со «подтверждено работает».

Финал: все 6 гейтов прошли → `PreflightResult { allPassed: true, exitCode: 0 }`.

### 3.1 Every-HOME coverage гейта 6 — почему не только run-1

Копи-аут шаг фазы 04b (установка в run-1 HOME, затем копирование на
run-2..N) — то самое место, где HOME может тихо остаться без рабочей
установки. Гейт, проверяющий только run-1, ничего не доказывает про
run-2..N. Поэтому гейт 6 обходит `homesForCheck[*].homes` целиком:
`C × N_вариантов × runs` вызовов shell-команды на C паков с `check` — для
C=2, N=3, runs=3 это 18 быстрых (<1s) вызовов, выполняются последовательно
(`{ concurrency: 1 }`) — preflight дёшев относительно самих прогонов, гонка
с docker daemon не стоит потенциального выигрыша.

## 4. Входные/выходные файлы

| Файл                  | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------- | ------------- | -------------------- |
| `results/preflight.log` | Запись      | текст, построчно     |
| `home/<variant>/run-{1..N}/.config/opencode/...` | Чтение | файлы/симлинки |
| `pack/<name>/SKILL.md` | Чтение (skill) | текст             |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                              | Код                          |
| --------------------------------------------------- | -------------------------------------- | ----------------------------- |
| `runInput.preflightEnabled = false`                 | фаза пропускается, exit 0              | —                             |
| гейт 1: `opencode` не в PATH (любой вариант)        | fail, exit 2                           | `E_PREFLIGHT_FAILED`         |
| гейт 2: модель 429 в пинге                          | fail, exit 2                           | `E_PREFLIGHT_FAILED`         |
| гейт 2: нет credentials вовсе                       | fail, exit 2                           | `E_AUTH_MISSING`             |
| гейт 2: таймаут 30s без ответа                      | fail, exit 2                           | `E_PREFLIGHT_TIMEOUT`        |
| гейт 3: `build.md` отсутствует                      | fail, exit 2                           | `E_PREFLIGHT_FAILED`         |
| гейт 4 skill: `SKILL.md` отсутствует у объявившего варианта | fail, **exit 3**              | `E_PREFLIGHT_PACK_INVISIBLE` |
| гейт 4 skill: `SKILL.md` есть, но зонд не нашёл имя | fail, exit 3                           | `E_PREFLIGHT_PACK_INVISIBLE` |
| гейт 4 plugin: `plugins/<name>.js` отсутствует      | fail, exit 3                           | `E_PREFLIGHT_PACK_INVISIBLE` |
| гейт 4 mcp: `mcp list` пустой                       | fail, exit 3                           | `E_PREFLIGHT_PACK_INVISIBLE` |
| гейт 4/5: у пака нет инструкций регистрации, но задан `setup` | pass, БЕЗ подтверждения — присутствие/отсутствие доказывает гейт 6 (если задан `check`) | — |
| гейт 4/5: у пака нет ни инструкций, ни `setup`      | fail, exit 2, «visibility/absence cannot be proven» | `E_PREFLIGHT_FAILED`   |
| гейт 5: у варианта нашёлся чужой пак (утечка)       | fail, exit 2, называет (вариант, пак)  | `E_PREFLIGHT_FAILED`         |
| гейт 6: `check` не прошёл в HOME объявившего варианта | fail, exit 3, `declared-not-functional` | `E_PACK_CHECK_FAILED`      |
| гейт 6: `check` неожиданно прошёл в HOME чужого варианта, без `allowPacks` | fail, exit 3, `foreign-tool-present` | `E_PACK_CHECK_FAILED` |
| гейт 6: то же, но `pack.name ∈ variant.allowPacks`  | overridden-pass, деталь называет число обойдённых HOME | — |
| гейт 6: таймаут `check` в любом HOME                | fail, exit 2 (инфра-сбой)              | `E_PACK_CHECK_FAILED`        |
| вариант без объявленных паков (включая smoke-test)  | гейт 4 тривиально ok                   | —                             |
| два варианта разделяют один пак                      | гейт 4/5 требуют пак видимым в обоих, отсутствующим во всех остальных | — |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: legacy-шим (2 варианта), все 6 гейтов проходят →
  `allPassed = true`, `exitCode: 0`, в логе строка `PASSED` на каждый
  гейт×вариант.
- ✅ N-way happy-path: 3 варианта, паки A (вариант a) и B (вариант b), оба с
  `check` — гейт 6 запускает `check` A в HOME варианта a (pass), в HOME
  вариантов b и smoke (must fail), симметрично для B; фикстура — shell-скрипт,
  выходящий 0 только при наличии маркер-файла в HOME, доказывает маршрутизацию.
- ✅ preflight disabled: `runInput.preflightEnabled = false` → результат
  `checks: []`, `exitCode: 0`, лог содержит `"preflight skipped"`.
- ✅ гейт 1 fail: `opencode` не в PATH → throw `E_PREFLIGHT_FAILED` с
  `check: "opencode-launch"`, exit 2.
- ✅ гейт 2 timeout / auth fail / no credentials — как раньше, per variant.
- ✅ гейт 3 fail: `build.md` удалён → throw `E_PREFLIGHT_FAILED` с
  `check: "build-agent"`.
- ✅ гейт 4 skill success / invisible — per объявивший вариант.
- ✅ гейт 5 leak: искусственно подложен файл чужого пака в HOME варианта b →
  throw `E_PREFLIGHT_FAILED` с `check: "foreign-pack-absent"`, называет
  (вариант b, пак, вид инструкции).
- ✅ гейт 6 `allowPacks`: `variant.allowPacks: ['a-pack']` на smoke-варианте
  понижает один провал до overridden-pass с деталью в тексте.
- ✅ smoke-test гейт 4: вариант без паков → гейт 4 проходит тривиально.
- ✅ гейт 2 model targeting: у варианта задан эффективный `model` → auth-ping
  вызывается с этой моделью именно на этом варианте; у другого варианта без
  своей модели — auth-ping без явного `--model`.
- ✅ shared pack: пак объявлен вариантами a и b → гейты 4/5 требуют его
  видимым в a и b, отсутствующим в остальных — без специального случая.
- ✅ пак без инструкций регистрации, но с `setup`: гейты 4/5 проходят на
  объявившем и на чужом вариантах, `details` не начинается с
  `pack-visibility [`/`foreign-pack-absent [`; заданный `check` доказывает
  присутствие/отсутствие независимо через гейт 6.
- ✅ пак без инструкций регистрации и без `setup`: гейты 4/5 падают,
  `E_PREFLIGHT_FAILED`, «cannot be proven».
- ❌ НЕ покрыто (ticket): поведение `mcp list` при частичном запуске серверов.

## 7. Инварианты

- После **успешной** фазы все 6 гейтов имеют `passed: true` в
  `results/preflight.log` и `allPassed = true` в `PreflightResult`.
- `exitCode ∈ {0, 2, 3}` однозначно различает успех / общий сбой / проблему с
  паком (невидим или нефункционален).
- Если `exitCode ≠ 0` — фазы 06+ **не стартуют** (orchestrator обязан
  прекратить прогон).
- Гейты 1–3 проверяют `run-1` HOME каждого варианта (предполагается, что все
  `run-N` одного варианта идентичны — гарантируется фазой 04); гейт 6
  проверяет ВСЕ HOME каждого варианта (см. §3.1).
- Гейт 2 проверяет эффективную модель варианта
  (`effectiveOf(variant, runInput.model, 'model')`), если задана — иначе
  auth-ping идёт без явного `--model`, беря модель из сгенерированного
  конфига этого варианта.
- `runInput.preflightModel` на auth-ping не влияет — он используется только
  для выбора модели LLM-судьи (фаза 09 judge).
- Инвариант гейтов 4/5/6, справедливый для КАЖДОГО варианта V с объявленным
  набором P(V) и чужим набором F(V) = ⋃{P(W): W≠V} − P(V): каждый пак из
  P(V) виден в V; каждый пак из F(V) не виден в V; каждый пак с `check`
  проходит в каждом HOME каждого объявившего его варианта и не проходит в
  каждом HOME каждого не объявившего — если только не в его `allowPacks`.
- Пак без единого файла регистрации всегда либо доказан гейтами 4/5 (обычный
  случай), либо доказан гейтом 6 через `check` (пак, доставленный только
  `setup`), либо честно помечен «не подтверждён preflight вовсе» — гейты
  4/5 никогда не выдают ложное `pack-visibility [...]`-подтверждение за
  пак, у которого нет файлов, которые можно было бы проверить.

## 8. Зависимости от других фаз

- Зависит от: **01 workspace-setup** (`Manifest`, `WorkspaceTree`),
  **03 pack-install** (`pack/<name>/`), **04 home-isolation**
  (`homesForCheck`, паковая регистрация в HOME каждого варианта).
- Блокирует: **06 run-side** (запуск дорогих прогонов возможен только после
  ok-preflight).
- Параллелизуется с: — (гейты внутри последовательны; фаза целиком — точка
  схода перед run-side).
