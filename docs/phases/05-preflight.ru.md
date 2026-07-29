# Фаза 05: preflight

> Спека фазы. Контракт = `contract/phases/05-preflight.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Последовательно прогнать 5 gate-проверок, чтобы убедиться: opencode
запускается, auth работает, агент `build` доступен, pack виден на стороне new
и **не** виден на old. Любой провал обрывает прогон раньше, чем начнутся
дорогие N×2 запусков. `--no-preflight` пропускает фазу целиком.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.Preflight` (см. `contract/phases/05-preflight.tsp`).

- Вход: `PreflightInput` — `{ runInput: RunInput, manifest: Manifest,
  homePaths: { old: string; new: string } }`. По одной паре путей (предположительно
  `home/{old,new}/run-1/`) — репрезентативной паре от каждой стороны.
- Выход: `PreflightResult` — `{ checks: PreflightCheck[], allPassed: boolean,
  exitCode: 0 | 2 | 3, logPath: string }`. `PreflightCheck = { name: string,
  side: Side, passed: boolean, durationMs: int64, details?: string }`.
  `exitCode ∈ {0, 2, 3}`: 0 — все проверки прошли, 2 — общий сбой (gates 1, 2,
  3 или 5), 3 — pack-visibility gate (gate 4) провалился.
- Ошибки: `@error PreflightError` — `{ code, phase: "preflight", check, side,
  message, context? }`, где `code` принимает только значения:
  - `E_PREFLIGHT_TIMEOUT` — отдельная проверка превысила свой таймаут.
  - `E_PREFLIGHT_FAILED` — провалились gates 1, 2, 3 или 5 (exit 2). Поле
    `check` ∈ `{ "opencode-launch", "auth-ping", "build-agent",
    "pack-visibility", "baseline-identical" }` уточняет gate.
  - `E_PREFLIGHT_PACK_INVISIBLE` — провалился gate 4 — pack не установлен в
    newVersion (exit 3).
  - `E_AUTH_MISSING` — нет auth для модели (поднимается, если gate 2 обнаружил
    полное отсутствие credentials).

## 3. Шаги алгоритма

Если `runInput.preflightEnabled === false` → записать в `results/preflight.log`
строку `"preflight skipped (--no-preflight)"`, вернуть
`PreflightResult { checks: [], allPassed: true, exitCode: 0, logPath }`, выйти.

Иначе прогоняем 5 gate-ов последовательно. Каждый gate пишет в
`results/preflight.log` свой результат. Любой `fail` прерывает цепочку.

**Gate 1 — opencode-launch** (для old **и** new, n=1):

1. Запустить `HOME=<homeDir> opencode --version` с таймаутом 10s.
2. exit ≠ 0 или таймаут → throw
   `PreflightError({ code: "E_PREFLIGHT_FAILED", phase: "preflight", check: "opencode-launch", side, message })`
   (exit code 2). Если таймаут — `code: "E_PREFLIGHT_TIMEOUT"`.

**Gate 2 — auth-ping** (для old **и** new, n=1):

3. Запустить
   `HOME=<homeDir> opencode run --agent build --format json "reply with the single word OK"`,
   с `--model <runInput.model>`, если пользователь задал `--model` (или
   `model` в config-файле) — иначе без явного `--model`: модель приходит из
   сгенерированного конфига (`OPENCODE_CONFIG_CONTENT`), т.е. пинг всегда
   бьёт по той же модели, что будет использовать сам прогон.
   Таймаут 30s. `--preflight-model` на этот gate больше **не** влияет — он
   выбирает только модель LLM-судьи (фаза 09).
4. Стримить JSON; ждать первого assistant-message. Если за 30s его нет →
   `PreflightError({ code: "E_PREFLIGHT_TIMEOUT", check: "auth-ping", side })`.
   Если в стриме есть HTTP 429 / auth error →
   `PreflightError({ code: "E_PREFLIGHT_FAILED", check: "auth-ping", side, ... })`.
   Полное отсутствие credentials →
   `PreflightError({ code: "E_AUTH_MISSING", check: "auth-ping", side })`.
   Текст ответа не валидируется (gate проверяет только, что модель отвечает).

**Gate 3 — build-agent доступен** (для old **и** new, n=1):

5. Проверить, что файл `agents/build.md` существует в
   `<homeDir>/.config/opencode/agents/build.md`. Если нет →
   `PreflightError({ code: "E_PREFLIGHT_FAILED", check: "build-agent", side })`.
   (Этот файл создан фазой 04 из стандартного шаблона оркестратора.)

**Gate 4 — pack-visibility** (side: **new only**, n=1):

6. Если `manifest.packType === "skill"`:
   a. Проверить, что файл `pack/<name>/SKILL.md` существует. Если нет →
      `PreflightError({ code: "E_PREFLIGHT_PACK_INVISIBLE", check:
      "pack-visibility", side: "new" })`.
   b. Зонд-промпт: `HOME=<newHomeDir> opencode run --agent build --format json
      "list available skills"` (таймаут 30s, дешёвая модель). Парсим ответ; если
      в тексте ассистента встречается имя pack-а → ok. Иначе →
      `E_PREFLIGHT_PACK_INVISIBLE`.
7. Если `manifest.packType === "plugin"`: проверить, что файл
   `home/new/run-1/.config/opencode/plugins/<name>.js` существует. Иначе →
   `E_PREFLIGHT_PACK_INVISIBLE`.
8. Если `manifest.packType === "agent" | "command"`: проверить существование
   файла в `home/new/run-1/.config/opencode/<agents|command>/<name>.md`. Иначе →
   `E_PREFLIGHT_PACK_INVISIBLE`.
9. Если `manifest.packType === "mcp"`: запустить `HOME=<newHomeDir> opencode
   mcp list` (таймаут 10s) и проверить, что в выводе присутствует имя. Иначе →
   `E_PREFLIGHT_PACK_INVISIBLE`.
10. Если smoke-test (`manifest.packRef` отсутствует): gate 4 превращается в
    проверку, что в `home/new/run-1/.config/opencode/` **нет** pack-а — это
    тривиально true, gate проходит.

**Gate 5 — baseline-identical** (side: old, n=1):

11. Повторить gates 1–3 для `side = old` (auth-ping снова целится в
    `runInput.model`, как и в gate 2). Дополнительно — assert, что в
    `home/old/run-1/.config/opencode/` нет pack-файлов/симлинков (pack должен
    быть изолирован на old). Провал →
    `PreflightError({ code: "E_PREFLIGHT_FAILED", check: "baseline-identical", side: "old" })`.

Финал: все 5 gate-ов прошли → `PreflightResult { allPassed: true, exitCode: 0 }`.

## 4. Входные/выходные файлы

| Файл                  | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------- | ------------- | -------------------- |
| `results/preflight.log` | Запись      | текст, построчно     |
| `home/<side>/run-1/.config/opencode/...` | Чтение | файлы/симлинки |
| `pack/<name>/SKILL.md` | Чтение (skill) | текст             |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                              | Код                          |
| --------------------------------------------------- | -------------------------------------- | ---------------------------- |
| `runInput.preflightEnabled = false`                 | фаза пропускается, exit 0              | —                            |
| gate 1: `opencode` не в PATH                        | fail, exit 2                           | `E_PREFLIGHT_FAILED`         |
| gate 2: модель 429 в пинге                          | fail, exit 2                           | `E_PREFLIGHT_FAILED`         |
| gate 2: нет credentials вовсе                       | fail, exit 2                           | `E_AUTH_MISSING`             |
| gate 2: таймаут 30s без ответа                      | fail, exit 2                           | `E_PREFLIGHT_TIMEOUT`        |
| gate 3: `build.md` отсутствует                      | fail, exit 2                           | `E_PREFLIGHT_FAILED`         |
| gate 4 skill: SKILL.md отсутствует                  | fail, **exit 3**                       | `E_PREFLIGHT_PACK_INVISIBLE` |
| gate 4 skill: SKILL.md есть, но зонд не нашёл имя   | fail, exit 3                           | `E_PREFLIGHT_PACK_INVISIBLE` |
| gate 4 plugin: `plugins/<name>.js` отсутствует      | fail, exit 3                           | `E_PREFLIGHT_PACK_INVISIBLE` |
| gate 4 mcp: `mcp list` пустой                       | fail, exit 3                           | `E_PREFLIGHT_PACK_INVISIBLE` |
| gate 5: на old нашёлся pack-симлинк (утечка)        | fail, exit 2                           | `E_PREFLIGHT_FAILED`         |
| smoke-test                                          | gate 4 тривиально ok, gate 5 ok        | —                            |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: все 5 gate-ов проходят → `allPassed = true`, `exitCode: 0`,
  в логе 5 строк `ok`.
- ✅ preflight disabled: `runInput.preflightEnabled = false` → результат
  `checks: []`, `exitCode: 0`, лог содержит `"preflight skipped"`.
- ✅ gate 1 fail: `opencode` не в PATH → throw `E_PREFLIGHT_FAILED` с
  `check: "opencode-launch"`, exit 2.
- ✅ gate 2 timeout: модель не отвечает 30s → throw `E_PREFLIGHT_TIMEOUT` с
  `check: "auth-ping"`.
- ✅ gate 2 auth fail: стрим содержит auth error → throw `E_PREFLIGHT_FAILED`
  с `check: "auth-ping"`.
- ✅ gate 2 no credentials: credentials вовсе отсутствуют → throw
  `E_AUTH_MISSING` с `check: "auth-ping"`.
- ✅ gate 3 fail: `build.md` удалён → throw `E_PREFLIGHT_FAILED` с
  `check: "build-agent"`.
- ✅ gate 4 skill success: SKILL.md есть, зонд упоминает имя pack → ok.
- ✅ gate 4 skill invisible: зонд не упоминает имя → throw
  `E_PREFLIGHT_PACK_INVISIBLE` с `check: "pack-visibility"`, exit 3.
- ✅ gate 4 plugin invisible: `plugins/<name>.js` нет → throw
  `E_PREFLIGHT_PACK_INVISIBLE`.
- ✅ gate 5 leak: на old случайно остался pack-симлинк → throw
  `E_PREFLIGHT_FAILED` с `check: "baseline-identical"`.
- ✅ smoke-test gate 4: `packRef` отсутствует → gate 4 проходит тривиально.
- ✅ gate 2 model targeting: `runInput.model` задан → auth-ping вызывается с
  этой моделью на обеих сторонах, `preflightModel` игнорируется.
- ✅ gate 2 model unset: `runInput.model` не задан (даже если `preflightModel`
  задан) → auth-ping идёт без явного `--model`.
- ✅ gate 5 model targeting: повторный auth-ping на old внутри gate 5 тоже
  целится в `runInput.model`.
- ❌ НЕ покрыто (ticket): поведение `mcp list` при частичном запуске серверов
  (v0.3).

## 7. Инварианты

- После **успешной** фазы все 5 gate-ов имеют `passed: true` в
  `results/preflight.log` и `allPassed = true` в `PreflightResult`.
- `exitCode ∈ {0, 2, 3}` однозначно различает успех / общий сбой / невидимый
  pack.
- Если `exitCode ≠ 0` — фазы 06+ **не стартуют** (orchestrator обязан
  прекратить прогон).
- Проверки идут на `n=1` только (по `homePaths.old` / `homePaths.new`) —
  предполагается, что все `run-N` одной стороны идентичны (гарантируется
  фазой 04).
- Gate 2 и gate 5 проверяют модель самого прогона: `runInput.model`, если
  пользователь его задал (флаг `--model` или `model` в config-файле); если
  не задан — auth-ping идёт без явного `--model`, беря модель из
  сгенерированного конфига (ambient-модель из `~/.config/opencode/opencode.json`,
  запечённая фазой 04 в оба HOME). Это гарантирует, что preflight провалится
  на той же модели, на которой упадёт сам прогон, а не на посторонней.
- `runInput.preflightModel` на auth-ping больше не влияет — он используется
  только для выбора модели LLM-судьи (фаза 09 judge).

## 8. Зависимости от других фаз

- Зависит от: **01 workspace-setup** (`Manifest`, `WorkspaceTree`),
  **03 pack-install** (`pack/<name>/SKILL.md`), **04 home-isolation**
  (`homePaths`, pack-регистрация в HOME).
- Блокирует: **06 run-side** (запуск дорогих прогонов возможен только после
  ok-preflight).
- Параллелизуется с: — (gate-и внутри последовательны; фаза целиком — точка
  схода перед run-side).
