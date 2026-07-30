# Фаза 10: timeline

> Спека фазы. Контракт = `contract/phases/10-timeline.tsp`. Реализация —
> TypeScript strict + Effect-TS. Покрытие тестами ≥80%.

## 1. Назначение

Построить таймлайн событий агента из `raw/<side>/run-N.json` — плоский
`timeline.json` (events[]) и self-contained `timeline.html` (vanilla JS, без
сервера). v0.1: линейный таймлайн по root-сессии. v0.2: swimlane по дереву
сессий через `parent_id`.

## 2. Контракт (TypeSpec)

Namespace: `TestAiPack.TimelineBuild` (см. `contract/phases/10-timeline.tsp`).
Внимание: namespace назван `TimelineBuild`, а не `Timeline`, чтобы избежать
коллизии с общим типом `Timeline` из `contract/main.tsp`.

- Вход: `TimelineInput` — `{ runInput: RunInput, manifest: Manifest, workspace:
  WorkspaceTree, sideResults: { old: RunSideResult[]; new: RunSideResult[] } }`.
  Параметры `collapseRepeats` и `timelineMode` берутся из `runInput`.
- Выход: `TimelineResult` — `{ timeline: Timeline, jsonPath: string, htmlPath?:
  string }`. Общий тип `Timeline = { old: TimelineEvent[], new: TimelineEvent[],
  mode: TimelineMode }`. `TimelineMode ∈ { "side-by-side", "tree-diff",
  "merged" }`.
- Ошибки: `@error TimelineError` — `{ code, message, side?: Side, runIndex?:
  int32, context? }`, где `code` принимает только одно значение:
  - `E_EXPORT_INVALID` — только для внутренних сбоев самой фазы (собранный
    `Timeline` не проходит свою же схему, запись `timeline.json`/`.html`
    упала). **Не** для чтения одного `raw/<side>/run-N.json` — отсутствующий
    или повреждённый export одного прогона не фейлит фазу, см. §3.1 и §5.

  Неизвестный `mode` или невозможность построить `merged` здесь не выделены в
  отдельный код (контракт 10 имеет только `E_EXPORT_INVALID`); `mode` уже
  отвалидирован в фазе 00 (`runInput.timelineMode: TimelineMode`), а
  рассинхрон `merged` детализируется в `message` под тем же кодом.

`TimelineEvent`:
```jsonc
{
  "tStart": "1234",              // int64, ms от старта run (int64 на wire — строка)
  "tEnd":   "1500",
  "side":   "old" | "new",
  "runIndex": 1,
  "sessionId": "...",            // root или дочерняя
  "parentSessionId": "..." | null,  // v0.2 — привязка swimlane к родительской сессии
  "swimlaneDepth": 0,            // int32 — глубина в дереве сессий
  "type":   "reasoning" | "tool-call" | "tool-result" | "step-finish" | "text",
  "tool":   "Read" | "Bash" | ... | null,
  "tokens": 12345 | null,        // int32
  "status": "pending" | "running" | "completed" | "error" | null
}
```

## 3. Шаги алгоритма

1. Для каждой пары `(side, n)` прочитать `raw/<side>/run-N.json`. Отсутствующий
   файл **и** файл, не парсящийся как JSON или не проходящий схему
   `OpencodeExport`, обрабатываются одинаково: этот run не вносит events
   (`[]`), в консоль идёт `console.warn`, фаза продолжает остальные прогоны —
   не throw. (Контейнмент фазы 06 может оставить на диске ровно такой
   невалидный export для проваленного прогона; ужесточать здесь было бы
   излишним, раз 06 уже разрешила это как валидный исход.)
2. **v0.1 (linear):** извлечь `parts[]` из root-сессии, нормализовать каждый
   part в `TimelineEvent` (`type: TimelineEventType`):
   - `"reasoning"` для reasoning parts → `tStart/tEnd` из part timing.
   - `"tool-call"` для tool-call parts → `tool` = tool name.
   - `"tool-result"` для соответствующих ответов.
   - `"step-finish"` для завершающих parts.
   - `"text"` для текстовых parts.
   - timestamps относительно `min(time_created)` run-а.
3. **v0.2 (swimlane):** рекурсивный обход дерева сессий:
   a. Найти root-сессию (`parent_id = null`).
   b. Для каждой сессии query к opencode db: `opencode db "SELECT id FROM
      session WHERE parent_id = '<id>'" --format json` (SQL — прямой
      позиционный аргумент `db`, подкоманды `query` у opencode нет).
      `<id>` — id родительской сессии; перед интерполяцией в SQL-строку он
      проверяется по `/^[A-Za-z0-9_-]+$/` (реальные id opencode таковы), а
      несовпадающий id трактуется как «нет детей» (без реального запроса к
      БД), а не интерполируется как есть.
   c. Visited-set защищает от циклов по `parent_id`.
   d. Каждая дочерняя сессия = отдельная swimlane; `parentSessionId`
      привязывает её к родительской сессии вертикальной пунктирной линией
      (задаётся в `timeline.html` рендером). `swimlaneDepth` растёт с глубиной.
   e. Число swimlane определяется числом уникальных `sessionId` в деревьях
      всех run-ов (выводится из `TimelineEvent[]` на стороне рендера).
4. `runInput.collapseRepeats`: если `true`, сжать подряд идущие события
   строго `type = "tool-call"` (не `tool-result`!) с одним и тем же `tool`,
   `side`, `runIndex` и `sessionId` в одно событие: `tStart` — от первого,
   `tEnd` — max по всем, `tokens` — сумма. Никакой отдельной метки/счётчика
   повторов в событии нет — просто один более длинный `tool-call`.
   `tool-result` в это схлопывание никогда не попадает (и с ним не
   схлопывается), поэтому статус `error` на результате всегда виден.
   Полезно против doom-loop визуализации.
5. Нормализовать все events в два плоских массива `Timeline.old[]` и
   `Timeline.new[]` с метаданными `(side, runIndex)`. `Timeline.mode` =
   `runInput.timelineMode`.
6. Сериализовать `Timeline` в `results/timeline.json`.
7. Сгенерировать `results/timeline.html` — self-contained файл (inline CSS +
   inline vanilla JS, без внешних CDN и без сервера). Режимы отображения
   (`Timeline.mode`):
   - `"side-by-side"` (default): old слева, new справа, общая ось времени.
   - `"tree-diff"` (v0.2): swimlane-ы old и new друг под другом с подсветкой
     различий в структуре дерева.
   - `"merged"`: все events на одной оси, цвет = side.
8. Вернуть `TimelineResult { timeline, jsonPath, htmlPath? }`.

## 4. Входные/выходные файлы

| Файл                          | Чтение/Запись | Схема (TypeSpec/Zod) |
| ----------------------------- | ------------- | -------------------- |
| `raw/<side>/run-<n>.json`     | Чтение        | `OpencodeExport`     |
| `results/timeline.json`       | Запись        | `Timeline`           |
| `results/timeline.html`       | Запись        | self-contained HTML  |

## 5. Edge-cases и ошибки

| Кейс                                                | Поведение                                          | Код                  |
| --------------------------------------------------- | -------------------------------------------------- | -------------------- |
| `raw/<side>/run-N.json` повреждён (не JSON / не по схеме) | пропускаем этот run в timeline (events = []), warning | —              |
| Прогон failed (нет export)                          | пропускаем этот run в timeline, warning            | —                    |
| root session без parts                             | events = [], не fail                               | —                    |
| Цикл по parent_id (v0.2)                            | visited-set обрывает, warning                      | —                    |
| Очень глубокое дерево (v0.2, >50 сессий)            | ограничение глубины 50, warning                    | —                    |
| `runInput.collapseRepeats = true`, повторов нет     | ничего не сжимается, просто идёт по ordinary path  | —                    |
| `runInput.collapseRepeats = true`, 20 одинаковых `tool-call` Read подряд | схлопываются в один `tool-call` (без метки счётчика) | —          |
| `runInput.collapseRepeats = true`, `tool-call` + его `tool-result` | НЕ схлопываются (разный `type`)            | —                    |
| id родительской сессии не проходит `/^[A-Za-z0-9_-]+$/` (v0.2) | трактуется как «нет детей», запрос к БД не идёт | —              |
| `runInput.timelineMode` неизвестен                  | клирится в фазе 00 (enum `TimelineMode`)           | — (через 00)         |
| `merged` при рассинхроне (N=1 vs N=2)               | throw с детальным `message`                        | `E_EXPORT_INVALID`   |
| HTML > 5MB (огромный run)                           | пишем как есть, warning                            | —                    |

## 6. Тест-кейсы (по одному на ветку контракта)

- ✅ happy-path v0.1: два прогона по 10 events → `Timeline.old[]` и
  `Timeline.new[]` содержат по 10 records, `timeline.html` существует,
  валидный HTML.
- ✅ event types: проверяем что `reasoning`/`tool-call`/`tool-result`/
  `step-finish`/`text` все представлены в events.
- ✅ timestamps relative: все `tStart ≥ 0`, `tEnd ≥ tStart`, минимум = 0.
- ✅ collapse-repeats: 5 одинаковых `tool-call` Bash подряд → один event
  (без метки счётчика повторов — такого поля не существует).
- ✅ collapse-repeats off: те же 5 Bash → 5 отдельных events.
- ✅ collapse-repeats не трогает tool-result: `tool-call` + его `tool-result`
  (тот же tool) не схлопываются; `status: "error"` на `tool-result` не
  теряется.
- ✅ id родительской сессии с недопустимыми символами (v0.2) → не доходит до
  `dbQuery`, дерево трактуется как «нет детей» для этого узла.
- ✅ side-by-side: HTML содержит две колонки с подписями OLD/NEW.
- ✅ merged mode: HTML содержит одну ось, цвета различают side.
- ✅ v0.2 swimlane: дерево из 3 сессий → 3 уникальных `sessionId` в
  `TimelineEvent[]`, дочерние сессии привязаны через `parentSessionId`,
  `swimlaneDepth` растёт с глубиной.
- ✅ cycle in parent_id: зацикленный `parent_id` → visited-set обрывает,
  warning, не падает.
- ✅ invalid export: повреждённый JSON (или прошедший JSON.parse, но не по
  схеме `OpencodeExport`) → этот run вносит 0 events, фаза не падает, events
  других прогонов присутствуют.
- ✅ empty parts: root session без parts → соответствующий массив events
  пуст, не fail.
- ❌ НЕ покрыто (ticket): рендер tree-diff с >20 swimlane (производительность
  DOM) — ticket про v0.2.1.
- ❌ НЕ покрыто (ticket): интерактивный zoom по timeline (canvas вместо DOM)
  — ticket про v0.3.

## 7. Инварианты

- После фазы `results/timeline.json` существует и содержит `Timeline`
  (`{ old: TimelineEvent[], new: TimelineEvent[], mode: TimelineMode }`).
- `timeline.html` — self-contained: открывается в браузере file://, нет
  внешних запросов.
- Все events имеют корректные `(side, runIndex)`, однозначно сопоставимые с
  `raw/<side>/run-N.json`.
- timestamps нормализованы относительно старта своего run-а (`min = 0`).
- Число уникальных `sessionId` в `TimelineEvent[]` (v0.2) определяет количество
  swimlane на стороне рендера.
- `runInput.collapseRepeats` не теряет информацию: суммарные токены и интервал
  сохранены в сжатом event-е; событие остаётся `type: "tool-call"` — соседний
  `tool-result` в схлопывание не попадает, его `status` (в т.ч. `"error"`)
  всегда доходит до рендера.

## 8. Зависимости от других фаз

- Зависит от: **06 run-side** (`sideResults: RunSideResult[]` + массив
  `raw/<side>/run-N.json`), **00 cli-parse** (`runInput.collapseRepeats`,
  `runInput.timelineMode`).
- Блокирует: **11 report-render** (`report.html` встраивает `timeline.html`
  как iframe/inline блок).
- Параллелизуется с: **07 aggregate** (обе читают `raw/<side>/run-N.json`),
  **08 diff**, **09 judge** (после завершения diff). На практике стартует
  после всех трёх, потому что report-render ждёт и metrics, и timeline.
