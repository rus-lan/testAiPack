# Фаза 09: judge (опциональная)

> Спека фазы. Контракт = `contract/phases/09-judge.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Если задан `--judge`, прогнать LLM-судью по диффам old/new и получить
независимую качественную оценку: бинарный `verdict` (ok/fail/unclear),
баллы old и new, объяснение. Без `--judge` фаза пропускается.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.Judge` (см. `contract/phases/09-judge.tsp`).

- Вход: `JudgeInput` — `{ runInput: RunInput, manifest: Manifest, diff: { old:
  DiffResult; new: DiffResult } }`. Если `runInput.judge` (промпт судьи)
  отсутствует → фаза возвращает `JudgeResultOutput { judge: null }` (no-op).
- Выход: `JudgeResultOutput` — `{ judge: JudgeResult | null }`. `JudgeResult =
  { verdict: JudgeVerdict, oldQuality: int32, newQuality: int32, explanation:
  string, rawResponse?: string, modelUsed: string, timestamp: utcDateTime,
  ran?: boolean }`. `JudgeVerdict ∈ { "ok", "fail", "unclear" }` (значения enum:
  `"ok"`, `"fail"`, `"unclear"`). `judge = null` — когда судья не запрашивалась
  (`runInput.judge` отсутствует).
- `ran` различает «судья не смогла запуститься» от «судья запустилась и не
  определилась»: `ran: true` — модель судьи была вызвана и вернула ответ (даже
  мусорный — тогда `rawResponse` его хранит, а `verdict = "unclear"`);
  `ran: false` — ответа модели вообще нет (недоступна модель, crash opencode,
  таймаут, не удалось создать scratch-директорию, либо оба патча пусты).
  Отсутствие поля (старый `report.json`, записанный до появления `ran`)
  читается как `true` — поле опционально специально ради обратной
  совместимости.
- Ошибки: фаза **никогда не падает**. `@error JudgeError` — `{ code: "E_MODEL_UNAVAILABLE",
  message, context? }` — модель остаётся в `contract/phases/09-judge.tsp`
  (легальна для схемы), но фаза 09 её больше не бросает: недоступность модели
  судьи теперь деградирует так же, как таймаут/crash/rate-limit — `verdict:
  "unclear"`, `ran: false`, `explanation` с деталями сбоя. Раньше это было
  единственной фатальной веткой фазы и валило весь пайплайн после того, как
  все прогоны и диффы уже посчитаны — опечатка в имени модели судьи или
  протухший ключ больше не уничтожают весь эксперимент.

  Неверный JSON-ответ **не** ошибка и не «не запустилась» — `verdict =
  "unclear"`, `ran = true`, `explanation = rawResponse` (ответ был получен,
  просто не распарсился).

  `explanation` для model-unavailable/timeout/crash **всегда** несёт хвост
  `stderr` (первые 200 символов) — раньше только ветка model-unavailable его
  включала, а crash/timeout откидывали `stderr` целиком, из-за чего
  «judge crashed (exit 1)» не говорило пользователю вообще ничего о причине.
  Полный (не обрезанный) stdout/stderr того самого вызова opencode
  дополнительно пишется в `results/judge.log` (см. §4) — падение
  диагностируется постфактум без повторного прогона.

`judge.json` (сериализованный `JudgeResult`):
```jsonc
{
  "verdict": "ok",            // ok = new лучше или равно old; fail = new хуже
  "oldQuality": 7,
  "newQuality": 8,
  "explanation": "new добавляет валидацию ...",
  "rawResponse": "...",       // полный сырой ответ модели (optional)
  "modelUsed": "anthropic/...",  // какая модель судила
  "timestamp": "2026-07-21T17:06:00+03:00",
  "ran": true                 // false = модель не ответила (см. §2)
}
```

## 3. Шаги алгоритма

1. Если `runInput.judge` отсутствует → записать в `results/judge.json`
   `{ judge: null }` (или не создавать файл вовсе; согласовано: файл создаётся
   всегда с `judge: null`, чтобы `report-render` знал, что фаза была осознанно
   пропущена). Вернуть `JudgeResultOutput { judge: null }`.
2. Выбрать **диффы для судьи**: согласованное решение — использовать
   `diff/old/run-1/full.patch` и `diff/new/run-1/full.patch` (run-1 как
   репрезентативный прогон). Если run-1 failed или `noChanges` — fallback на
   первый непустой прогон.
3. Собрать промпт судьи (`buildJudgePrompt`):
   - `<system context>`: задача (`runInput.prompt`), редактированный `packRef`
     (см. ниже), и **прямое заявление, что у судьи нет файлового доступа
     никакого рода** — ни `report.md/json/html`, ни репозитория, ни
     `results/`. Единственный материал судьи — то, что реально лежит в
     промпте. Это заявление печатается **всегда**, независимо от того, что
     написано в `--judge` — см. «Судья не видит report.md» ниже.
   - `<old side diff>` / `<new side diff>` — на каждую сторону: **сводка по
     всем прогонам** (`summarizeDiffRuns`: по одной строке на `runIndex` —
     `noChanges`/`failed`/счётчики файлов+`+/-`, список путей при ≤20
     изменённых файлах, маркер `[git-restored]`/`[git-replaced]`, если
     protect-git восстанавливал `.git`) **плюс** один репрезентативный патч
     (см. п.2 выше — `run-1`, либо первый непустой). Раньше судья видел
     ТОЛЬКО сырой патч одного прогона и вообще не знал, сколько прогонов было
     и не упал ли кто-то из них — сводка это восполняет данными, которые уже
     лежат в `JudgeInput.diff` (без изменений контракта).
   - если `runInput.judge` (текст инструкции) содержит `report.md`/`.json`/
     `.html`/`.yaml` (регэксп `judgeInstructionMentionsReportFile`,
     регистронезависимый) — вставляется явный блок `<note>`, прямо говорящий
     модели: файл, на который ссылается инструкция, недоступен, и это надо
     явно отразить в `explanation`, а не домысливать содержимое файла. Плюс
     `console.warn` один раз за вызов фазы — оператор видит это в логе
     прогона, а не только в ответе модели.
   - `<judge instruction>`: `runInput.judge` (то, что пользователь передал
     через `--judge`, возможно из `@file`) и JSON-схема ответа.
4. Запустить судью:
   `HOME=<real $HOME> opencode run --agent plan --format json "<prompt>"`
   (без `--auto`), с моделью `runInput.preflightModel` (эта опция теперь
   выбирает только модель судьи — не связана с моделью самого прогона,
   которую пингует preflight). `HOME` — реальный `$HOME` пользователя
   (там лежат креды opencode для авторизации у провайдера); `cwd` — отдельная
   одноразовая scratch-директория (`<tmpdir>/testaipack-judge/<runId>`,
   создаётся перед запуском и удаляется после), а не `$HOME` — агент `plan`
   read-only по `edit`, но diff-контент в промпте не должен получать доступ
   ни к чему ценному через `cwd`, даже случайно.
   Таймаут `runInput.timeouts.runSeconds`, watchdog
   `runInput.timeouts.watchdogSeconds`.
5. Собрать assistant-message из стрима.
   - Модель недоступна у провайдера auth — **не** throw (было: throw
     `JudgeError({ code: "E_MODEL_UNAVAILABLE" })`, валило весь пайплайн после
     того, как все прогоны и диффы уже посчитаны); возвращаем
     `JudgeResult.verdict = "unclear"`, `ran = false`, `explanation` содержит
     модель и хвост stderr (первые 200 символов).
   - Иные сбои (таймаут/crash/429, не удалось создать scratch-директорию) —
     тоже **не** throw; `JudgeResult.verdict = "unclear"`, `ran = false`,
     `explanation` содержит описание сбоя **и тот же хвост stderr** (для
     scratch-директории — нет, opencode вообще не вызывался, `stderr` неоткуда
     взять). Раньше crash/timeout откидывали `stderr` целиком — «judge crashed
     (exit 1)» без единой детали, два прогона подряд, пока не нашли причину
     вручную. После этого шага в `computeJudge` не остаётся ни одной ветки
     `throw`/`Effect.fail` — фаза 09 гарантированно не абортит пайплайн.
   - Полный (не обрезанный) stdout/stderr вызова opencode пишется в
     `results/judge.log` (best-effort, как и `judge.json`) для КАЖДОГО
     реального вызова opencode — успешного или нет; отсутствует только когда
     opencode не вызывался вовсе (`--judge` не задан, оба патча пусты,
     scratch-директория не создалась).
6. Попытаться распарсить ответ как JSON `{ verdict, oldQuality, newQuality,
   explanation }` (допускается JSON в markdown code-fence — извлекаем).
   - Успех → использовать распарсенные поля, `ran = true`.
   - Провал парсинга → `verdict = "unclear"`, `oldQuality = 0`, `newQuality = 0`,
     `explanation = rawResponse`, **`ran = true`** — ответ от модели пришёл,
     просто не распарсился; это не то же самое, что «судья не запустилась».
7. Валидация диапазонов: `oldQuality`, `newQuality` — любое конечное число
   (модель может вернуть дробное значение, например `8.5`), клампится в
   [0,10] и округляется до целого (контракт хранит `int32`). Если вне
   диапазона → clamp + warning. Если поле вообще не число (строка,
   отсутствует) — весь ответ считается невалидным (см. шаг 6).
8. Записать `results/judge.json` (сериализованный `JudgeResult` с
   `modelUsed` и `timestamp`) и, если opencode реально вызывался,
   `results/judge.log` (см. шаг 5). Вернуть `JudgeResultOutput { judge:
   <result> }`.

### Судья не видит `report.md` — почему, и что с этим сделано

Фаза 09 всегда выполняется **до** фазы 11 (report-render) — `report.md` физически
не может существовать в момент, когда судья работает, независимо от того, что
написано в `--judge`. Вдобавок судья запускается в одноразовой пустой
scratch-директории (шаг 4), а не в клоне репозитория — файлов репозитория она
тоже не видит.

Решение (в `src/phases/09-judge.ts`, без изменений контракта/фазы 11):

1. **Дать судье реальный материал вместо report.md** — сводка по всем прогонам
   каждой стороны (`summarizeDiffRuns`, шаг 3) вместо одного сырого патча.
   Это уже данные `JudgeInput.diff` (per-run `summary`/`state`/`noChanges`),
   просто раньше `computeJudge` их не читал. Полноценный `MetricsDiff` (токены,
   стоимость, `successRank`) судье по-прежнему недоступен — `JudgeInput`
   контрактно его не несёт, а добавление такого поля выходит за рамки этой
   фазы (нужен contract-change и проводка через `pipeline.ts`).
2. **Явно и всегда** говорить модели в системном блоке промпта, что у неё нет
   файлового доступа — не только когда инструкция ссылается на файл, а
   вообще всегда, поэтому это не зависит от того, удалось ли распознать
   ссылку на файл в тексте пользователя.
3. Когда `--judge` дословно упоминает `report.md`/`.json`/`.html`/`.yaml`
   (`judgeInstructionMentionsReportFile`) — вставлять ЕЩЁ более явный
   `<note>` в промпт (модель обязана написать в `explanation`, что файл был
   недоступен, а не выдумывать его содержимое) и один раз печатать
   `console.warn` при выполнении фазы, чтобы оператор увидел это в логе
   прогона сразу, а не только докопался бы до объяснения модели постфактум.

`judgeFiles?: string[]` (`RunInput`) **не имеет отношения к этой проблеме** —
это провенанс `@file`-ссылок, из которых собран сам текст `--judge`
(идентично `promptFiles`/`initFiles` для `--prompt`/`--init`), а не механизм
дать судье доступ к report.md или любому другому файлу репозитория/отчёта.

### Инъекция через промпт судьи

Фаза 09 передаёт единственную строку — собранный промпт — одним полем
(`prompt`) в `opencodeRun()` (`src/opencode/cli.ts`). Сама фаза 09 не строит
никакой командной строки из diff-контента, не сплитует и не интерполирует
промпт в shell — единственная точка, где `prompt` превращается в argv, это
`buildRunArgs`/`splitForArgv` в `cli.ts`, вне области этой фазы. Класс бага,
из-за которого судья падала с exit 1 (diff-текст читался как CLI-флаги),
целиком локализован там же и чинится отдельно.

## 4. Входные/выходные файлы

| Файл                              | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------- | ------------- | -------------------- |
| `diff/<side>/run-<n>/full.patch`  | Чтение        | текст                |
| `results/judge.json`              | Запись        | `JudgeResult`        |
| `results/judge.log`               | Запись (best-effort, только если opencode реально вызывался) | текст (stdout+stderr) |
| `manifest.json`                   | Чтение        | `Manifest`           |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                       | Код                        |
| --------------------------------------------------- | ----------------------------------------------- | -------------------------- |
| `--judge` не задан                                   | no-op, `JudgeResultOutput.judge = null`         | —                          |
| run-1 патч пустой с обеих сторон                     | fallback на первый непустой, или `unclear`      | —                          |
| Все патчи пустые                                     | `verdict = "unclear"`, `ran = false`            | —                          |
| Ответ модели — невалидный JSON                       | `verdict = "unclear"`, `explanation = raw`      | —                          |
| Ответ — JSON в code-fence                            | извлекаем и парсим                              | —                          |
| `oldQuality = 15` (вне диапазона)                    | clamp до 10, warning                            | —                          |
| `oldQuality = 8.5` (дробное)                          | принимается, округляется до 8 или 9             | —                          |
| `oldQuality = "8"` (не число)                         | весь ответ невалиден → `verdict = "unclear"`, `ran = true` | —                  |
| Модель недоступна у провайдера auth                  | `verdict = "unclear"`, `ran = false` (не throw) | —                          |
| Таймаут / crash / 429 у судьи                        | `verdict = "unclear"`, `ran = false` с описанием сбоя (не throw) | —          |
| Не удалось создать scratch-директорию                | `verdict = "unclear"`, `ran = false`, opencode не вызывается | —              |
| Оба патча очень большие (>100KB)                    | truncate до 50KB каждый, warning                | —                          |
| `judge` ссылается на `@file`, которого нет           | клирится ещё в фазе 00 → сюда не доходит        | — (через 00)               |
| `--judge` упоминает `report.md`/`.json`/`.html`/`.yaml` | `<note>` в промпте + `console.warn` один раз; модель не должна выдумывать содержимое | — |
| Прогон одной из сторон помечен `state = "failed"`    | попадает в `summarizeDiffRuns` явной строкой, не пропускается молча | —      |
| Crash/timeout судьи со stderr в выводе               | `explanation` несёт хвост (200 симв.), полный stdout/stderr — в `judge.log` | — |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path: judge задан, оба патча есть, ответ валидный JSON →
  `verdict = "ok"`, `oldQuality: 7`, `newQuality: 8`, explanation непустой,
  `modelUsed` и `timestamp` заполнены, `ran = true`.
- ✅ skipped: judge не задан → `JudgeResultOutput.judge = null`, файл
  `results/judge.json` содержит `{ judge: null }`.
- ✅ run-1 empty fallback: old/run-1 патч пустой, old/run-2 непустой →
  используется run-2.
- ✅ all empty: все патчи пустые → `verdict = "unclear"`,
  `explanation = "no diffs"`.
- ✅ invalid JSON response: модель вернула prose → `verdict = "unclear"`,
  `explanation` = сырой текст.
- ✅ JSON in code-fence: ответ ` ```json {…} ``` ` → успешно распарсено.
- ✅ out-of-range score: `oldQuality = 15` → clamp до 10, warning.
- ✅ fractional score: `oldQuality = 8.5` → принимается и округляется
  (было: отклонялось как невалидный ответ).
- ✅ non-numeric score: `oldQuality = "8"` (строка) → всё ещё невалидно,
  `verdict = "unclear"`.
- ✅ agent/isolation: запрос к opencode собирается с `agent: "plan"`,
  `auto: false` и `cwd`, отличным от `homeDir` (scratch-директория,
  содержащая `testaipack-judge` в пути); `homeDir` остаётся реальным
  `$HOME`.
- ✅ scratch cleanup: scratch-директория `cwd` удаляется после завершения
  вызова судьи.
- ✅ model unavailable: модель судьи недоступна → фаза успешна,
  `verdict = "unclear"`, `ran = false` (было: throw `E_MODEL_UNAVAILABLE`,
  валило пайплайн после того, как все прогоны и диффы уже посчитаны).
- ✅ judge timeout: судья висит > `timeouts.runSeconds` → НЕ throw,
  `verdict = "unclear"`, `ran = false`, с описанием.
- ✅ judge crash: opencode exit 1 → НЕ throw, `verdict = "unclear"`,
  `ran = false`.
- ✅ judge rate-limit: серия 429 → НЕ throw, `verdict = "unclear"`,
  `ran = false`.
- ✅ parse failure keeps ran true: невалидный JSON-ответ → `verdict =
  "unclear"`, но `ran = true` и `rawResponse` хранит сырой ответ — судья
  запустилась, просто не определилась.
- ✅ large diffs: оба патча > 100KB → обрезаны до 50KB, warning в логе.
- ✅ report renderer: `judge.ran === false` → md/html рендерят «Judge did not
  run: <explanation>» без блока verdict/quality; `ran` отсутствует (старый
  `report.json`) → рендерится как раньше.
- ✅ crash explanation includes stderr tail: opencode падает с непустым
  `stderr` → `explanation` содержит и «crash», и сам текст stderr (раньше
  откидывался целиком — «judge crashed (exit 1)» без единой детали).
- ✅ timeout explanation includes stderr tail: то же для таймаута, если
  процесс успел что-то написать до kill.
- ✅ judge.log: `results/judge.log` пишется с полным stdout при успешном
  ответе и с полным stderr при crash — доступен без повторного прогона.
- ✅ judge.log absent: `--judge` не задан, оба патча пусты, или scratch-
  директория не создалась → `judge.log` не пишется (opencode не вызывался).
- ✅ report-file note in prompt: `--judge` содержит `report.md` →
  `buildJudgePrompt` вставляет `<note>`, объясняющий недоступность файла;
  инструкция без такого упоминания — `<note>` отсутствует.
- ✅ report-file console warning: то же условие → `console.warn` с текстом,
  упоминающим `report.md/json/html`, ровно один раз за вызов фазы; для
  обычной инструкции — не печатается вовсе.
- ✅ no-file-access disclaimer always present: `buildJudgePrompt` для ЛЮБОЙ
  инструкции (не только упоминающей report.md) содержит явное заявление,
  что у судьи нет файлового доступа.
- ✅ summarizeDiffRuns: сортировка по `runIndex`; `noChanges` и `failed`
  (с `error.message`) отражены отдельными строками, а не пропущены;
  список файлов показывается при ≤20 изменённых, иначе — только счётчик;
  `state = "git-restored"/"git-replaced"` отражается маркером в строке.
- ❌ НЕ покрыто (ticket): multi-run judge (оценка по всем N прогонам с
  усреднением) — ticket про v0.2.
- ❌ НЕ покрыто (ticket): полноценный `MetricsDiff` (токены/стоимость/
  `successRank`) в промпте судьи — требует contract-change на `JudgeInput`,
  вне рамок этой фазы (см. «Судья не видит report.md» выше).

## 7. Инварианты

- После фазы `results/judge.json` существует **всегда** (`judge: null` если
  судья не запрашивалась) — так `report-render` отличает «судья не
  запрашивалась» от «судья упала».
- `verdict ∈ {"ok", "fail", "unclear"}` (значения `JudgeVerdict`); `null`
  только в `JudgeResultOutput.judge`, не в самом `JudgeResult`.
- Если `verdict ≠ "unclear"`, то `oldQuality` и `newQuality` ∈ [0, 10].
- `modelUsed` фиксирует, какая модель судила; `timestamp` — момент вердикта.
- `rawResponse` сохраняется (optional) для отладки и аудита.
- `ran` (optional, отсутствие = `true`) отличает «нет ответа модели» (`false`
  — недоступна модель, таймаут, crash, сбой scratch-директории, оба патча
  пусты) от «ответ получен» (`true` — валидный вердикт или невалидный JSON,
  который всё равно является ответом). Фаза 09 никогда не завершается ошибкой:
  `computeJudge` не содержит ни одной ветки `throw`/`Effect.fail`.
- Судья всегда запускается с read-only агентом `plan` и `auto: false` — она
  получает в промпт непроверенный diff-контент агента под тестом, и не
  должна иметь возможность что-то менять. `cwd` — одноразовая
  scratch-директория, никогда не `homeDir`; `homeDir` остаётся реальным
  `$HOME` — только там есть креды opencode, нужные, чтобы судья вообще
  смогла авторизоваться у провайдера.
- Судья никогда не имеет файлового доступа (ни `report.md`, ни репозитория,
  ни `results/`) — промпт заявляет это явно и безусловно, а не только когда
  `--judge` упоминает конкретный файл; это инвариант промпта, не гарантия
  поведения модели.
- Фаза 09 передаёт `prompt` единственной строкой в `opencodeRun()` — она сама
  не строит командную строку из diff-контента и не сплитует/интерполирует
  промпт; вся ответственность за безопасное превращение строки в argv лежит
  на `src/opencode/cli.ts`.
- `results/judge.log` существует тогда и только тогда, когда opencode был
  реально вызван за этот прогон (независимо от исхода) — как и `judge.json`,
  запись best-effort и не валит фазу при сбое диска.

## 8. Зависимости от других фаз

- Зависит от: **08 diff** (нужны `diff/<side>/run-N/full.patch`), **00
  cli-parse** (`runInput.judge`, `runInput.preflightModel`). От **04
  home-isolation** судья не зависит — она запускается в реальном `$HOME`
  пользователя, а не в одном из изолированных HOME фазы 04.
- Блокирует: **11 report-render** (блок «LLM-судья» в отчёте показывается
  только если `JudgeResultOutput.judge !== null`).
- Параллелизуется с: **07 aggregate**, **08 diff** — все читают независимые
  артефакты фазы 06; но judge дополнительно требует завершённого diff, поэтому
  на практике стартует после 08 (или параллельно с aggregate после того, как
  diff готов).
