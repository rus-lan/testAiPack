# testaipack

**A/B-тестер для opencode-интеграций.** Сравнивает работу AI-агента до и после установки пакета (skill / plugin / agent / command / mcp): клонирует репозиторий, прогоняет один и тот же промпт на «чистой» и «патченной» стороне, собирает метрики (токены, время, стоимость, шаги) и рендерит сравнительный отчёт.

---

## Быстрый старт

```bash
# 1. Установить зависимости (корень + контракт)
npm install
npm --prefix contract install

# 2. Сгенерировать TS-типы и Zod-схемы из TypeSpec-контракта
npm run contract:codegen

# 3. Прогнать первый A/B (минимальный набор флагов)
./dist/testaipack run https://github.com/owner/repo \
  --pack git+https://github.com/me/my-skill \
  --prompt "реализуй фичу X по спецификации"

# 4. Открыть результат в VSCode (multi-root workspace)
./dist/testaipack review
```

`run` требует только `<repo>` и `--prompt`. Остальные флаги имеют дефолты (см. таблицу ниже). Первый прогон создаст `./.testaipack/` с деревом рабочих директорий и положит отчёт в `./.testaipack/<run-id>/report/`.

---

## Максимальный запуск

Полный пример со всеми осмысленными флагами:

```bash
./dist/testaipack run https://github.com/owner/repo \
  --pack git+https://github.com/me/my-skill \
  --pack-type skill \
  --prompt @prompts/build.md \
  --init @prompts/init.md \
  --verify "npm test && npm run lint" \
  --isolation home \
  --opencode-version 0.5.0 \
  --aws --ssh --git \
  --pure-baseline \
  --runs 5 \
  --judge @prompts/judge.md \
  --preflight-model anthropic/claude-3-5-haiku-20241022 \
  --format md html json \
  --output ./.testaipack/last/report \
  --collapse-repeats \
  --timeline-mode side-by-side \
  --timeout-run 900 \
  --timeout-verify 300 \
  --timeout-install 300 \
  --watchdog 90 \
  --workspace ./.testaipack \
  --review-run 1 \
  --ide vscode \
  --pricing ./pricing.json \
  --log-level info
```

---

## Таблица параметров команды `run`

| Флаг                       | Тип                                       | По умолчанию                  | Описание                                                                                                         |
| -------------------------- | ----------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `<repo>` (позиционный)     | `string`                                  | — (обязательный)              | URL git-репозитория для A/B прогона.                                                                             |
| `--pack <ref>`             | `string`                                  | —                             | Тестируемый пакет: git-URL, npm-pkg или локальный путь. Тип определяется автоматически.                          |
| `--pack-type <type>`       | `skill\|plugin\|agent\|command\|mcp\|all` | авто                          | Переопределить тип пакета вместо авто-детекции.                                                                  |
| `--prompt <text\|@file>`   | `string`                                  | — (обязательный)              | Промпт для агента на стороне сборки. `@file` читает содержимое файла.                                            |
| `--init <text\|@file>`     | `string`                                  | —                             | Опц. промпт, запускаемый ДО `--prompt` в той же сессии (подготовка окружения).                                   |
| `--verify <cmd>`           | `string`                                  | —                             | Опц. shell-команда после работы агента (например `npm test`). Учитывается в метриках успеха.                     |
| `--isolation <mode>`       | `home\|docker`                            | `home`                        | Режим изоляции. `docker` — цель v0.3.                                                                            |
| `--opencode-version <ver>` | `string`                                  | latest                        | Пин версии opencode для обеих сторон.                                                                            |
| `--aws`                    | флаг                                      | off                           | Добавить AWS-credentials (`~/.aws/`) в whitelist изоляции.                                                       |
| `--ssh`                    | флаг                                      | off                           | Добавить SSH-ключи (`~/.ssh/`) в whitelist.                                                                      |
| `--git`                    | флаг                                      | off                           | Добавить git-credentials (`~/.gitconfig`, credential helper) в whitelist.                                        |
| `--pure-baseline`          | флаг                                      | on                            | Запускать обе стороны в `--pure` режиме (без сторонних плагинов/скиллов, кроме тестируемого на «новой» стороне). |
| `--runs <N>`               | `int ≥ 1`                                 | `3`                           | Число прогонов на каждую сторону (усреднение по медиане).                                                        |
| `--judge <text\|@file>`    | `string`                                  | —                             | Промпт для LLM-судьи: оценит semantic diff между сторонами.                                                      |
| `--no-preflight`           | флаг                                      | off                           | Пропустить pre-flight стадию (пинг модели, проверка пакета).                                                     |
| `--preflight-model <m>`    | `string`                                  | из конфига                    | Модель для pre-flight ping.                                                                                      |
| `--format <f>...`          | `md\|html\|json\|yaml` (повторяется)      | `md`                          | Форматы отчёта. Несколько через пробел.                                                                          |
| `--output <path>`          | `string`                                  | `<workspace>/<run-id>/report` | Куда писать файлы отчёта.                                                                                        |
| `--no-diff-html`           | флаг                                      | off                           | Не генерировать HTML side-by-side diff.                                                                          |
| `--collapse-repeats`       | флаг                                      | off                           | Сжимать повторяющиеся tool-call последовательности в карте.                                                      |
| `--timeline-mode <m>`      | `side-by-side\|tree-diff\|merged`         | `side-by-side`                | Режим отображения таймлайна.                                                                                     |
| `--timeout-run <sec>`      | `int`                                     | `600`                         | Таймаут одного прогона агента (сек).                                                                             |
| `--timeout-verify <sec>`   | `int`                                     | `300`                         | Таймаут `--verify` команды (сек).                                                                                |
| `--timeout-install <sec>`  | `int`                                     | `300`                         | Таймаут установки пакета (сек).                                                                                  |
| `--watchdog <sec>`         | `int`                                     | `90`                          | Watchdog: прогон считается зависшим, если нет вывода столько секунд.                                             |
| `--workspace <path>`       | `string`                                  | `./.testaipack`               | Корень рабочего дерева testaipack.                                                                               |
| `--review-run <N>`         | `int`                                     | `1`                           | Какой прогон (по индексу) открыть в `review`.                                                                    |
| `--ide <editor>`           | `vscode\|cursor\|code-insiders`           | `vscode`                      | Редактор для команды `review`.                                                                                   |
| `--pricing <path>`         | `string`                                  | встроенный                    | Своё дерево цен (USD за 1M токенов).                                                                             |
| `--log-level <lvl>`        | `debug\|info\|warn\|error`                | `info`                        | Уровень логирования.                                                                                             |

---

## Другие команды

| Команда               | Описание                                                                |
| --------------------- | ----------------------------------------------------------------------- |
| `review [run-id]`     | Открыть multi-root VSCode workspace для прогона (old/new side-by-side). |
| `report [run-id]`     | Перерендерить отчёт по сохранённым данным прогона.                      |
| `compare <id1> <id2>` | Сравнить два прогона (v0.3, не реализовано).                          |
| `gc`                  | Очистка старых прогонов из рабочего дерева.                             |
| `list`                | Список всех прогонов в `<workspace>`.                                   |
| `init`                | Инициализировать `<workspace>/.testaipack/`.                            |
| `doctor`              | Проверить зависимости (opencode, git, bun, модель).                     |

---

## Архитектура

Пайплайн разбит на 14 фаз, каждая описана отдельным TypeSpec-контрактом и phase-документом. Полная схема — в [`docs/phases/README.ru.md`](docs/phases/README.ru.md).

```
00-cli-parse → 01-workspace-setup → 02-repo-clone → 03-pack-install
→ 04-home-isolation → 05-preflight → 06-run-side (× runs × 2 sides)
→ 07-aggregate → 08-diff → 09-judge → 10-timeline
→ 11-report-render → 12-review-workspace → 13-cleanup
```

- **Контракт:** `contract/` — TypeSpec; компилируется в JSON Schema → `src/generated/` (TS-типы + Zod-схемы).
- **Изоляция:** фейковый `$HOME` — фаза `src/phases/04-home-isolation.ts` (строитель дерева `src/isolation/home-builder.ts`); `docker` — цель v0.3.
- **Метрики:** `src/metrics/` — извлечение из opencode-export, медиана/IQR, правило 1.5×IQR для значимости (v0.2).
- **Цены:** `src/pricing/pricing.json` — USD за 1M токенов по провайдерам.

---

## Разработка

Перед первой правкой прочитайте [CONTRIBUTING.ru.md](CONTRIBUTING.ru.md) — там зафиксированы правила: **TDD** (тесты первыми, красный → зелёный), **контракты первичны** (правка `contract/*.tsp` → `tsp compile` → codegen → impl), порог **coverage ≥80%** (CI gate) и анти-rework-процедура (локально зелёные `typecheck` + `lint` + `test` перед push). Кратко: поведение меняется через контракт, тесты пишутся до impl, `src/generated/` не правится руками.

```bash
# Зависимости
npm install
npm --prefix contract install

# Сгенерировать типы из контракта (запускается также автоматически на `npm install`)
npm run contract:codegen

# Проверки
npm run typecheck     # tsc --noEmit (strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes)
npm run lint          # eslint (flat config, type-aware)
npm run test          # vitest run
npm run test:coverage # vitest с покрытием (≥80% — gate в CI)

# Сборка бинарника (нужен bun)
npm run build         # → dist/testaipack

# Разработка с hot-reload
npm run dev           # tsx watch bin/testaipack.ts

# Форматирование
npm run format        # prettier --write .
```

**Требования:** Node `>=20`, bun `>=1.1` (для сборки). TypeSpec-компилятор ставится как devDependency.

---

## Лицензия

MIT
