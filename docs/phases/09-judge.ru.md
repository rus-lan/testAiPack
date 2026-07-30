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
3. Собрать промпт судьи:
   - системный/первый блок: контекст задачи (`manifest.prompt`,
     `manifest.init`, `manifest.verify`).
   - второй блок: `runInput.judge` (то, что пользователь передал через
     `--judge`, возможно из `@file`).
   - третий блок: `<OLD_PATCH>...</OLD_PATCH>`.
   - четвёртый блок: `<NEW_PATCH>...</NEW_PATCH>`.
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
     модель и хвост stderr.
   - Иные сбои (таймаут/crash/429, не удалось создать scratch-директорию) —
     тоже **не** throw; `JudgeResult.verdict = "unclear"`, `ran = false`,
     `explanation` содержит описание сбоя (контракт 09 не выделяет для них
     кода). После этого шага в `computeJudge` не остаётся ни одной ветки
     `throw`/`Effect.fail` — фаза 09 гарантированно не абортит пайплайн.
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
   `modelUsed` и `timestamp`) и вернуть `JudgeResultOutput { judge: <result> }`.

## 4. Входные/выходные файлы

| Файл                              | Чтение/Запись | Схема (TypeSpec/Zod) |
| --------------------------------- | ------------- | -------------------- |
| `diff/<side>/run-<n>/full.patch`  | Чтение        | текст                |
| `results/judge.json`              | Запись        | `JudgeResult`        |
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
- ❌ НЕ покрыто (ticket): multi-run judge (оценка по всем N прогонам с
  усреднением) — ticket про v0.2.

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
