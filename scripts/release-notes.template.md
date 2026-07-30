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

## v0.6.1 (docker skill/plugin install fix, baseline contamination, judge fixes)

- **The pack was never actually usable under `--isolation docker`**: skills were installed as a symlink into a cache directory not bind-mounted into the container, so the skill dangled and opencode's skill loader found nothing. Local plugins had the same bug, with a green preflight gate on top — a host-absolute path that the gate resolved on the host but the container never saw. Both now install container-valid; the pack-visibility gate now checks inside the container under docker, and the baseline-leak gate fails loudly on a docker error instead of reading it as "no leak."
- **`--pure-baseline` didn't stop a pack trigger in `--init` from reaching the baseline** — the baseline could install the pack from the network itself and run it (the incident that produced 43 pack-generated files in a baseline diff). New `--init-side old|new|both` (default `both`, unchanged behavior) scopes it to one side; a warning fires when `--pure-baseline` is on, the baseline still receives init, and the init text looks like it names the pack.
- New baseline-contamination detector: flags a successful skill call for the pack's name, an install-shaped bash command naming the pack as a whole token (not a substring — dogfooding a pack against its own repo no longer false-positives), or drift in a config file/listing the config-capture phase actually tracks. Summary alert, a dedicated report section, and a caveat on the judge verdict when triggered. Commands and details render byte-identical in the report, backticks included.
- Prompts containing a space reached the model wrapped in literal quote characters — opencode quotes any single argv element with a space in it, and the whole prompt was passed as one element. Now split into separate argv elements — this also fixed the judge crashing with exit 1 on any run whose diff contained `diff --git` lines, which opencode's CLI parsed as unknown flags before this fix.
- Judge failures are diagnosable now: stderr is included in the report's explanation, and full stdout/stderr go to `results/judge.log`. The judge prompt also states plainly that it has no file access (so "analyse report.md" can't be honored — phase 09 runs before the report exists anyway) and requires the model to disclose that gap instead of inventing a verdict.
- The report header now shows which side received `--init` (`both` called out as the contamination mechanism above); pack-usage now distinguishes "confirmed visible, not called" from "visibility not confirmed" instead of rendering both the same way.

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.6.0...v0.6.1

## v0.6.0 (protect-git, offline rebuild, config capture, ~13 new metrics)

- **`--protect-git`** (opt-in, off by default) — keeps each run's `.git` outside the tree the agent works in, so a run can no longer delete or rewrite its own git history. Costs opencode's snapshot/patch export, which needs `.git` in place, so it stays off by default; mainly useful under `--isolation docker`.
- **`testaipack report --rebuild <run-id>`** — recomputes the report entirely offline from artifacts already on disk (aggregate/diff/timeline/report), no agent, LLM, or docker call by default. `--force` overwrites an existing report; `--rejudge` is the one opt-in exception, permitting a single fresh judge call. Works even on workspaces predating `run-input.json`, via best-effort recovery with every recovered/defaulted field disclosed in the rebuilt report.
- Per-side capture of the actual opencode config used by each run — merge layers, installed skills/agents/commands/plugins/mcp servers, npm deps, and observed pack usage — written (with credentials redacted) under `config/.config/opencode/<side>/`.
- Every run now persists `run-input.json` and a per-run `result.json`, closing the data gap that made `--rebuild` and post-hoc recovery possible in the first place.
- ~13 new metrics and a regrouped report (Behavior / Latency / Tokens & context / Output volume, plus Safety, Pack signal, and Stability sections): a pack-never-invoked alert, a destructive-command tripwire (`rm -rf`, force-push, `chmod`, `dd`, `DROP TABLE`, and their common disguises), stability/spread multipliers, real shell-failure counts, hallucinated/duplicate tool calls, tokens and cost per changed line, per-file diff overlap, an opencode version-drift warning, a latency/stall profile, verify pass rate, context growth, and output volume.
- **Fixed**: an agent deleting or replacing its own `.git` no longer aborts the whole run (now recovered/contained, reported as `E_WORKTREE_BROKEN`); one bad run can no longer take down the rest of a side; a judge failure no longer destroys an otherwise-complete report; the manifest now records the opencode version actually used under docker isolation, not the host's; config-capture artifacts no longer write credentials in clear; the success-rate and diff-efficiency numbers in the report no longer drift from crashed or diff-failed runs; git output is now parsed locale-independently (`LC_ALL=C`).

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.5.5...v0.6.0

## v0.5.5 (docker export validation fix)

- **Anyone on `--isolation docker` is currently losing every run**: opencode 1.18.4 (baked into the docker image) writes `finish: "unknown"` into a session, and our export validation — built against 1.18.3 — rejected it outright. `unknown` is now an accepted, valid outcome (treated the same as `other`: not a clean success, not a crash).
- The docker image now pins its opencode version explicitly (`OPENCODE_VERSION` build arg) instead of resolving `latest` at build time — upstream had already moved four releases past what's actually baked in, and that kind of silent drift is exactly what caused the bug above. Override it for a one-off test build via `scripts/build-docker-image.sh`'s third argument or `--build-arg OPENCODE_VERSION=X.Y.Z`.

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.5.4...v0.5.5

## v0.5.4 (docker export fix, cleanup)

- **Anyone using `--isolation docker` on a non-trivial session could lose runs**: `opencode export` output was truncated by a container-teardown race — the throwaway container was removed before its output finished draining through the pipe. Reproduced 5/5 with a plain `docker run`, and the existing retry couldn't help since it just repeated the same doomed operation. Export now writes to a file inside the isolated `$HOME` and is read back from the host — 5/5 complete, byte-identical to the native (non-docker) path.
- `--log-level` is no longer a dead flag — it now controls testaipack's own output verbosity (`info`/`debug`/`warn`/`error`; `debug` is currently the same as `info`).
- Fixed four wrong or missing descriptions in `run --help` (`--preflight-model`, `--pure-baseline`, `--opencode-version`, `--docker-network`).
- `package.json` no longer claims an `npm install -g` / import path that never worked — distribution is release binaries + `install.sh`, nothing else.
- README audit: corrected a stale claim that `npm install` runs codegen automatically, documented `gc --aggressive` and `install.sh`'s `INSTALL_DIR`, and removed a broken file reference.

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.5.3...v0.5.4

## v0.5.3 (security, fixes)

- **Security**: a local plugin file in a pack (`plugins/<name>.js`) could be silently replaced by an unrelated npm package sharing its name — plugin installation resolved local plugin names through `opencode plugin <name>`, which always treats its argument as an npm module specifier. Local plugin files are now delivered and registered directly by path, with no npm resolution involved at all.
- `doctor` no longer reports a missing `bun` as a failure — it's a build-from-source-only dependency, irrelevant if you installed the release binary.
- `doctor`: the `docker` row no longer spills multi-line output across the table.

Full changelog: https://github.com/rus-lan/testAiPack/compare/v0.5.2...v0.5.3

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
