# Фаза 09: judge (опциональная)

> Спека фазы. Контракт = `contract/phases/09-judge.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Если задан `--judge`, прогнать LLM-судью по диффам **всех N вариантов** и
получить независимую качественную оценку: единый `verdict` (ok/fail/unclear),
балл на каждый вариант (0–10), ранжирование от лучшего к худшему,
объяснение. Без `--judge` фаза пропускается.

Раньше судья сравнивала ровно две стороны (`oldQuality`/`newQuality`). Теперь
она видит **все N вариантов сразу, одним вызовом** (baseline первым,
паковый состав каждого варианта раскрыт в промпте) — если собранный промпт
укладывается в бюджет одного вызова; при превышении — фолбэк на **N−1
попарных вызовов** (каждый — baseline + один не-baseline вариант). Полный
дизайн: `.research/n-way-variants/03-hard-problems.md §2`.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.Judge` (см. `contract/phases/09-judge.tsp`).

- Вход: `JudgeInput` — `{ runInput: RunInput, manifest: Manifest, diffs:
  DiffResult[] }` (было `diff: { old, new }`) — по одному `DiffResult` на
  каждый вариант. Если `runInput.judge` (промпт судьи) отсутствует → фаза
  возвращает `JudgeResultOutput { judge: null }` (no-op).
- Выход: `JudgeResultOutput` — `{ judge: JudgeResult | null }`.
  `JudgeResult = { verdict: JudgeVerdict, scores: VariantScore[], ranking:
  string[], explanation: string, rawResponse?: string, modelUsed: string,
  timestamp: utcDateTime, ran?: boolean, pairwiseFallback?: boolean }`.
  - `scores: VariantScore[]` — `{ variant: string, quality: int32 (0–10) }`,
    **по записи на каждый вариант, включая baseline** (заменяет
    `oldQuality`/`newQuality`).
  - `ranking: string[]` — имена вариантов, от лучшего к худшему; выводится из
    `scores`, если модель его не прислала или прислала невалидным (не
    перестановку имён вариантов).
  - `pairwiseFallback?: boolean` — `true`, когда собранный промпт превысил
    бюджет одного вызова и оценки получены попарными вызовами (см. §2.3).
  - `JudgeVerdict ∈ { "ok", "fail", "unclear" }`. **Семантика для N вариантов
    (решение D11)**: `ok` = выход ЛУЧШЕГО по ранжированию варианта решает
    задачу; `fail` = ни один вариант её не решает; `unclear` — как раньше.
  - `judge = null` — когда судья не запрашивалась.
- `ran` различает «судья не смогла запуститься» от «судья запустилась и не
  определилась»: `ran: true` — модель судьи была вызвана и вернула ответ (даже
  мусорный — тогда `rawResponse` его хранит, а `verdict = "unclear"`);
  `ran: false` — ответа модели вообще нет. Отсутствие поля (старый
  `report.json`) читается как `true`.
- Ошибки: фаза **никогда не падает**. `@error JudgeError` — `{ code:
  "E_MODEL_UNAVAILABLE", message, context? }` — модель остаётся в контракте
  (легальна для схемы), но фаза 09 её не бросает: недоступность модели судьи
  деградирует так же, как таймаут/crash/rate-limit — `verdict: "unclear"`,
  `ran: false`, `explanation` с деталями сбоя.

  Неверный JSON-ответ **не** ошибка и не «не запустилась» — `verdict =
  "unclear"`, `ran = true`, `explanation = rawResponse`.

`judge.json` (сериализованный `JudgeResult`, N-way пример):
```jsonc
{
  "verdict": "ok",
  "scores": [
    { "variant": "old", "quality": 6 },
    { "variant": "graphify", "quality": 8 },
    { "variant": "ast-grep", "quality": 5 }
  ],
  "ranking": ["graphify", "old", "ast-grep"],
  "explanation": "graphify добавляет валидацию ...",
  "rawResponse": "...",
  "modelUsed": "anthropic/...",
  "timestamp": "2026-07-21T17:06:00+03:00",
  "ran": true,
  "pairwiseFallback": false
}
```

## 3. Шаги алгоритма

1. Если `runInput.judge` отсутствует → записать в `results/judge.json`
   `{ judge: null }`. Вернуть `JudgeResultOutput { judge: null }`.
2. Выбрать **диффы для судьи**: для каждого варианта — `run-1`, как
   репрезентативный прогон; если run-1 failed или `noChanges` — fallback на
   первый непустой прогон этого варианта (`firstNonEmptyPatch`).
3. Собрать промпт судьи (`buildJudgePrompt`) — **один вызов на всех N
   вариантов**, если бюджет позволяет (см. §2.3):
   - `<system context>`: задача, **прямое заявление, что у судьи нет
     файлового доступа никакого рода** (печатается всегда, независимо от
     текста `--judge` — см. «Судья не видит report.md» ниже); указание, что
     это N-вариантный эксперимент, имя baseline-варианта, и паковый состав
     КАЖДОГО варианта (`packsListLabel`) — например: `Variant "old" is the
     BASELINE. Variants and their packs: old (no packs); graphify (packs:
     graphify); ast-grep (packs: ast-grep)`.
   - по одному блоку `<variant "<name>" [(BASELINE)], packs: ...>` на каждый
     вариант, **baseline первым**: сводка по всем прогонам
     (`summarizeDiffRuns`: по одной строке на `runIndex` — noChanges/failed/
     счётчики файлов+`+/-`, список путей при ≤20 изменённых файлах, маркер
     `[git-restored]`/`[git-replaced]`) плюс один репрезентативный патч (п.2
     выше), обрезанный `truncatePatch` (`MAX_PATCH_CHARS = 100_000` →
     обрезка до `50_000`). Если у варианта нет изменений ни на одном
     прогоне — блок содержит `(no changes on any run)` вместо блока patch:
     пустой вариант остаётся в промпте и ранжируется, а не молча
     пропускается.
   - если у какого-то варианта свой (не унаследованный) промпт — заголовок
     явно об этом сообщает, и блок этого варианта несёт свою строку `task
     prompt:` — судья должна знать, что арms решали разные задачи (edge
     case, раскрывается, а не прячется).
   - если `runInput.judge` (текст инструкции) упоминает `report.md`/`.json`/
     `.html`/`.yaml` (`judgeInstructionMentionsReportFile`) — вставляется
     явный `<note>`, плюс `console.warn` один раз за вызов фазы.
   - `<judge instruction>`: `runInput.judge` и JSON-схема ответа
     (`JUDGE_RESPONSE_FORMAT`):
     ```
     { "verdict": "ok" | "fail" | "unclear",
       "scores": { "<variant name>": 0-10, ... по записи на каждый вариант ... },
       "ranking": ["лучший вариант", ..., "худший"],
       "explanation": "..." }
     ```
4. Запустить судью: `HOME=<real $HOME> opencode run --agent plan --format
   json "<prompt>"` (без `--auto`), с моделью `runInput.preflightModel`.
   `HOME` — реальный `$HOME` пользователя; `cwd` — одноразовая scratch-
   директория (`<tmpdir>/testaipack-judge/<runId>`). Таймаут
   `runInput.timeouts.runSeconds`, watchdog `runInput.timeouts.watchdogSeconds`.
5. Собрать assistant-message из стрима. Модель недоступна / таймаут / crash /
   429 / не удалось создать scratch-директорию — **не** throw в любом из
   случаев; `JudgeResult.verdict = "unclear"`, `ran = false`, `explanation`
   содержит описание сбоя и хвост stderr (первые 200 символов, когда он
   есть). Полный (не обрезанный) stdout/stderr вызова opencode пишется в
   `results/judge.log`.
6. Попытаться распарсить ответ как JSON (`parseJudgeResponse`, допускается
   JSON в markdown code-fence). Успех → `ran = true`. Провал парсинга →
   `verdict = "unclear"`, все `scores` = 0, `explanation = rawResponse`,
   **`ran = true`**.
7. **Разбор `scores` (`extractScores`)**: принимается запись `{ "<variant
   name>": число, ... }` — регистронезависимое сопоставление с именами
   вариантов; неизвестные ключи игнорируются; отсутствие числа для
   какого-либо реального варианта ⇒ вся структура невалидна (шаг 6).
   **Легаси-совместимость**: если множество имён вариантов ровно `{old,
   new}` (легаси-шим), дополнительно принимаются старые ключи
   `oldQuality`/`newQuality` — какая-нибудь локальная модель, «привыкшая» к
   старому формату по обучающим примерам, всё ещё будет понята правильно.
   Для любого другого набора имён вариантов эти ключи не имеют смысла и не
   проверяются.
8. **Разбор `ranking`**: опционален; если прислан — должен быть перестановкой
   имён вариантов (регистронезависимо, канонизируется обратно к точному
   написанию); невалидный или отсутствующий → выводится из `scores`
   (`deriveRanking`, сортировка по убыванию quality, `id`-стабильная при
   равенстве — совпадает с порядком конфига).
9. Валидация диапазонов: каждый `quality` — любое конечное число, клампится в
   [0,10] и округляется до целого.
10. Записать `results/judge.json` (сериализованный `JudgeResult`) и, если
    opencode реально вызывался, `results/judge.log`. Вернуть
    `JudgeResultOutput { judge: <result> }`.

### 2.1 Бюджет одного вызова и попарный фолбэк (решение D10)

**Порог**: `JUDGE_SINGLE_CALL_BUDGET_CHARS = 260_000` символов, измеряется на
**полностью собранной строке промпта одного вызова** (после обрезки каждого
патча), прямо перед вызовом opencode — символы, не токены. Почему 260k:
худший 2-сторонний промпт легаси-шима — около 210k символов (2 × 100k
обрезанных патча + сводки + инструкция), и сегодняшний код отправляет его
без проблем — бюджет не должен регрессировать этот путь. 3 варианта
близких-к-лимиту патчей (~310k) превышают порог → фолбэк; 3 варианта
типичных патчей (5–30k) остаются одним вызовом.

**Фолбэк = попарно-против-baseline**: один вызов на каждый не-baseline
вариант, промпт — та же раскладка, но ровно с двумя блоками вариантов
(baseline + V), та же схема ответа (2 записи `scores`, 2 записи `ranking`).
Каждый парный промпт по построению ≤ худшего 2-стороннего случая сегодня.
Сборка:

- оценка не-baseline варианта — из его собственного парного вызова;
- оценка baseline — **медиана** его оценок по всем парным вызовам
  (объяснение включает `"baseline score = median of {k} pairwise scores"`);
- `ranking` — сортировка по убыванию собранных оценок, при равенстве —
  порядок конфига;
- `verdict` — `ok`, если хотя бы один парный вердикт `ok`; `fail`, если все
  парные — `fail`; иначе `unclear`;
- `explanation` — конкатенация парных объяснений, каждая с префиксом `"vs
  {v}: ..."`; `rawResponse` — сырые ответы всех вызовов через разделитель;
- `pairwiseFallback: true`; один `judge.log`, содержащий все вызовы
  (`buildJudgeLog` по каждому, конкатенированы);
- сбой ОДНОГО парного вызова понижает оценку только этого варианта до
  «unclear»-состояния (`quality: 0` + пометка в объяснении); `ran` остаётся
  `true`, если успел хотя бы один вызов, иначе весь результат — обычная
  деградация `ran: false`.

### Судья не видит `report.md` — почему, и что с этим сделано

Фаза 09 всегда выполняется **до** фазы 11 (report-render) — `report.md`
физически не может существовать в момент, когда судья работает. Вдобавок
судья запускается в одноразовой пустой scratch-директории, а не в клоне
репозитория.

Решение (в `src/phases/09-judge.ts`, без изменений контракта/фазы 11):

1. **Дать судье реальный материал вместо report.md** — сводка по всем
   прогонам каждого варианта (`summarizeDiffRuns`) вместо одного сырого
   патча.
2. **Явно и всегда** говорить модели в системном блоке промпта, что у неё
   нет файлового доступа — не только когда инструкция ссылается на файл.
3. Когда `--judge` дословно упоминает `report.md`/`.json`/`.html`/`.yaml` —
   вставлять ещё более явный `<note>` и один раз печатать `console.warn`.

`judgeFiles?: string[]` (`RunInput`) не имеет отношения к этой проблеме — это
провенанс `@file`-ссылок, из которых собран сам текст `--judge`.

### Инъекция через промпт судьи

Фаза 09 передаёт единственную строку — собранный промпт — одним полем
(`prompt`) в `opencodeRun()` (`src/opencode/cli.ts`). Сама фаза 09 не строит
никакой командной строки из diff-контента, не сплитует и не интерполирует
промпт в shell — единственная точка, где `prompt` превращается в argv, это
`buildRunArgs`/`splitForArgv` в `cli.ts`, вне области этой фазы.

## 4. Входные/выходные файлы

| Файл                              | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------- | ------------- | -------------------- |
| `diff/<variant>/run-<n>/full.patch` | Чтение      | текст                |
| `results/judge.json`              | Запись        | `JudgeResult`        |
| `results/judge.log`               | Запись (best-effort, только если opencode реально вызывался) | текст (stdout+stderr, все вызовы, включая попарные) |
| `manifest.json`                   | Чтение        | `Manifest`           |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                       | Код                        |
| --------------------------------------------------- | ------------------------------------------------ | -------------------------- |
| `--judge` не задан                                   | no-op, `JudgeResultOutput.judge = null`         | —                          |
| run-1 патч пустой у какого-то варианта                | fallback на первый непустой прогон этого варианта | —                        |
| У варианта нет изменений НИ НА ОДНОМ прогоне          | блок варианта — `(no changes on any run)`, остаётся в промпте и ранжируется | — |
| Все патчи всех вариантов пустые                       | `verdict = "unclear"`, `ran = false`            | —                          |
| Ответ модели — невалидный JSON                        | `verdict = "unclear"`, `explanation = raw`, `ran = true` | —                  |
| Ответ — JSON в code-fence                              | извлекаем и парсим                              | —                          |
| `quality` вне [0,10] / дробное                          | clamp + округление, warning                     | —                          |
| `scores` не число для реального варианта                | весь ответ невалиден → `verdict = "unclear"`    | —                          |
| Легаси-шим (`{old,new}`), ответ несёт `oldQuality`/`newQuality` вместо `scores` | принимается, маппится в `scores` | — |
| N-way (3+ варианта), ответ несёт `oldQuality`/`newQuality` | НЕ принимается (легаси-ключи валидны только для `{old,new}`) → `verdict = "unclear"` | — |
| `ranking` — не перестановка имён вариантов              | игнорируется, выводится из `scores`             | —                          |
| Собранный промпт > 260 000 символов                      | попарный фолбэк, `pairwiseFallback: true`       | —                          |
| Один из попарных вызовов упал                            | оценка только этого варианта — 0 + пометка, остальные не затронуты | — |
| Модель недоступна у провайдера auth                       | `verdict = "unclear"`, `ran = false` (не throw) | —                          |
| Таймаут / crash / 429 у судьи                              | `verdict = "unclear"`, `ran = false` с описанием сбоя (не throw) | —          |
| Не удалось создать scratch-директорию                      | `verdict = "unclear"`, `ran = false`, opencode не вызывается | —              |
| `--judge` упоминает `report.md`/`.json`/`.html`/`.yaml`     | `<note>` в промпте + `console.warn` один раз    | —                          |
| Прогон одного из вариантов помечен `state = "failed"`       | попадает в `summarizeDiffRuns` явной строкой, не пропускается молча | —      |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path 3-way, в рамках бюджета: judge задан, диффы 3 вариантов в
  рамках 260k → 1 вызов opencode (мок), `scores.length === 3`,
  `ranking.length === 3`, `pairwiseFallback` отсутствует/`false`.
- ✅ skipped: judge не задан → `JudgeResultOutput.judge = null`.
- ✅ run-1 empty fallback: у варианта run-1 патч пустой, run-2 непустой →
  используется run-2.
- ✅ all empty: все патчи всех вариантов пустые → `verdict = "unclear"`.
- ✅ invalid JSON response / JSON in code-fence — как раньше.
- ✅ out-of-range / fractional / non-numeric score — как раньше, теперь на
  уровне произвольного имени варианта в `scores`.
- ✅ shim legacy keys accepted: variantNames === `{old, new}`, ответ несёт
  `{"oldQuality": 7, "newQuality": 8}` → маппится в `scores: [{old,7},
  {new,8}]`.
- ✅ legacy keys rejected for N-way: variantNames === `{old, graphify,
  ast-grep}`, ответ несёт только `oldQuality`/`newQuality` (без `scores`) →
  `verdict = "unclear"` (легаси-ключи валидны только для точной пары
  `{old,new}`).
- ✅ ranking derived: ответ несёт `scores`, но не `ranking` (или невалидный)
  → `ranking` выведен сортировкой по убыванию `quality`, порядок конфига при
  равенстве.
- ✅ oversized prompt → pairwise fallback: 3 варианта, патчи близко к лимиту
  → собранный промпт > 260 000 символов (мок-измерение) → N−1 вызовов
  (мок), `pairwiseFallback: true`, `scores[baseline].quality` = медиана его
  парных оценок, `explanation` содержит `"median of"`.
  `judge.log` содержит все N−1 вызовов.
- ✅ pairwise fallback, one pair fails: 2 не-baseline варианта, один из
  парных вызовов падает (timeout) → оценка только этого варианта = 0 +
  пометка, оценка другого варианта и общий `ran` не затронуты.
- ✅ model unavailable / judge timeout / judge crash / judge rate-limit —
  как раньше, `verdict = "unclear"`, `ran = false`, не throw.
- ✅ parse failure keeps ran true — как раньше.
- ✅ large diffs: патч > 100KB → обрезан до 50KB.
- ✅ empty-variant disclosure: вариант без изменений остаётся в промпте с
  `(no changes on any run)`, попадает в `scores`/`ranking` наравне с
  остальными, а не пропускается.
- ✅ different task prompts disclosed: у одного варианта свой `prompt` →
  заголовок промпта судьи и блок этого варианта явно называют, что промпты
  различаются.
- ✅ report renderer: `judge.ran === false` → md/html рендерят «Judge did not
  run: <explanation>»; N-way секция показывает ranking и таблицу
  `variant → quality`.
- ✅ report-file note in prompt / console warning — без изменений.
- ✅ no-file-access disclaimer always present — без изменений.
- ✅ summarizeDiffRuns — без изменений семантики, работает на любом
  количестве вариантов.
- ❌ НЕ покрыто (ticket): нет выделенного теста на вариант с НЕСКОЛЬКИМИ
  паками в промпте судьи — `packsListLabel`/`packsTagLabel` уже принимают
  `readonly string[]` и печатают все паки варианта через запятую (не
  ограничены одним), реализация N-pack-ready; отсутствует только
  прицельный тест-кейс, не сама поддержка.

## 7. Инварианты

- После фазы `results/judge.json` существует **всегда** (`judge: null` если
  судья не запрашивалась).
- `verdict ∈ {"ok", "fail", "unclear"}`; `null` только в
  `JudgeResultOutput.judge`, не в самом `JudgeResult`.
- Если `verdict ≠ "unclear"`, то `scores[*].quality ∈ [0, 10]`.
- `scores.length === ranking.length === число вариантов эксперимента` —
  каждый вариант, включая baseline, представлен в обоих массивах.
- `ranking` — всегда перестановка имён вариантов (валидная от модели или
  выведенная).
- `modelUsed` фиксирует, какая модель судила; `timestamp` — момент вердикта.
- `pairwiseFallback === true` ⇔ оценки собраны из N−1 попарных вызовов, а не
  одного N-вариантного.
- `ran` (optional, отсутствие = `true`) отличает «нет ответа модели» от
  «ответ получен». Фаза 09 никогда не завершается ошибкой:
  `computeJudge` не содержит ни одной ветки `throw`/`Effect.fail`.
- Судья всегда запускается с read-only агентом `plan` и `auto: false`;
  `cwd` — одноразовая scratch-директория, никогда не `homeDir`; `homeDir`
  остаётся реальным `$HOME`.
- Судья никогда не имеет файлового доступа — промпт заявляет это явно и
  безусловно.
- `results/judge.log` существует тогда и только тогда, когда opencode был
  реально вызван за этот прогон (один или несколько раз, при фолбэке) —
  best-effort, не валит фазу при сбое диска.

## 8. Зависимости от других фаз

- Зависит от: **08 diff** (нужны `diff/<variant>/run-N/full.patch` для
  каждого варианта), **00 cli-parse** (`runInput.judge`,
  `runInput.preflightModel`, `runInput.baseline`). От **04 home-isolation**
  судья не зависит — она запускается в реальном `$HOME` пользователя.
- Блокирует: **11 report-render** (блок «LLM-судья» в отчёте показывается
  только если `JudgeResultOutput.judge !== null`).
- Параллелизуется с: **07 aggregate**, **08 diff** — все читают независимые
  артефакты фазы 06; но judge дополнительно требует завершённого diff, поэтому
  на практике стартует после 08.
