# Фаза 11: report-render

> Спека фазы. Контракт = `contract/phases/11-report-render.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Собрать из `metrics.json`, диффов всех вариантов, `judge.json` и
`timeline.html` итоговый отчёт во всех запрошенных форматах (`--format`):
обязательные `report.md` (в stdout + файл) и `report.json` (файл),
опциональные `report.html` и `report.yaml`. Для N вариантов таблицы стали
**metric-major** (одна строка на пару метрика×вариант) вместо
фиксированных 2-колоночных пар old/new — раскладка нормативно описана в
`.research/n-way-variants/03-hard-problems.md §4`.

### 1a. Граница языков: русский текст vs английские имена полей

`report.md`/`report.html`/`timeline.html` и вывод `compare` — рендерятся на
русском: заголовки секций, вердикты, лейблы таблиц, заголовок-summary
(значение `summary.headlineResult`), провенанс-блок и его пер-полевые
заметки при `report --rebuild` (`src/cli/rebuild.ts`), текст деталей
contamination-сигналов (`src/metrics/baseline-contamination.ts`). Каждая
строка ниже в §3, приведённая как пример вывода, — реальный русский текст
рендерера (`src/report/md.ts`), а не перевод для документации.

Это НЕ распространяется на:
- **`report.json`/`report.yaml`** — имена полей контракта остаются
  английскими (`headlineResult`, `variant`, `significant`, `better`, …),
  `schemaVersion` не меняется. Единственное исключение — само ЗНАЧЕНИЕ поля
  `summary.headlineResult`: строка, а не структура, поэтому она на русском,
  как и в md/html.
- **Собственный терминальный вывод CLI** — строки прогресса прогона
  (`src/cli/progress.ts`), вывод `gc`/`doctor`/`list`, сообщения ошибок
  валидации конфига. Это осознанная граница, не недосмотр: report-рендер —
  для человека, читающего готовый отчёт; CLI-вывод — для терминала/логов,
  где английский остаётся дефолтом инструмента.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.ReportRender` (см.
`contract/phases/11-report-render.tsp`).

- Вход: `ReportRenderInput` — `{ runInput: RunInput, manifest: Manifest,
  metrics: MetricsReport, timeline: Timeline, diffs: DiffResult[], judge?:
  JudgeResult, summary: ReportSummary }` (было `metricsDiff`/`diff: {old,new}`):
  - `metrics` (`MetricsReport`) — результат фазы 07: `{ baseline, variants:
    VariantAggregates[], deltas: VariantDelta[], allFailed }`.
  - `timeline` (`Timeline`) — результат фазы 10 (`{ lanes: VariantTimeline[],
    mode }`).
  - `diffs: DiffResult[]` — по одной записи на каждый вариант, из фазы 08.
  - `judge?` — опциональный `JudgeResult` (N-way, `scores: VariantScore[]`) из
    фазы 09; отсутствует, если судья не запрашивалась.
  - `summary` (`ReportSummary`) — собранная оркестратором сводка:
    `headlineResult: string`, `perVariant: VariantSummary[]` (было плоские
    `improvements`/`regressions`/`neutral` — теперь по записи `{ variant,
    improvements, regressions, neutral }` **на каждый не-baseline вариант**),
    `failures: FailedRun[]`, `basis?: "task" | "total"`.
- Выход: `ReportRenderResult` — `{ formats: OutputFormat[], paths: { md?:
  string; json?: string; yaml?: string; html?: string }, stdoutFormat: "md" |
  "json" }` — без изменений структуры.
- Ошибки: `@error ReportRenderError` — `{ code, message, context? }`, где
  `code`:
  - `E_DISK_FULL` — нет места писать отчёт (`ENOSPC`).
  - `E_EXPORT_INVALID` — собранный `Report` не прошёл собственную
    `reportSchema` перед сериализацией в JSON/YAML.

## 3. Секции `report.md`, в порядке рендера (`renderMd`)

Порядок: `Header → Summary → Primary metrics → Phase split → Harness
preparation → Pack signal → Safety → Contamination → Secondary → Failed runs
→ LLM Judge → Timeline summary → Diff summary`. Каждая секция — свой чистый
рендерер (`src/report/md.ts`), пропускается (пустая строка, отфильтровывается)
при отсутствии релевантных данных.

**Header** (`renderHeader`): run-id, repo,
`**Варианты:** <descriptor каждого варианта>` (было `pack | smoke-test`) —
`variantDescriptor` перечисляет паки и pure-статус каждого варианта,
например `baseline* (без пакетов, чистый), graphify (пакеты: graphify),
code-review-graph (пакеты: code-review-graph)` (реальная строка из
успешного трёхвариантного прогона — см. README, «N-way пример»), звёздочка
помечает baseline; `**Запуски:** N на вариант`; timestamp; версия opencode +
warning о рассинхроне; опциональные disclosure-строки **Промпт**/
**Подсказка** (`hint`; отдельной строки для `init` в текущем рендере нет,
он раскрывается только через фазовую разбивку) — печатаются, только если
эффективные значения расходятся между вариантами (группируют варианты по
источнику: «глобальный init» / «свой текст» / «явно отключён»). Раньше был
единственный факт «сторонам ушёл идентичный текст»; теперь per-variant
текст — законная возможность, и заголовок обязан явно это раскрыть, а не
молчать.

**Summary** (`renderSummary`): до трёх видов alert-строк наверху —
`allFailed`-баннер (`> ⚠ **Все варианты провалились — сравнение
недоступно.**`), `pairIncomplete`-предупреждение на каждый неполный
не-baseline вариант, pack-noop alert, `⚠ обнаружено: N опасная
команда/опасные команды/опасных команд — см. раздел «Безопасность»`,
contamination-alert (называет все затронутые варианты и суммарное число
сигналов). Заголовок-summary (`headlineResult`) — по одной клаузе **на
каждый не-baseline вариант**, в порядке конфига, например (реальная строка
из отчёта успешного трёхвариантного прогона, README «N-way пример»):
```
По сравнению с baseline: graphify — нет значимых различий (0 лучше, 4 хуже, всё в пределах шума); code-review-graph — нет значимых различий (0 лучше, 4 хуже, всё в пределах шума).
```
или, когда есть значимые различия:
```
По сравнению с base: graphify — 2 значимых улучшения: Всего токенов, Шаги; ast-grep — нет значимых различий (3 лучше, 1 хуже, всё в пределах шума).
```
Ниже — блок `### vs база: <variant>` на каждый не-baseline вариант с
бакетами Улучшения/Регрессии/Нейтральные (было — единственный плоский блок
new-vs-old).

**Primary metrics — total (init + task)** (`renderPrimary`): metric-major
длинная таблица — одна строка на каждую (метрика, вариант) пару, строка
baseline идёт первой в каждой группе метрики, колонки дельт пустые на
строке baseline:

```md
| Метрика | Вариант | Медиана | [мин–макс] | Δ vs база | Δ% | Значимо | Вердикт |
|---|---|---|---|---|---|---|---|
| Всего токенов | base* | 120000 | 100000–130000 (IQR=9000) | — | — | — | — |
| Всего токенов | graphify | 90000 | 85000–99000 (IQR=5000) | -30000 | -25.0% | ✓ значимо | ✓ лучше |
| Всего токенов | ast-grep | 118000 | 90000–160000 (IQR=30000) | -2000 | -1.7% | в пределах шума | ✓ лучше |
```
`Значимо` ∈ `{✓ значимо, ⚠ значимо, значимо, в пределах шума, —}`
(`sigLabel`); `Вердикт` ∈ `{✓ лучше, ⚠ хуже, = без изменений, ≈ контекст}`
(`verdictFor`, `VERDICT_MAP`) — оба словаря зафиксированы в
`src/report/format.ts`, не выводятся заново на каждый рендер.

Футер (`primaryFootnote`): `_* база._`, и если `deltas.length > 1` —
однострочная оговорка о множественных сравнениях (реальный текст,
`src/report/md.ts`): `N−1 = {k} сравнения/сравнений делят один базовый
вариант; при таком размере выборки возможны отдельные случайные пометки
«значимо» — сигналом считайте разницу в количестве таких пометок между
вариантами, а не единичную пометку.` Прежние per-pair 2-колоночные таблицы
(old/new) физически не масштабировались бы за N=4 (>80 колонок) —
metric-major long table и есть единственное решение, читаемое построчно.

**Stability** (`renderStability`, вложена в конец Primary metrics): одна
строка на КАЖДЫЙ вариант (было — 2 строки, old/new), например (реальные
строки из успешного трёхвариантного прогона):
```md
- **baseline***: успешность 3/3 (100%); ранг 4 ×3
- **graphify**: успешность 3/3 (100%); ранг 4 ×3
```
или, при нестабильности (иллюстративно — `нестабильно:`/`verify:` из
`src/report/md.ts`): `- **graphify**: успешность 2/3 (67%); ранг 4 ×2, ранг
0 ×1; нестабильно: Wall-clock (2.1×); verify: 2/3 пройдено`.

**Phase split (init vs task)** (`renderPhaseSplit`, только если хотя бы один
вариант несёт `phaseSplit`): та же metric-major раскладка для 5
расщепляемых метрик, отдельно task-таблица и init cost (init-таблица
показывает полноценную дельту только когда `initDeltas` присутствует у пары
(baseline, вариант) — иначе medaan/[min–max] без дельты, никогда не
подставляется вычтенное значение у стороны без init); строки pack-setup (
только wall-clock) и предупреждение про `runsWithLostInit` — по каждому
варианту, у которого они есть.

**Harness preparation** (`renderHarnessPrep`): один блок на каждый пак
(баннер по режиму `PackPrep.mode`), таблица evidence с колонкой `Пакет`
добавленной к прежним `Вариант`/`Запуск`. `Шаг` (`setup`/`check`/`exercise`)
и единицы `Wall-clock` остаются английскими техническими терминами —
переведены только заголовки колонок и обрамляющая проза, не сами
шаг-идентификаторы:
```md
| Шаг | Пакет | Вариант | Запуск | Результат | Wall-clock | Хеш артефакта |
|---|---|---|---|---|---|---|
| setup | graphify | graphify | — | ✓ | 12000ms | — |
| check | graphify | graphify | 1 | ✓ | 300ms | — |
| check | graphify | baseline | 1 | ✓ | 150ms | — |   <- ✓ здесь значит "корректно отсутствует"
| exercise | — | graphify | 1 | ✓ | 8000ms | ab12cd34ef56 |
```
`cmdStatus` решает «declared-vs-foreign» вместо «new-vs-old» (имена
переменных/кода остаются английскими — переводится только рендер).

**Pack signal** (`renderPackSignal`): вложено по варианту, по паку. Когда
использование пакета видно для его типа, например:
```md
- **graphify** (вариант graphify): 3 вызова, 0 ошибок, 3/3 запусков вызвали пакет
- **graphify** (вариант baseline): 0 вызовов — чужой; любой вызов означал бы контаминация
```
Когда не видно — реальная строка из успешного трёхвариантного прогона
(README «N-way пример»): graphify — MCP/CLI-пак, вызванный из `exercise`,
а не через инструмент, который агентские tool-calls фиксируют напрямую, так
что `canDetect = false` для его типа доставки, и рендерится:
```md
- **graphify** (вариант graphify): _использование пакета не видно для этого типа пакета_
```
Строки с нулевым **чужим** сигналом молчат (дублировали бы секцию
Contamination) — ненулевое там уже сигнал сам по себе.

**Safety** (`renderSafety`, заголовок `## Безопасность`): таблица опасных
bash-команд по всем вариантам, реальный заголовок `| Вариант | Запуск |
Команда | Завершено | Выход |`; отсутствует, если списки пусты во всех
вариантах.

**Contamination** (`renderContamination`, заголовок `## Контаминация`,
новая секция относительно v1): таблица с реальным заголовком `| Тип |
Вариант | Пакет | Запуск | Детали |`; alert-баннер в Summary называет
затронутые варианты. Была невозможна в v1 — там contamination проверялась
только для одной стороны против одного `--pack`.

**Secondary metrics** (`renderSecondary`, заголовок `## Дополнительные
метрики`, подраздел `### <вариант>: дополнительные метрики`): без изменений
семантики полей, теперь по варианту (не по стороне) — 4 именованных блока
на каждый вариант, реальные заголовки: **Поведение** / **Задержки** /
**Токены и контекст** / **Объём вывода**.

**Failed runs** (`renderFailures`): таблица `(Вариант, Запуск, Код,
Сообщение)` — колонка `Side` переименована в `Вариант`; строки со всех
вариантов вперемешку (`summary.failures` — плоский список, каждая запись уже
несёт `variant`).

**LLM Judge** (`renderJudge`, N-way, заголовок секции — `## LLM-судья`):
```md
## LLM-судья
- Вердикт: **ok**
- Ранжирование: graphify > base > ast-grep
- Качество: base=6, graphify=8, ast-grep=5
- Модель: `ollama/qwen3.5:9b`
- Объяснение: ...
```
Плюс `_Баллы получены через попарные вызовы каждого варианта против
базового варианта (промпт превысил бюджет одного вызова)._`, когда
`judge.pairwiseFallback === true`. `judge.ran === false` → `_Судья не был
запущен: <explanation>_` без блока вердикт/качество, как раньше;
`judge === undefined` (`--judge` не задан) → `_Судья не запрошен (--judge
не задан)_`.

**Timeline summary** (`renderTimeline`, заголовок `## Сводка по
таймлайну`): топ-N долгих событий по всем lane'ам, без изменений
относительно v1 кроме языка.

**Diff summary** (`renderDiff`, заголовок `## Сводка по diff`): существующие
ссылки на патчи + tokens-per-line/cost-per-file + per-file overlap. Overlap
раньше был `both/only-old/only-new`; теперь на каждый не-baseline вариант —
реальный формат рендерера:
```md
- **Пересечение с базой (graphify)**
  - Общие: src/app.ts, src/util.ts
  - Только база: _нет_
  - Только graphify: src/graphify-notes.md
```
(пары «этот вариант против baseline», не N×N).

## 4. Шаги алгоритма

1. Прочитать `runInput.formats`. Непустое подмножество `{md, html, json,
   yaml}` — гарантировано фазой 00.
2. Собрать `report.md` секциями из §3 выше (`joinBlocks` с разделителем
   `\n\n---\n\n`, пустые секции отфильтровываются перед join).
3. Печать `report.md` в **stdout** (`stdoutFormat = "md"` по умолчанию) +
   запись в `results/report.md`.
4. **report.json** — canonical: сериализация `Report { schemaVersion: 2,
   manifest, metrics, timeline, diffs, judge?, summary, prep? }` (было
   `metricsDiff`/`diff`/без `prep`). Запись в `results/report.json`.
5. Если `"yaml" ∈ formats`: та же структура в `results/report.yaml`.
6. Если `"html" ∈ formats`: рендер `results/report.html` — те же секции
   1:1 с md (`src/report/html.ts`), metric-major таблицы, `.baseline-row`
   фон вместо прежних `.old`/`.new` CSS-классов; per-variant `<details>` для
   Secondary (первый открыт).
7. `ENOSPC` на любой записи → `E_DISK_FULL`. `Report` не проходит
   `reportSchema` перед сериализацией → `E_EXPORT_INVALID`.
8. Вернуть `ReportRenderResult { formats, paths, stdoutFormat }`.

## 5. Входные/выходные файлы

| Файл                       | Чтение/Запись | Схема (TypeSpec/Zod) |
| -------------------------- | ------------- | -------------------- |
| `results/metrics.json`     | Чтение        | `MetricsReport`      |
| `diff/<variant>/run-N/summary.json` | Чтение | `DiffSummary`        |
| `results/judge.json`       | Чтение        | `JudgeResult`        |
| `results/prep.json`        | Чтение (opt)  | `PrepReport`         |
| `results/timeline.html`    | Чтение (html) | HTML                 |
| `results/report.md`        | Запись        | Markdown             |
| `results/report.json`      | Запись        | canonical report (v2) |
| `results/report.yaml`      | Запись (opt)  | YAML                 |
| `results/report.html`      | Запись (opt)  | self-contained HTML  |

## 6. Edge-cases и ошибки

| Кейс                                                | Поведение                                          | Код                  |
| --------------------------------------------------- | -------------------------------------------------- | -------------------- |
| `formats = ["md"]` (default)                        | пишем только `report.md` + `report.json`           | —                    |
| `formats = ["all"]`                                 | раскрыто в фазе 00 → все 4 формата                 | —                    |
| `summary.failures` пустой                           | секция Failed runs не показывается                 | —                    |
| `judge === undefined`                               | секция LLM-судья не показывается                   | —                    |
| `judge.verdict = "unclear"`                          | секция показывается с пометкой unclear             | —                    |
| `metrics.allFailed = true`                           | баннер «All variants failed», в таблицах Δ — «—»   | —                    |
| `deltas[i].pairIncomplete = true` (не все failed)    | предупреждение в Summary именно на этот вариант    | —                    |
| `deltas.length > 1` (3+ варианта)                    | primary-таблица получает multiple-comparisons сноску | —                  |
| Нет места писать отчёт                              | fail                                               | `E_DISK_FULL`        |
| Собранный `Report` не проходит `reportSchema`       | fail (до записи файла)                             | `E_EXPORT_INVALID`   |
| `timeline.html` отсутствует (фаза 10 упала)         | `report.html` без timeline-блока, warning          | —                    |
| Prompt/Init/Hint совпадают у всех вариантов          | disclosure-строка не печатается (нечего раскрывать) | —                   |
| Prompt/Init/Hint расходятся между вариантами         | disclosure-строка группирует варианты по источнику  | —                   |
| `packUses` нет ни на одном варианте                  | секция Pack signal отсутствует                     | —                    |
| Contamination-сигналов нет ни на одном варианте      | секция Contamination отсутствует, alert в Summary не печатается | —      |
| Старый `report.json` (v1, без waves 1+2 полей)       | читается через compat-слой, рендерится как v1-совместимый вид (2 варианта `old`/`new`) | — |

## 7. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path md, legacy-шим: `formats = ["md"]` → `report.md` в stdout и
  файле, primary-таблица показывает 2 варианта (baseline + один), без
  multiple-comparisons сноски (`deltas.length === 1`).
- ✅ N-way golden: 3-вариантный `Report` → primary-таблица metric-major с
  baseline-строкой первой в каждой группе метрики, `### vs база: <variant>`
  дважды (по каждому не-baseline варианту), multiple-comparisons сноска
  присутствует.
- ✅ md with failed runs / without / with judge / judge missing / judge
  unclear / allFailed — как раньше, атрибутировано вариантами.
- ✅ pairIncomplete warning: один не-baseline вариант с 0 успешными
  прогонами (не все варианты failed) → отдельное предупреждение именно на
  него, `allFailed`-баннер не печатается.
- ✅ json canonical / yaml output / html output / formats all / disk full /
  invalid report schema — без изменений поведения, новых полей.
- ✅ Contamination-секция: сигнал на варианте a против чужого пака b →
  секция присутствует, alert в Summary называет `a`.
- ✅ Contamination-секция отсутствует: сигналов нет ни у одного варианта.
- ✅ header disclosure: у одного варианта свой `hint`, у остальных —
  унаследованный глобальный → строка Hint группирует их раздельно; все
  варианты с идентичным эффективным hint → строка не печатается.
- ✅ primary table [min–max]/IQR / stability block / pack section / safety
  section / secondary / diff section / header version-drift warning —
  сохранены семантически, атрибутированы вариантами вместо сторон.
- ✅ backcompat: `Report`-фикстура v1 (через compat-слой) рендерится без
  исключений, как обычный 2-вариантный отчёт `old`/`new`.
- ✅ real incident fixture: golden-фикстура из реальной sample-workspace
  (N=3) одновременно показывает Safety, Pack signal, Contamination,
  multiple-comparisons сноску, per-variant Stability и judge ranking.

## 8. Инварианты

- После фазы `results/report.md` и `results/report.json` существуют
  **всегда**.
- `report.md` напечатан в stdout (`stdoutFormat = "md"` по умолчанию).
- `report.json` содержит полный `MetricsReport` + метаданные — достаточен
  для повторного рендера в любой формат без повторного прогона.
- Знаки в таблице дельт согласованы с `MetricDelta.significant`/`better`:
  ✓ только при `better = "better"`, ⚠ при `significant` и `better =
  "worse"`, — в остальных случаях.
- Каждая metric-major таблица несёт ровно `metrics.variants.length` строк на
  метрику (одна на вариант, baseline первая в группе).
- `summary.perVariant.length === metrics.deltas.length` (N−1, порядок
  конфига минус baseline).
- Секции Contamination/Pack signal/Safety/Failed runs/LLM Judge появляются
  только когда для них есть данные.
- `summary.basis` согласован с тем, что реально питает заголовок и бакеты:
  `"task"` ⇔ хотя бы одна пара несёт `taskDeltas`; при расхождении между
  парами заголовок явно раскрывает смешанный базис.

## 9. Зависимости от других фаз

- Зависит от: **07 aggregate** (`MetricsReport`), **08 diff**
  (`DiffResult[]`), **09 judge** (`JudgeResult`, опционально), **10
  timeline** (`Timeline` для `report.html`), опционально `results/prep.json`
  (сборка `cli/pipeline.ts` из фаз 04b/05/06).
- Блокирует: — (точка схода артефактов; review-workspace не имеет
  data-dependency).
- Параллелизуется с: **12 review-workspace**.
