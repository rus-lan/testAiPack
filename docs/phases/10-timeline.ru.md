# Фаза 10: timeline

> Спека фазы. Контракт = `contract/phases/10-timeline.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Построить таймлайн событий агента из `raw/<variant>/run-N.json` для **каждого
варианта** — плоский `timeline.json` (`lanes: VariantTimeline[]`) и
self-contained `timeline.html` (vanilla JS, без сервера). Линейный таймлайн по
root-сессии либо swimlane по дереву сессий через `parent_id` (в зависимости от
режима, см. §7).

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.TimelineBuild` (см. `contract/phases/10-timeline.tsp`).
Внимание: namespace назван `TimelineBuild`, а не `Timeline`, чтобы избежать
коллизии с общим типом `Timeline` из `contract/main.tsp`.

- Вход: `TimelineInput` — `{ runInput: RunInput, manifest: Manifest, workspace:
  WorkspaceTree, results: VariantRunResults[] }` (было `sideResults: { old,
  new }`). Параметры `collapseRepeats` и `timelineMode` берутся из `runInput`.
- Выход: `TimelineResult` — `{ timeline: Timeline, jsonPath: string, htmlPath?:
  string }`. Общий тип `Timeline = { lanes: VariantTimeline[], mode:
  TimelineMode }` (было `{ old: TimelineEvent[], new: TimelineEvent[], mode }`).
  `VariantTimeline = { variant: string, events: TimelineEvent[] }` — одна
  запись **на каждый вариант**, в порядке конфига. `TimelineMode ∈ {
  "side-by-side", "tree-diff", "merged" }`.
- Ошибки: `@error TimelineError` — `{ code, message, variant?: string,
  runIndex?: int32, context? }`, где `code` принимает только одно значение:
  - `E_EXPORT_INVALID` — только для внутренних сбоев самой фазы (собранный
    `Timeline` не проходит свою же схему, запись `timeline.json`/`.html`
    упала). **Не** для чтения одного `raw/<variant>/run-N.json` — отсутствующий
    или повреждённый export одного прогона не фейлит фазу, см. §3 и §5.

`TimelineEvent`:
```jsonc
{
  "tStart": "1234",              // int64, ms от старта run (int64 на wire — строка)
  "tEnd":   "1500",
  "variant": "old" | "graphify" | ...,   // было "side": "old" | "new"
  "runIndex": 1,
  "sessionId": "...",            // root или дочерняя
  "parentSessionId": "..." | null,  // привязка swimlane к родительской сессии
  "swimlaneDepth": 0,            // int32 — глубина в дереве сессий
  "type":   "reasoning" | "tool-call" | "tool-result" | "step-finish" | "text",
  "tool":   "Read" | "Bash" | ... | null,
  "tokens": 12345 | null,        // int32
  "status": "pending" | "running" | "completed" | "error" | null
}
```

## 3. Шаги алгоритма

1. Для каждой пары `(variant, n)` прочитать `raw/<variant>/run-N.json`.
   Отсутствующий файл **и** файл, не парсящийся как JSON или не проходящий
   схему `OpencodeExport`, обрабатываются одинаково: этот run не вносит events
   (`[]`), в консоль идёт `console.warn`, фаза продолжает остальные прогоны и
   варианты — не throw.
2. **Линейный режим:** извлечь `parts[]` из root-сессии, нормализовать каждый
   part в `TimelineEvent` (`type: TimelineEventType`): `"reasoning"`,
   `"tool-call"`, `"tool-result"`, `"step-finish"`, `"text"`. Timestamps
   относительно `min(time_created)` run-а.
3. **Swimlane-режим:** рекурсивный обход дерева сессий (глубина ограничена
   `MAX_TREE_DEPTH = 10`):
   a. Найти root-сессию (`parent_id = null`).
   b. Для каждой сессии query к opencode db: `opencode db "SELECT id FROM
      session WHERE parent_id = '<id>'" --format json`. `<id>` перед
      интерполяцией проверяется по `/^[A-Za-z0-9_-]+$/` (`SESSION_ID_PATTERN`);
      несовпадающий id трактуется как «нет детей», без реального запроса к БД.
   c. Visited-set защищает от циклов по `parent_id`.
   d. Каждая дочерняя сессия = отдельная swimlane; `parentSessionId`
      привязывает её к родительской сессии вертикальной пунктирной линией.
      `swimlaneDepth` растёт с глубиной.
4. `runInput.collapseRepeats`: если `true`, сжать подряд идущие события
   строго `type = "tool-call"` (не `tool-result`!) с одним и тем же `tool`,
   `variant`, `runIndex` и `sessionId` в одно событие: `tStart` — от первого,
   `tEnd` — max по всем, `tokens` — сумма. `tool-result` в схлопывание никогда
   не попадает, поэтому статус `error` на результате всегда виден.
5. Нормализовать все events в `Timeline.lanes: VariantTimeline[]` — по одной
   записи на каждый вариант эксперимента, в порядке `runInput.variants`.
   `Timeline.mode` = `runInput.timelineMode`.
6. Сериализовать `Timeline` в `results/timeline.json`.
7. Сгенерировать `results/timeline.html` — self-contained файл. Режимы
   отображения (`Timeline.mode`) — см. §7.
8. Вернуть `TimelineResult { timeline, jsonPath, htmlPath? }`.

## 4. Входные/выходные файлы

| Файл                          | Чтение/Запись | Схема (TypeSpec/Zod) |
| ----------------------------- | ------------- | -------------------- |
| `raw/<variant>/run-<n>.json`  | Чтение        | `OpencodeExport`     |
| `results/timeline.json`       | Запись        | `Timeline`           |
| `results/timeline.html`       | Запись        | self-contained HTML  |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                          | Код                  |
| --------------------------------------------------- | -------------------------------------------------- | -------------------- |
| `raw/<variant>/run-N.json` повреждён (не JSON / не по схеме) | пропускаем этот run в timeline (events = []), warning | —              |
| Прогон failed (нет export)                          | пропускаем этот run в timeline, warning            | —                    |
| root session без parts                             | events = [], не fail                               | —                    |
| Цикл по parent_id (swimlane-режим)                  | visited-set обрывает, warning                      | —                    |
| Очень глубокое дерево (>10 сессий)                  | ограничение глубины `MAX_TREE_DEPTH = 10`, warning | —                    |
| `runInput.collapseRepeats = true`, повторов нет     | ничего не сжимается                                | —                    |
| `runInput.collapseRepeats = true`, N одинаковых `tool-call` подряд | схлопываются в один `tool-call`     | —                    |
| `runInput.collapseRepeats = true`, `tool-call` + его `tool-result` | НЕ схлопываются (разный `type`)      | —                    |
| id родительской сессии не проходит `/^[A-Za-z0-9_-]+$/` | трактуется как «нет детей», запрос к БД не идёт | —                    |
| `runInput.timelineMode` неизвестен                  | клирится в фазе 00 (enum `TimelineMode`)           | — (через 00)         |
| Единственный вариант в `tl.lanes` (N=1, tree-diff)  | tree-diff деградирует до side-by-side (нечего диффить) | —                |
| `merged` при рассинхроне числа лент                 | throw с детальным `message`                        | `E_EXPORT_INVALID`   |
| N вариантов (N > 2)                                 | `lanes.length === N`, палитра растёт по индексу, без хардкода на 2 | — |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path linear, legacy-шим: два варианта по 10 events →
  `Timeline.lanes` содержит 2 записи по 10 records, `timeline.html`
  существует, валидный HTML.
- ✅ N-way: 3 варианта → `lanes.length === 3`, каждая лента атрибутирована
  `variant`.
- ✅ event types / timestamps relative / collapse-repeats (on/off/не трогает
  tool-result) — без изменений семантики.
- ✅ id родительской сессии с недопустимыми символами → не доходит до
  `dbQuery`, дерево трактуется как «нет детей».
- ✅ side-by-side: HTML содержит по одному блоку `.side` на каждый вариант с
  подписью его имени.
- ✅ merged mode: HTML содержит одну ось, цвет = индекс варианта (chips на
  каждый вариант в легенде).
- ✅ tree-diff, N=3: baseline-лента outline'ится красным там, где ключ
  события отсутствует у ВСЕХ остальных лент (`flag: 'baseline-only'`);
  каждая не-baseline лента outline'ится зелёным там, где ключ отсутствует у
  baseline (`flag: 'vs-baseline'`) — без N×N сравнения (каждая не-baseline
  лента сравнивается только с baseline, baseline — с объединением остальных).
- ✅ tree-diff, N=1 (единственный вариант — сам baseline): деградирует до
  side-by-side, не считает «отсутствует у всех остальных» ошибочно.
- ✅ swimlane: дерево из 3 сессий → 3 уникальных `sessionId` в events лент,
  дочерние сессии привязаны через `parentSessionId`, `swimlaneDepth` растёт с
  глубиной.
- ✅ cycle in parent_id: зацикленный `parent_id` → visited-set обрывает,
  warning, не падает.
- ✅ invalid export / empty parts — без изменений семантики.
- ✅ палитра: цвет baseline-ленты всегда первый в палитре (`#fafafa`);
  не-baseline ленты — по порядковому номеру СРЕДИ НЕ-BASELINE лент (не по
  абсолютному индексу в `lanes`), так что перестановка порядка вариантов в
  конфиге (кроме самого baseline) не меняет цвет baseline-ленты.
- ❌ НЕ покрыто (ticket): рендер tree-diff с >20 лент (производительность
  DOM).
- ❌ НЕ покрыто (ticket): интерактивный zoom по timeline (canvas вместо DOM).

## 7. Режимы отображения (`Timeline.mode`)

- **`side-by-side`** (default): по одному вертикальному блоку `.side` на
  каждый вариант (не только 2), общая ось времени, blocks идут в порядке
  `Timeline.lanes` (порядок конфига).
- **`tree-diff`** (решение D14, `.research/n-way-variants/00-overview.md
  §5`): swimlane-ы каждого варианта друг под другом; ключ события
  (`eventDiffKey` — не сырой timestamp, а содержательная сигнатура события)
  сравнивается по правилу: у каждой НЕ-baseline ленты событие outline'ится
  «зелёным» (`vs-baseline`), если его ключ отсутствует в множестве ключей
  baseline-ленты; у baseline-ленты событие outline'ится «красным»
  (`baseline-only`), если его ключа НЕТ ни в одной из остальных лент
  (объединение). Обобщает старую двустороннюю outline-логику без N×N
  сравнения — каждая не-baseline лента сравнивается только с baseline, а
  baseline — с объединением всех остальных, один проход.
- **`merged`**: все события всех вариантов на одной оси, отсортированы по
  `tStart`; цветовые чипы легенды показывают палитру каждого варианта
  (`renderPaletteChips`), имя baseline-варианта помечено `(baseline)`.

CSS-класс раньше был `.side.old`/`.side.new` (два хардкод-имени); теперь
`.side[data-vi="k"]` — атрибут-индекс варианта в `lanes`, палитра
эмитится динамически по числу лент (`renderLaneCss`).

## 8. Инварианты

- После фазы `results/timeline.json` существует и содержит `Timeline`
  (`{ lanes: VariantTimeline[], mode: TimelineMode }`), `lanes.length ===
  runInput.variants.length`.
- `timeline.html` — self-contained: открывается в браузере file://, нет
  внешних запросов.
- Все events имеют корректные `(variant, runIndex)`, однозначно сопоставимые
  с `raw/<variant>/run-N.json`.
- timestamps нормализованы относительно старта своего run-а (`min = 0`).
- `runInput.collapseRepeats` не теряет информацию: суммарные токены и интервал
  сохранены в сжатом event-е; событие остаётся `type: "tool-call"` — соседний
  `tool-result` в схлопывание не попадает, его `status` (в т.ч. `"error"`)
  всегда доходит до рендера.
- Палитра детерминирована: baseline всегда первый цвет; остальные варианты —
  по порядку среди себя, не зависят от позиции baseline в конфиге.

## 9. Зависимости от других фаз

- Зависит от: **06 run-side** (`results: VariantRunResults[]` + массив
  `raw/<variant>/run-N.json`), **00 cli-parse** (`runInput.collapseRepeats`,
  `runInput.timelineMode`, `runInput.baseline` для tree-diff/merged-чипов).
- Блокирует: **11 report-render** (`report.html` встраивает `timeline.html`
  как iframe/inline блок).
- Параллелизуется с: **07 aggregate** (обе читают `raw/<variant>/run-N.json`),
  **08 diff**, **09 judge**. На практике стартует после всех трёх, потому что
  report-render ждёт и metrics, и timeline.
