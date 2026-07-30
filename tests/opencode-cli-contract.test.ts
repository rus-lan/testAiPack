/**
 * Contract tests: check the exact argv shapes this codebase builds for the
 * `opencode` CLI against the REAL binary, not against a mock of our own code
 * asserting on itself. Two techniques, chosen per command:
 *
 * - Commands safe to actually run (no quota cost, no side effect, read-only):
 *   `--version`, `mcp list`, `db "<select>" --format json`. These execute for
 *   real in a throwaway `$HOME` and assert on exit code / output.
 * - Commands unsafe to run for real (`run` costs model quota, `plugin`
 *   installs an arbitrary npm module, `export` needs a real session):
 *   the flags/subcommand tokens this codebase emits are checked against the
 *   real binary's own `--help` text, so a token opencode does not recognize
 *   fails the test instead of silently passing.
 *
 * Skips the whole suite when no opencode binary is reachable, so CI without
 * opencode installed stays green. Every invocation gets its own temp `$HOME`
 * (via `tests/setup.ts`'s `makeTempDir`, cleaned up by the shared `afterEach`)
 * and never touches the real one.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { Effect } from 'effect'
import { execCmd } from '../src/opencode/spawn.js'
import { buildRunArgs } from '../src/opencode/cli.js'
import { inheritEnv } from '../src/util/env.js'
import { makeTempDir } from './setup.js'

const OPENCODE_BIN = process.env['OPENCODE_BIN'] ?? 'opencode'

const opencodeEnv = (home: string): Record<string, string> => ({
  ...inheritEnv(['PATH', 'LANG']),
  HOME: home,
})

const freshHome = (): string => {
  const dir = makeTempDir('testaipack-oc-contract-')
  mkdirSync(dir, { recursive: true })
  return dir
}

const probeOpencode = (): boolean => {
  const home = freshHome()
  try {
    execFileSync(OPENCODE_BIN, ['--version'], {
      stdio: 'pipe',
      timeout: 10_000,
      env: opencodeEnv(home),
    })
    return true
  } catch {
    return false
  }
}

const HAS_OPENCODE = probeOpencode()

interface OpencodeResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const runOpencode = (args: readonly string[], home: string): Promise<OpencodeResult> =>
  Effect.runPromise(
    execCmd({ command: OPENCODE_BIN, args, cwd: home, env: opencodeEnv(home) }),
  )

const helpFor = async (path: readonly string[]): Promise<string> => {
  const out = await runOpencode([...path, '--help'], freshHome())
  // opencode writes help/usage text to stderr, not stdout — combine both so
  // this stays correct regardless of which stream a given version picks.
  return `${out.stdout}\n${out.stderr}`
}

const longFlagsIn = (text: string): ReadonlySet<string> =>
  new Set(text.match(/--[a-zA-Z][a-zA-Z0-9-]*/g) ?? [])

/** True when `"value"` shows up within the same option block as `flag` (yargs prints choices as `[choices: "a", "b"]` right after the flag it belongs to). */
const helpAllowsValue = (helpText: string, flag: string, value: string): boolean => {
  const idx = helpText.indexOf(flag)
  if (idx === -1) return false
  return helpText.slice(idx, idx + 200).includes(`"${value}"`)
}

describe.skipIf(!HAS_OPENCODE)('opencode CLI arg-shape contract (real binary)', () => {
  it('opencode --version: real execution succeeds and reports a version', async () => {
    const out = await runOpencode(['--version'], freshHome())
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toMatch(/\d+\.\d+\.\d+/)
  })

  it('opencode mcp list: real execution succeeds on a fresh HOME with nothing configured', async () => {
    const out = await runOpencode(['mcp', 'list'], freshHome())
    expect(out.exitCode).toBe(0)
  })

  it('opencode db "<sql>" --format json: the correct shape runs a read-only SELECT and returns parsed JSON', async () => {
    const out = await runOpencode(['db', 'SELECT 1 as x', '--format', 'json'], freshHome())
    expect(out.exitCode).toBe(0)
    const parsed: unknown = JSON.parse(out.stdout)
    expect(parsed).toEqual([{ x: 1 }])
  })

  it('opencode db query "<sql>" --format json: "db" has no "query" subcommand — a literal query token is rejected', async () => {
    const out = await runOpencode(['db', 'query', 'SELECT 1', '--format', 'json'], freshHome())
    expect(out.exitCode).not.toBe(0)
  })

  it('buildRunArgs: every --flag it emits for `run` is one opencode run actually recognizes', async () => {
    const args = buildRunArgs({
      homeDir: '/unused',
      cwd: '/unused',
      prompt: 'hello',
      agent: 'build',
      model: 'anthropic/claude-x',
      session: 'sess-1',
      continueSession: true,
      auto: true,
      pure: true,
    })
    expect(args).toEqual(
      expect.arrayContaining([
        '--agent', '--model', '--session', '--continue', '--auto', '--pure', '--format', 'json',
      ]),
    )
    // the prompt travels on stdin now (see cli.ts), never argv — so there is
    // no `--` separator to find and no risk of a flag-shaped prompt word
    // landing among these flags at all.
    expect(args).not.toContain('--')
    expect(args).not.toContain('hello')
    const help = await helpFor(['run'])
    const recognized = longFlagsIn(help)
    const emittedFlags = args.filter((tok) => tok.startsWith('--'))
    for (const flag of emittedFlags) {
      expect(recognized.has(flag)).toBe(true)
    }
    expect(helpAllowsValue(help, '--format', 'json')).toBe(true)
  })

  it('"run" is a real top-level opencode command', async () => {
    const help = await helpFor([])
    expect(help).toMatch(/opencode run \[message\.\.\]/)
  })

  it('exportSession args (["export", sessionId]): "export" is a real opencode subcommand', async () => {
    const help = await helpFor([])
    expect(help).toMatch(/opencode export \[sessionID\]/)
  })

  it('installPlugin args (["plugin", module]): "plugin" is a real subcommand, module is its sole positional', async () => {
    const help = await helpFor([])
    expect(help).toMatch(/opencode plugin <module>/)
    const pluginHelp = await helpFor(['plugin'])
    expect(pluginHelp).toMatch(/Positionals:[\s\S]*module/)
  })
})
