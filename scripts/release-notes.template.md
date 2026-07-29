<!-- Hand-maintained. Add a new "## vX.Y.Z" section here for every release,
     kept in sync with CHANGELOG.md — this template is what actually ships
     as the GitHub release body; nothing reads CHANGELOG.md automatically. -->

# testaipack v{{VERSION}}

**A/B-тестер для opencode-интеграций.** Сравнивает работу AI-агента до и после установки пакета (skill/plugin/agent/command/mcp): клонирует репозиторий, прогоняет одинаковый промпт на «чистой» и «патченной» стороне, собирает метрики (токены, время, стоимость, шаги, tool-calls) и рендерит сравнительный отчёт.

## Установка

```bash
curl -fsSL https://github.com/rus-lan/testAiPack/releases/latest/download/install.sh | sh
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

## v0.5.2 (installer)

- The installer no longer talks to the GitHub API at all — it downloads directly through GitHub's `releases/latest/download/<asset>` redirect. That means the anonymous API's 60-requests/hour-per-IP limit can no longer break an install, which mattered most on a shared IP (office, CI, VPN).
- `TESTAIPACK_VERSION=0.5.0 sh install.sh` installs a specific version instead of latest.

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.5.1...v0.5.2

## v0.5.1 (install fix)

- **The one-line install command from the README has been broken since v0.5.0 (and v0.4.0 before it)** — `curl -fsSL .../releases/latest/download/install.sh | sh` returned a 404, because `install.sh` was never attached as a release asset. It is now: `install.sh` is built into every release alongside the binaries.
- The installer now verifies the downloaded binary against the published `checksums-sha256.txt` and fails loudly on a mismatch, instead of installing whatever it downloaded unchecked.

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.5.0...v0.5.1

## v0.5.0 (docker fixes, feature)

- **`--isolation docker` was broken for everyone, regardless of networking** — the container ran as the wrong user and couldn't write into the isolated HOME mounted from the host, failing every docker-mode run at preflight with a permission error. Fixed: the container now runs as your host uid/gid (Linux/macOS).
- `--docker-network <mode>` — set the container's network mode (e.g. `host`), needed to reach a host-local model server (ollama) from `--isolation docker`, since a bridged container's `localhost` is itself. Linux-specific: Docker Desktop on Mac/Windows doesn't expose the host loopback the same way.
- Falling back from `--isolation docker` to `home` (when Docker isn't available) now prints a warning instead of silently changing what actually ran.
- README gained a "Проверенные примеры" section with five real, verified end-to-end commands, and a dedicated section on running local/self-hosted models (ollama and friends).

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.4.0...v0.5.0

## v0.4.0 (features, fixes, security)

- `--model <provider/model>` — pin the model for both sides of a run (baseline and patched), baked into the generated opencode configs.
- Local and self-hosted providers (ollama and friends) are now usable: isolation copies your real `provider`, `small_model`, `enabled_providers` and `disabled_providers` config into both sides identically, so a custom provider no longer vanishes inside the run's isolated HOME.
- `--model` / `--preflight-model` now accept ollama's `provider/model:tag` naming (`ollama/qwen3.5:9b`, `ollama/llama3.1:8b`) — previously rejected.
- Preflight now checks auth against the model the run itself will use, instead of a separate `--preflight-model` — no more preflight passing on a healthy model while the real run fails on a different one.
- `--ephemeral`, `--config`, `--ide`, `--review-run` were dead flags that broke the run — now work as documented.
- `--help` documents all orchestrator-level flags.
- Secrets (inline `mcp:` pack refs, clone-URL credentials) no longer reach reports, error messages, logs, or the judge prompt.
- A pack ref resolving to `..` could delete the whole run workspace — fixed.
- The LLM judge no longer runs a write-enabled agent in your real `$HOME` — it's read-only now, in an isolated scratch directory.
- Per-file diff totals (`fileDiffStats`) are no longer reported — the field always read as zero from opencode's own export summary and could never carry real numbers; `report.md`'s existing diff summary already shows the real per-side totals.

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.3.4...v0.4.0

## v0.3.4 (bugfix)

- execCmd did not pass encoding utf8 to execFile causing opencode export output to be Buffer instead of string

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.3.3...v0.3.4

## v0.3.3 (bugfix)

- opencode run crash: extract real session ID from events stream for export (previously fell back to fake ID on non-zero exit)

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.3.2...v0.3.3

## v0.3.2 (bugfixes)

- OpencodeError now captures stdout alongside stderr — fixes silent error loss when opencode writes diagnostics to stdout as JSON
- `failOnNonZero` preserves stdout in error context (was hardcoded to `''`)
- `exportSession` detects empty stdout and fails with descriptive message including session ID
- Export error context in phase 06 now includes exitCode + stdout for better diagnostics
- Preflight `stderrOf()` falls back to stdout when stderr is empty
- Auth-missing regex tightened to avoid false positives on "no provider"

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.3.1...v0.3.2

## v0.3.1 (bugfixes)

- `--version` / `-v` flag in CLI (install.sh post-install check was failing)
- pack-detector: git URLs without `.git` suffix now accepted (`https://github.com/owner/repo`, `git+https://...`, SCP `git@...:owner/repo`)
- pack-detector: `git+` prefix stripped before clone (npm convention, git itself rejects it)
- pack-install: skill.md resolved case-insensitively (graphify pack has `graphify/skill.md`, opencode scans only uppercase `**/SKILL.md`)
- real e2e verified with live graphify skill pack

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.3.0...v0.3.1

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
- Для сборки из исходников: Node ≥22, bun ≥1.1

## Лицензия

MIT
