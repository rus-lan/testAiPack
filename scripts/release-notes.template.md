# testaipack v{{VERSION}}

**A/B-тестер для opencode-интеграций.** Сравнивает работу AI-агента до и после установки пакета (skill/plugin/agent/command/mcp): клонирует репозиторий, прогоняет одинаковый промпт на «чистой» и «патченной» стороне, собирает метрики (токены, время, стоимость, шаги, tool-calls) и рендерит сравнительный отчёт.

## Установка

```bash
curl -fsSL https://raw.githubusercontent.com/rus-lan/testAiPack/main/install.sh | sh
```

Или вручную — скачайте бинарник для своей платформы из assets ниже и положите в PATH.

## CLI обзор

```
testaipack run <repo> [--pack <ref>] --prompt <text|@file>
testaipack compare <run-id-1> <run-id-2> [--perspective auto]
testaipack review [run-id]
testaipack report [run-id]
testaipack gc [--keep-last N | --older-than 7d]
testaipack list
testaipack init
testaipack doctor
```

Полная документация и changelog: [README.md](https://github.com/rus-lan/testAiPack/blob/main/README.md)

## Платформы

Бинарники собраны под:
- Linux x64 (`testaipack-linux-x64`)
- Linux arm64 (`testaipack-linux-arm64`)
- macOS x64 (`testaipack-darwin-x64`)
- macOS arm64 (`testaipack-darwin-arm64`) — Apple Silicon
- Windows x64 (`testaipack-windows-x64.exe`)

SHA256 checksums в `checksums-sha256.txt`.

## Требования

- **opencode** CLI в PATH (для запусков)
- **git** (для клонирования и diff)
- Для сборки из исходников: Node ≥20, bun ≥1.1

## Лицензия

MIT
