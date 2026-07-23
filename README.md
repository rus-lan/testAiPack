# testaipack

**A/B-тестер для opencode-интеграций.** Сравнивает работу AI-агента до и после
установки пакета (skill / plugin / agent / command / mcp): клонирует репозиторий,
прогоняет один и тот же промпт на «чистой» и «патченной» стороне, собирает
метрики (токены, время, стоимость, шаги) и рендерит сравнительный отчёт.

Создано для тех, кто поддерживает opencode-пакеты и хочет измерить их реальный
вклад — не на глаз, а в числах с медианой по N прогонам и критерием
значимости.

---

## Содержание

- [Возможности](#возможности)
- [Требования](#требования)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Максимальный запуск](#максимальный-запуск)
- [Команды CLI](#команды-cli)
- [Параметры команды `run`](#параметры-команды-run)
- [Форматы `--pack`](#форматы---pack)
- [Сравнение двух прогонов (`compare`)](#сравнение-двух-прогонов-compare)
- [Структура результатов](#структура-результатов)
- [Архитектура](#архитектура)
- [Разработка](#разработка)
- [Лицензия](#лицензия)

---

## Возможности

- **Полный A/B цикл** в одной команде: клон репо → установка пакета →
  N прогонов на каждой стороне → агрегация → diff → отчёт.
- **Любой тип пакета**: skill, plugin, agent, command, mcp — тип определяется
  автоматически по `--pack` ref.
- **Изоляция окружения**: фейковый `$HOME` без сторонних плагинов/скиллов
  (`--isolation=home`) или throwaway Docker-контейнер (`--isolation=docker`).
- **Усреднение по медиане**: несколько прогонов на сторону, правило 1.5×IQR
  для判定 значимости дельт.
- **Мультиформатный отчёт**: Markdown, HTML, JSON, YAML — выберите любой набор.
- **LLM-судья** (опционально): semantic diff между сторонами через промпт-оценщик.
- **Cross-run сравнение**: команда `compare` сопоставляет любые два прогона
  («pack-X неделю назад vs сейчас», «pack-X vs pack-Y»).
- **Inspect-friendly результат**: multi-root VSCode workspace открывается одной
  командой `review` — old/new/pack side-by-side.
- **Контракт-first**: TypeSpec-контракт как единый источник правды для типов и
  Zod-схем; `src/generated/` никогда не правится руками.

---

## Требования

- **opencode** — тестируемый AI-агент (запускается под капотом).
- **Node.js** `>=22` — для зависимостей и tooling.
- **bun** `>=1.1` — для сборки бинарника (`npm run build`).
- **git** — клонирование репозиториев.
- **docker** *(опционально)* — только для `--isolation=docker`.

Проверить всё разом: [`testaipack doctor`](#setup).

---

## Установка

### Через 1 команду (рекомендуется)

```bash
curl -fsSL https://raw.githubusercontent.com/rus-lan/testAiPack/main/install.sh | sh
```

Скрипт определит платформу (linux/darwin/windows × x64/arm64), скачает
бинарник из [последнего релиза](https://github.com/rus-lan/testAiPack/releases/latest)
и установит его в `~/.local/bin/testaipack`. Если каталога нет в `PATH` —
подскажет, какую строку добавить в rc-файл оболочки.

### Готовый бинарник из releases

Скачайте бинарник для своей платформы со
[страницы релизов](https://github.com/rus-lan/testAiPack/releases/latest) и
положите `testaipack` в `PATH`. Бинарник self-contained (скомпилирован через
`bun build --compile`). Доступные сборки: linux-x64/arm64, darwin-x64/arm64
(Apple Silicon), windows-x64.

### Из исходников

```bash
git clone https://github.com/rus-lan/testAiPack.git
cd testAiPack
npm install                  # зависимости + codegen типов (через prepare)
npm --prefix contract install
npm run contract:codegen     # перегенерировать src/generated/ из TypeSpec
npm run build                # → dist/testaipack (нужен bun)
```

После сборки бинарник лежит в `./dist/testaipack`. Для кросс-компиляции всех
платформ разом: `npm run build:all` (→ `dist/release/`).

### Проверка установки

```bash
testaipack doctor     # opencode, git, node, bun — всё на месте?
```

---

## Быстрый старт

Минимальный прогон требует только `<repo>` и `--prompt`. Остальные флаги имеют
дефолты (см. [таблицу ниже](#параметры-команды-run)).

```bash
# 1. Прогнать первый A/B (pack = skill из git-URL)
./dist/testaipack run https://github.com/owner/repo \
  --pack git+https://github.com/me/my-skill \
  --prompt "реализуй фичу X по спецификации"

# 2. Открыть результат в VSCode (multi-root workspace, old/new side-by-side)
./dist/testaipack review
```

Первый прогон создаст `./.testaipack/` с деревом рабочих директорий и положит
отчёт в `./.testaipack/<run-id>/report/`.

> Smoke-test без пакета: `testaipack run <repo> --prompt "do the thing"` —
> прогонится только baseline-сторона.

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
  --docker-image opencode/opencode:latest \
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
  --log-level info \
  --ephemeral
```

---

## Команды CLI

Восемь команд, сгруппированных по назначению.

### A/B testing

| Команда                  | Описание                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------ |
| [`run`](#параметры-команды-run) | Полный A/B прогон: клон → установка пакета → N прогонов на сторону → отчёт.   |

### Results

| Команда                                | Описание                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------ |
| [`compare`](#сравнение-двух-прогонов-compare) | Сравнить два любых прогона между собой (cross-run A/B).            |
| `report [run-id]`                      | Перерендерить отчёт прогона в Markdown на stdout.                        |
| `review [run-id]`                      | Открыть multi-root VSCode workspace для прогона (old/new side-by-side).  |
| `list`                                 | Список всех прогонов в `<workspace>`.                                    |
| `gc`                                   | Очистка старых прогонов из рабочего дерева (`--keep-last`, `--older-than`). |

<a name="setup"></a>

### Setup

| Команда    | Описание                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| `doctor`   | Проверить зависимости (opencode, git, node, bun).                            |
| `init`     | Инициализировать `<workspace>/.testaipack/`.                                 |

```bash
./dist/testaipack --help        # обзор всех команд
./dist/testaipack run --help    # детали конкретной команды
```

---

## Параметры команды `run`

Команда `run` принимает собственные CLI-флаги (перечислены первыми) и
форвардит в парсер фазу-00 все остальные опции конфигурации прогона.

### Собственные флаги `run`

| Флаг              | Тип                                              | По умолчанию | Описание                                                          |
| ----------------- | ------------------------------------------------ | ------------ | ----------------------------------------------------------------- |
| `--review-run <N>`| `int`                                            | `1`          | Какой прогон (по индексу) открыть в `review`.                     |
| `--ide <editor>`  | `vscode\|cursor\|code-insiders`                  | `vscode`     | Редактор для команды `review`.                                    |
| `--ephemeral`     | флаг                                             | off          | Удалить `apps/`, `home/`, `pack/` после прогона (оставить `results/`). |
| `--config <path>` | `string`                                         | —            | Путь к `config.json` testaipack (переопределяет дефолты флагов).  |

### Флаги конфигурации прогона (phase-00)

| Флаг                       | Тип                                       | По умолчанию                  | Описание                                                                                                         |
| -------------------------- | ----------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `<repo>` (позиционный)     | `string`                                  | — (обязательный)              | URL git-репозитория для A/B прогона.                                                                             |
| `--pack <ref>`             | `string`                                  | —                             | Тестируемый пакет: git-URL, npm-pkg, локальный путь или `mcp:<name>:<config>`. Тип определяется автоматически.    |
| `--pack-type <type>`       | `skill\|plugin\|agent\|command\|mcp\|all` | авто                          | Переопределить тип пакета вместо авто-детекции.                                                                  |
| `--prompt <text\|@file>`   | `string`                                  | — (обязательный)              | Промпт для агента на стороне сборки. `@file` читает содержимое файла.                                            |
| `--init <text\|@file>`     | `string`                                  | —                             | Опц. промпт, запускаемый ДО `--prompt` в той же сессии (подготовка окружения).                                   |
| `--verify <cmd>`           | `string`                                  | —                             | Опц. shell-команда после работы агента (например `npm test`). Учитывается в метриках успеха.                     |
| `--isolation <mode>`       | `home\|docker`                            | `home`                        | Режим изоляции. `docker` запускает opencode в `docker run --rm` контейнере (v0.3); при недоступном Docker daemon молча откатывается на `home`. |
| `--docker-image <image>`   | `string`                                  | `opencode/opencode:latest`    | Образ для `--isolation=docker`. Игнорируется в режиме `home`.                    |
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
| `--pricing <path>`         | `string`                                  | встроенный                    | Своё дерево цен (USD за 1M токенов).                                                                             |
| `--log-level <lvl>`        | `debug\|info\|warn\|error`                | `info`                        | Уровень логирования.                                                                                             |

---

## Форматы `--pack`

Тип пакета определяется по префиксу `--pack` (или фиксируется через `--pack-type`):

| Ссылка                                               | Тип      | Что тестируется                                                             |
| ---------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `github:owner/skill` / `git+https://…` / лок. путь   | `skill`  | skill-пакет (каталог с `SKILL.md`).                                         |
| `npm:myplugin`                                       | `plugin` | npm-модуль opencode-плагина (ставится через `opencode plugin`).             |
| `agent:./build.md` / `agent:<git-url>`               | `agent`  | одиночный агент (`.md`).                                                    |
| `command:./run.md`                                    | `command`| одиночная команда (`.md`).                                                  |
| `mcp:myserver:{"command":"npx","args":["-y","srv"]}` | `mcp`    | MCP-сервер: конфиг инлайн (v0.3).                                           |
| `mcp:myserver:@./mcp.json`                            | `mcp`    | MCP-сервер: конфиг из файла (v0.3).                                         |

MCP-конфиг вписывается в секцию `mcp` сгенерированного `opencode.json` на «новой»
стороне (`mcp.<name>`); на baseline-стороне MCP-сервер отсутствует.

---

## Сравнение двух прогонов (`compare`)

`compare` сопоставляет **любые два прогона** между собой, а не только old/new
внутри одного прогона. Удобно для вопросов «pack-X неделю назад vs сейчас» или
«pack-X vs pack-Y». Команда берёт выбранную сторону каждого прогона и считает
дельты (токены, время, стоимость, ранг успеха) через тот же движок, что и
основной отчёт.

| Флаг                       | По умолчанию | Описание                                                                                                          |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `<run-id-1>` (позиционный) | —            | Первый прогон (база сравнения).                                                                                   |
| `<run-id-2>` (позиционный) | —            | Второй прогон (сравнивается против первого; дельты = run2 minus run1).                                            |
| `--perspective <p>`        | `auto`       | Какую сторону каждого прогона брать: `new-vs-new`, `old-vs-old`, `best` (макс. successRank), `auto`.             |
| `--format <f>`             | `md`         | Формат вывода: `md` (Markdown-таблица) или `json`.                                                                |
| `--workspace <path>`       | `.testaipack`| Корень рабочего дерева testaipack.                                                                                |

Логика `--perspective auto`: оба прогона с pack → `new-vs-new`; оба smoke-test
→ `old-vs-old`; смешанный случай → `best`.

```bash
./dist/testaipack compare 2026-07-21_17-30-0a1b2c 2026-07-23_10-15-def456 \
  --perspective new-vs-new
```

---

## Структура результатов

После прогона всё лежит под `./.testaipack/<run-id>/`. Дерево (без `--ephemeral`):

```
.testaipack/
└── <run-id>/                      # 2026-07-23_10-15-0a1b2c
    ├── manifest.json              # конфигурация прогона (фаза 01)
    ├── apps/                      # клоны репозитория
    │   ├── old/run-{1..N}/
    │   └── new/run-{1..N}/
    ├── pack/                      # установленный тестируемый пакет
    ├── home/                      # фейковые $HOME (изоляция)
    │   ├── old/run-{1..N}/
    │   └── new/run-{1..N}/
    ├── config/                    # сгенерированные opencode.json и env
    ├── raw/                       # opencode export сырых прогонов
    │   ├── old/run-N.json
    │   └── new/run-N.json
    ├── diff/                      # git-diff результаты (фаза 08)
    ├── timeline.json              # карта событий (фаза 10)
    ├── timeline.html
    ├── report/                    # отчёты во всех запрошенных форматах
    │   ├── report.md
    │   ├── report.html
    │   ├── report.json
    │   └── report.yaml
    └── review.code-workspace     # multi-root VSCode workspace (фаза 12)
```

Флаг `--ephemeral` удаляет `apps/`, `home/`, `pack/` сразу после прогона, оставляя
`results/` (`raw/`, `diff/`, `report/`, `manifest.json`).

---

## Архитектура

Пайплайн разбит на 14 фаз, каждая описана отдельным TypeSpec-контрактом и
phase-документом. Полная схема зависимостей — в
[`docs/phases/README.ru.md`](docs/phases/README.ru.md).

```
00-cli-parse → 01-workspace-setup → 02-repo-clone → 03-pack-install
→ 04-home-isolation → 05-preflight → 06-run-side (× runs × 2 sides)
→ 07-aggregate → 08-diff → 09-judge → 10-timeline
→ 11-report-render → 12-review-workspace → 13-cleanup
```

- **Контракт:** `contract/` — TypeSpec; компилируется в JSON Schema →
  `src/generated/` (TS-типы + Zod-схемы). Единственный источник правды для типов.
- **Изоляция:** фейковый `$HOME` — фаза `src/phases/04-home-isolation.ts`
  (строитель дерева `src/isolation/home-builder.ts`). Режим `--isolation=docker`
  (v0.3) прогоняет opencode в throwaway-контейнере
  (`src/isolation/docker-runner.ts`): хост-`$HOME` монтируется как
  `/home/opencode`, рабочая директория — как `/workspace`. При недоступном Docker
  daemon (фаза 00, `isDockerAvailable`) запуск автоматически откатывается на
  `home`-изоляцию.
- **Метрики:** `src/metrics/` — извлечение из opencode-export, медиана/IQR,
  правило 1.5×IQR для значимости (v0.2).
- **Цены:** `src/pricing/pricing.json` — USD за 1M токенов по провайдерам.
- **Стек:** TypeScript strict + Effect-TS (IO и типизированные ошибки) + Zod
  (runtime-валидация) + TypeSpec (контракт) + bun (сборка).

---

## Разработка

Перед первой правкой прочитайте [`CONTRIBUTING.ru.md`](CONTRIBUTING.ru.md) — там
зафиксированы правила: **TDD** (тесты первыми, красный → зелёный), **контракты
первичны** (правка `contract/*.tsp` → `tsp compile` → codegen → impl), порог
**coverage ≥80%** (CI gate) и анти-rework-процедура (локально зелёные `typecheck`
+ `lint` + `test` перед push). Кратко: поведение меняется через контракт, тесты
пишутся до impl, `src/generated/` не правится руками.

```bash
# Зависимости
npm install
npm --prefix contract install

# Сгенерировать типы из контракта (запускается также автоматически на npm install)
npm run contract:codegen

# Проверки
npm run typecheck     # tsc --noEmit (strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes)
npm run lint          # eslint (flat config, type-aware, --max-warnings=0)
npm test              # vitest run
npm run test:coverage # vitest с покрытием (≥80% — gate в CI)

# Сборка бинарника (нужен bun)
npm run build         # → dist/testaipack

# Разработка с hot-reload
npm run dev           # tsx watch bin/testaipack.ts

# Форматирование
npm run format        # prettier --write .
```

**Требования:** Node `>=22`, bun `>=1.1` (для сборки). TypeSpec-компилятор
ставится как devDependency.

---

## Лицензия

MIT
