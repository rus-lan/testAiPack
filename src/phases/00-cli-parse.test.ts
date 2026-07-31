import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile } from '../util/fs.js'
import { threeVariants } from '../../tests/helpers/variants.js'
import {
  cliParse,
  effectiveOf,
  packsOf,
  foreignPacksOf,
  baselineOf,
  packShortName,
  VARIANT_NAME_RE,
  RESERVED_VARIANT_NAMES,
} from './00-cli-parse.js'
import type { CliParseOutput } from './00-cli-parse.js'
import { PhaseError } from '../errors.js'
import type { RunInput, VariantSpec } from '@generated/types'

vi.mock('../util/docker.js', () => ({
  isDockerAvailable: vi.fn(),
  DOCKER_PROBE_TIMEOUT_MS: 3000,
}))

import { isDockerAvailable } from '../util/docker.js'

const dockerMock = vi.mocked(isDockerAvailable)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(fa))

const ensureDirP = (p: string): Promise<void> => runP(ensureDir(p))
const writeFileP = (p: string, c: string): Promise<void> => runP(writeFile(p, c))
const writeConfig = async (cwd: string, config: unknown): Promise<void> => {
  await ensureDirP(path.join(cwd, '.testaipack'))
  await writeFileP(path.join(cwd, '.testaipack', 'config.json'), JSON.stringify(config))
}

const REPO = 'https://github.com/example/repo.git'

const variantByName = (ri: RunInput, name: string): VariantSpec | undefined =>
  ri.variants.find((v) => v.name === name)

beforeEach(() => {
  dockerMock.mockReset()
  dockerMock.mockReturnValue(Effect.succeed(true))
})

describe('cliParse — happy path', () => {
  it('minimal run args produce defaults (runs=3, parallel=2, isolation=home, formats=[md], legacy shim old/new, configSource=cli)', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'fix bug'], cwd }))
    const ri = result.runInput
    expect(ri.schemaVersion).toBe(2)
    expect(ri.repoUrl).toBe(REPO)
    expect(ri.prompt).toBe('fix bug')
    expect(ri.runs).toBe(3)
    expect(ri.parallel).toBe(2)
    expect(ri.isolation).toBe('home')
    expect(ri.formats).toEqual(['md'])
    expect(ri.baseline).toBe('old')
    expect(ri.variants.map((v) => v.name)).toEqual(['old', 'new'])
    expect(variantByName(ri, 'old')?.pure).toBe(true)
    expect(variantByName(ri, 'new')?.pure).toBe(false)
    expect(ri.preflightEnabled).toBe(true)
    expect(ri.collapseRepeats).toBe(false)
    expect(ri.logLevel).toBe('info')
    expect(ri.outputPath).toBe('./results')
    expect(ri.workspacePath).toBe('./.testaipack')
    expect(ri.auth).toEqual({
      opencode: true, npmrc: true, anthropic: false, openai: false,
      gemini: false, aws: false, ssh: false, git: false,
    })
    expect(result.configSource).toBe('cli')
    expect(result.flagDefaults.dockerDowngraded).toBe(false)
    expect(result.flagDefaults.legacyShim).toBe(true)
    expect(result.flagDefaults.parallel).toBe(2)
    expect(result.flagDefaults.baseline).toBe('old')
  })

  it('strips a leading "run" subcommand token', async () => {
    const cwd = makeTempDir()
    const r1 = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    const r2 = await runP(cliParse({ argv: [REPO, '--prompt', 'x'], cwd }))
    expect(r1.runInput.prompt).toBe(r2.runInput.prompt)
  })
})

describe('cliParse — config file', () => {
  it('uses config-only values → configSource=config', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'from config', runs: 7 })
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.prompt).toBe('from config')
    expect(result.runInput.runs).toBe(7)
    expect(result.configSource).toBe('config')
  })

  it('CLI overrides config → configSource=merged', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'cfg', runs: 5 })
    const result = await runP(cliParse({ argv: ['run', '--runs', '2'], cwd }))
    expect(result.runInput.runs).toBe(2)
    expect(result.runInput.prompt).toBe('cfg')
    expect(result.configSource).toBe('merged')
  })

  it('explicit configFile path overrides the default location', async () => {
    const cwd = makeTempDir()
    await ensureDirP(cwd)
    const cfg = path.join(cwd, 'custom.json')
    await writeFileP(cfg, JSON.stringify({ repoUrl: REPO, prompt: 'custom file' }))
    const result = await runP(cliParse({ argv: ['run'], cwd, configFile: cfg }))
    expect(result.runInput.prompt).toBe('custom file')
    expect(result.configSource).toBe('config')
  })

  it('a malformed config.json → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    await ensureDirP(path.join(cwd, '.testaipack'))
    await writeFileP(path.join(cwd, '.testaipack', 'config.json'), '{ not json')
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('a config.json that violates the schema → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { runs: 'not-a-number' })
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — validation errors', () => {
  it('missing --prompt (and no config) → E_CONFIG_INVALID (no effective prompt on any variant)', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('prompt-required')
  })

  it('missing repoUrl → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', '--prompt', 'x'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--pack-check with --no-preflight → E_CONFIG_INVALID (the check would be declared but never executed)', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({
        argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:mytool', '--pack-check', 'mytool --version', '--no-preflight'],
        cwd,
      }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('pack-check-without-preflight')
  })

  it('--pack-check without --no-preflight (preflight defaults on) → not refused by the preflight check', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:mytool', '--pack-check', 'mytool --version'], cwd }),
    )
    expect(result.runInput.packs[0]?.check).toBe('mytool --version')
    expect(result.runInput.preflightEnabled).toBe(true)
  })

  it('--runs 0 → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--runs', '0'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--runs -1 → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--runs', '-1'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--runs non-integer → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--runs', 'abc'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('invalid --isolation → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--isolation', 'foo'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('invalid --timeline-mode → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--timeline-mode', 'wat'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('invalid --init-side → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--init-side', 'wat'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('invalid --log-level → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--log-level', 'loud'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('invalid --pack-type → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:x', '--pack-type', 'nope'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('unknown flag → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--bogus', 'y'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — @file prompt', () => {
  it('reads a single @file into prompt and records promptFiles', async () => {
    const cwd = makeTempDir()
    await ensureDirP(path.join(cwd, 'prompts'))
    await writeFileP(path.join(cwd, 'prompts', 'fix.md'), 'fix the bug')
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', '@prompts/fix.md'], cwd }))
    expect(result.runInput.prompt).toBe('fix the bug')
    expect(result.runInput.promptFiles).toEqual([path.join(cwd, 'prompts', 'fix.md')])
  })

  it('concatenates multiple @file in flag order with \\n\\n', async () => {
    const cwd = makeTempDir()
    await ensureDirP(cwd)
    await writeFileP(path.join(cwd, 'a.md'), 'AAA')
    await writeFileP(path.join(cwd, 'b.md'), 'BBB')
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', '@a.md', '--prompt', '@b.md'], cwd }),
    )
    expect(result.runInput.prompt).toBe('AAA\n\nBBB')
    expect(result.runInput.promptFiles).toEqual([path.join(cwd, 'a.md'), path.join(cwd, 'b.md')])
  })

  it('mixes literal and @file prompts', async () => {
    const cwd = makeTempDir()
    await ensureDirP(cwd)
    await writeFileP(path.join(cwd, 'a.md'), 'FILE')
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'LITERAL', '--prompt', '@a.md'], cwd }),
    )
    expect(result.runInput.prompt).toBe('LITERAL\n\nFILE')
  })

  it('a missing @file → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', '@nope.md'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — formats', () => {
  it('--format all expands to [md, html, json, yaml]', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--format', 'all'], cwd }))
    expect(result.runInput.formats.sort()).toEqual(['html', 'json', 'md', 'yaml'])
  })

  it('repeated --format accumulates', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--format', 'md', '--format', 'json'], cwd }),
    )
    expect(result.runInput.formats).toEqual(['md', 'json'])
  })

  it('invalid format value → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--format', 'pdf'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — pack (legacy shim)', () => {
  it('absent --pack → smoke-test (no packs registered, "new" variant has an empty pack set)', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.packs).toEqual([])
    expect(variantByName(result.runInput, 'new')?.packs).toEqual([])
  })

  it('--pack npm:myplugin auto-detects packs[0].type=plugin, referenced by the "new" variant', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:myplugin'], cwd }))
    expect(result.runInput.packs).toHaveLength(1)
    expect(result.runInput.packs[0]?.ref).toBe('npm:myplugin')
    expect(result.runInput.packs[0]?.type).toBe('plugin')
    expect(result.runInput.packs[0]?.name).toBe(packShortName('npm:myplugin'))
    expect(variantByName(result.runInput, 'new')?.packs).toEqual([result.runInput.packs[0]?.name])
    expect(variantByName(result.runInput, 'old')?.packs).toEqual([])
  })

  it('--pack github:owner/skill auto-detects packs[0].type=skill', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'github:owner/skill'], cwd }))
    expect(result.runInput.packs[0]?.type).toBe('skill')
  })

  it('--pack ./local/skill auto-detects packs[0].type=skill', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', './local/skill'], cwd }))
    expect(result.runInput.packs[0]?.type).toBe('skill')
  })

  it('explicit --pack-type overrides auto-detect', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:x', '--pack-type', 'all'], cwd }),
    )
    expect(result.runInput.packs[0]?.type).toBe('all')
  })

  it('a --pack mcp: ref that fails detection never leaks its secret-bearing config', async () => {
    const cwd = makeTempDir()
    const secretRef = 'mcp::{"env":{"KEY":"sk-fake-secret"}}'
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', secretRef], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.message).not.toContain('sk-fake-secret')
    expect(err.message).not.toContain('"env"')
    const contextJson = JSON.stringify(err.context)
    expect(contextJson).not.toContain('sk-fake-secret')
    expect(contextJson).not.toContain('"env"')
  })

  // Security: packShortName derives the disclosed pack NAME (manifest/report
  // provenance, judge prompt) — none of those redact `ref` themselves, so a
  // credential in a --pack git URL must not survive into the name. The `ref`
  // field itself legitimately keeps the credential (needed to actually clone)
  // and is redacted separately, elsewhere in the pipeline, when disclosed.
  it('--pack with a credentialed git URL produces a pack name with neither the username nor the secret', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({
        argv: ['run', REPO, '--prompt', 'x', '--pack', 'https://svc-bot:s3cr3t-tok3n@example.com/org/tool.git'],
        cwd,
      }),
    )
    const pack = result.runInput.packs[0]
    expect(pack).toBeDefined()
    expect(pack?.name).not.toContain('svc-bot')
    expect(pack?.name).not.toContain('s3cr3t-tok3n')
    expect(pack?.name).toBe('tool')
    // the ref itself is untouched (still needed to actually clone) — its own
    // redaction on disclosure is a different code path, not this phase's job.
    expect(pack?.ref).toBe('https://svc-bot:s3cr3t-tok3n@example.com/org/tool.git')
  })
})

describe('cliParse — pack-setup/pack-check/pack-exercise (legacy shim)', () => {
  it('all three flags land on the registered pack / the "new" variant', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({
        argv: [
          'run', REPO, '--prompt', 'x', '--pack', 'npm:x',
          '--pack-setup', 'npm install -g --prefix $HOME/.local x',
          '--pack-check', 'x --version',
          '--pack-exercise', 'x run',
        ],
        cwd,
      }),
    )
    expect(result.runInput.packs[0]?.setup).toBe('npm install -g --prefix $HOME/.local x')
    expect(result.runInput.packs[0]?.check).toBe('x --version')
    expect(variantByName(result.runInput, 'new')?.exercise).toBe('x run')
  })

  it('defaults: no allowPacks, no registered packs, no exercise', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(variantByName(result.runInput, 'old')?.allowPacks).toBeUndefined()
    expect(result.runInput.packs).toEqual([])
    expect(variantByName(result.runInput, 'new')?.exercise).toBeUndefined()
  })

  it('--allow-baseline-tool sets variants[old].allowPacks=[packName]; --no-allow-baseline-tool clears it', async () => {
    const cwd = makeTempDir()
    const on = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:x', '--allow-baseline-tool'], cwd }),
    )
    expect(variantByName(on.runInput, 'old')?.allowPacks).toEqual([on.runInput.packs[0]?.name])
    const off = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:x', '--allow-baseline-tool', '--no-allow-baseline-tool'], cwd }),
    )
    expect(variantByName(off.runInput, 'old')?.allowPacks).toBeUndefined()
  })

  it('--pack-setup without --pack (or packRef in config) → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack-setup', 'npm install -g x'], cwd }),
    )
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('pack-setup-without-pack')
  })

  it('--pack-check without --pack → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack-check', 'x --version'], cwd }),
    )
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--pack-exercise without --pack → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack-exercise', 'x run'], cwd }),
    )
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--pack-exercise without --pack-check is fine — cliParse still succeeds', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({
        argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:x', '--pack-setup', 's', '--pack-exercise', 'e'],
        cwd,
      }),
    )
    expect(variantByName(result.runInput, 'new')?.exercise).toBe('e')
    expect(result.runInput.packs[0]?.check).toBeUndefined()
  })

  it('config-file packSetup/packCheck/packExercise/allowBaselineTool are honored', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, {
      repoUrl: REPO,
      prompt: 'x',
      packRef: 'npm:x',
      packSetup: 'setup-cmd',
      packCheck: 'check-cmd',
      packExercise: 'exercise-cmd',
      allowBaselineTool: true,
    })
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.packs[0]?.setup).toBe('setup-cmd')
    expect(result.runInput.packs[0]?.check).toBe('check-cmd')
    expect(variantByName(result.runInput, 'new')?.exercise).toBe('exercise-cmd')
    expect(variantByName(result.runInput, 'old')?.allowPacks).toEqual([result.runInput.packs[0]?.name])
  })
})

describe('cliParse — hint (global, --hint / legacy --pack-hint alias)', () => {
  const HINT = 'If the project contains a prepared code index in .graphify/, use it to navigate the code. If it is absent, work as usual.'

  it('--pack-hint sets the global runInput.hint', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack-hint', HINT], cwd }),
    )
    expect(result.runInput.hint).toBe(HINT)
  })

  it('--hint (new flag name) sets the same global runInput.hint', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--hint', HINT], cwd }),
    )
    expect(result.runInput.hint).toBe(HINT)
  })

  it('absent by default', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.hint).toBeUndefined()
  })

  it('does not require --pack', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack-hint', HINT], cwd }),
    )
    expect(result.runInput.hint).toBe(HINT)
    expect(result.runInput.packs).toEqual([])
  })

  it('config-file packHint is honored, CLI --hint overrides it', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'x', packHint: 'config hint' })
    const fromConfig = await runP(cliParse({ argv: ['run'], cwd }))
    expect(fromConfig.runInput.hint).toBe('config hint')

    const fromCli = await runP(cliParse({ argv: ['run', '--hint', 'cli hint'], cwd }))
    expect(fromCli.runInput.hint).toBe('cli hint')
  })
})

describe('cliParse — docker downgrade', () => {
  it('--isolation docker with no daemon → isolation=home, dockerDowngraded=true', async () => {
    dockerMock.mockReturnValue(Effect.succeed(false))
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--isolation', 'docker'], cwd }))
    expect(result.runInput.isolation).toBe('home')
    expect(result.flagDefaults.dockerDowngraded).toBe(true)
  })

  it('--isolation docker with daemon available → stays docker', async () => {
    dockerMock.mockReturnValue(Effect.succeed(true))
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--isolation', 'docker'], cwd }))
    expect(result.runInput.isolation).toBe('docker')
    expect(result.flagDefaults.dockerDowngraded).toBe(false)
  })

  it('--isolation home never probes docker', async () => {
    dockerMock.mockReturnValue(Effect.succeed(false))
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.isolation).toBe('home')
    expect(result.flagDefaults.dockerDowngraded).toBe(false)
    expect(dockerMock).not.toHaveBeenCalled()
  })

  it('--docker-image is parsed and surfaced on the CliParseOutput', async () => {
    dockerMock.mockReturnValue(Effect.succeed(true))
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({
        argv: ['run', REPO, '--prompt', 'x', '--isolation', 'docker', '--docker-image', 'registry/oc:dev'],
        cwd,
      }),
    )
    expect(result.dockerImage).toBe('registry/oc:dev')
  })

  it('without --docker-image the dockerImage field is absent', async () => {
    dockerMock.mockReturnValue(Effect.succeed(false))
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.dockerImage).toBeUndefined()
  })

  it('--docker-network is parsed onto runInput.dockerNetwork', async () => {
    dockerMock.mockReturnValue(Effect.succeed(true))
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({
        argv: ['run', REPO, '--prompt', 'x', '--isolation', 'docker', '--docker-network', 'host'],
        cwd,
      }),
    )
    expect(result.runInput.dockerNetwork).toBe('host')
  })

  it('without --docker-network runInput.dockerNetwork is absent', async () => {
    dockerMock.mockReturnValue(Effect.succeed(false))
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.dockerNetwork).toBeUndefined()
  })
})

describe('cliParse — init-side (legacy shim per-variant distribution)', () => {
  it('no --init-side → defaults to "both": both old and new get init', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--init', 'do setup'], cwd }),
    )
    expect(variantByName(result.runInput, 'old')?.init).toBe('do setup')
    expect(variantByName(result.runInput, 'new')?.init).toBe('do setup')
  })

  it('--init-side new → only the "new" variant gets its own init field', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--init', 'do setup', '--init-side', 'new'], cwd }),
    )
    expect(variantByName(result.runInput, 'old')?.init).toBeUndefined()
    expect(variantByName(result.runInput, 'new')?.init).toBe('do setup')
  })

  it('--init-side old → only the "old" variant gets its own init field', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--init', 'do setup', '--init-side', 'old'], cwd }),
    )
    expect(variantByName(result.runInput, 'old')?.init).toBe('do setup')
    expect(variantByName(result.runInput, 'new')?.init).toBeUndefined()
  })

  it('the legacy shim never sets the global runInput.init (only the per-variant fields)', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--init', 'do setup'], cwd }),
    )
    expect(result.runInput.init).toBeUndefined()
  })

  it('config-file initSide is honored; CLI --init-side still wins over it', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'x', init: 'do setup', initSide: 'old' })
    const fromConfig = await runP(cliParse({ argv: ['run'], cwd }))
    expect(variantByName(fromConfig.runInput, 'old')?.init).toBe('do setup')
    expect(variantByName(fromConfig.runInput, 'new')?.init).toBeUndefined()

    const overridden = await runP(cliParse({ argv: ['run', '--init-side', 'new'], cwd }))
    expect(variantByName(overridden.runInput, 'old')?.init).toBeUndefined()
    expect(variantByName(overridden.runInput, 'new')?.init).toBe('do setup')
  })

  it('flagDefaults no longer carries initSide (per-variant init discloses it instead)', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--init-side', 'new'], cwd }),
    )
    expect(result.flagDefaults['initSide']).toBeUndefined()
  })
})

describe('cliParse — result shape', () => {
  it('produced RunInput round-trips through the Zod runInputSchema', async () => {
    const cwd = makeTempDir()
    const result: CliParseOutput = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:p'], cwd }),
    )
    const { runInputSchema } = await import('@generated/schemas')
    const parsed = runInputSchema.safeParse(result.runInput)
    expect(parsed.success).toBe(true)
  })
})

describe('cliParse — model availability (E_MODEL_UNAVAILABLE)', () => {
  it('bare model name without provider prefix → E_MODEL_UNAVAILABLE', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', 'invalidformat'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_MODEL_UNAVAILABLE')
  })

  it('provider/model form → OK', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', 'anthropic/glm-5.2'], cwd }),
    )
    expect(result.runInput.preflightModel).toBe('anthropic/glm-5.2')
  })

  it('provider:model form → OK', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', 'openai:gpt-4o'], cwd }),
    )
    expect(result.runInput.preflightModel).toBe('openai:gpt-4o')
  })

  it('no --preflight-model → OK (smoke-test, no validation)', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.preflightModel).toBeUndefined()
  })

  it('provider/model:tag form (ollama naming, e.g. ollama/qwen3.5:9b) → OK', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', 'ollama/qwen3.5:9b'], cwd }),
    )
    expect(result.runInput.preflightModel).toBe('ollama/qwen3.5:9b')
  })

  it('a second tagged ollama ref (ollama/llama3.1:8b) → OK', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', 'ollama/llama3.1:8b'], cwd }),
    )
    expect(result.runInput.preflightModel).toBe('ollama/llama3.1:8b')
  })

  it.each([
    ['empty model segment (provider/)', 'ollama/'],
    ['empty provider segment (/model)', '/qwen3.5:9b'],
    ['a lone word with no separator', 'qwen3.5'],
    ['whitespace inside the ref', 'ollama /qwen3.5:9b'],
    ['a trailing separator (provider/model:)', 'ollama/qwen3.5:'],
    ['a trailing slash (provider/model/)', 'ollama/qwen3.5/'],
    ['a colon-form ref with an extra tag (provider:model:tag)', 'ollama:qwen3.5:9b'],
  ])('%s → E_MODEL_UNAVAILABLE', async (_label, ref) => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', ref], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_MODEL_UNAVAILABLE')
  })
})

describe('cliParse — --model run-model override', () => {
  it('parses --model a/b into runInput.model', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--model', 'anthropic/claude-x'], cwd }),
    )
    expect(result.runInput.model).toBe('anthropic/claude-x')
  })

  it('parses the --model=a/b inline form', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--model=anthropic/claude-x'], cwd }),
    )
    expect(result.runInput.model).toBe('anthropic/claude-x')
  })

  it('--model with no value → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--model'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--model ollama/qwen3.5:9b (ollama tagged form) → OK, same validator as --preflight-model', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--model', 'ollama/qwen3.5:9b'], cwd }),
    )
    expect(result.runInput.model).toBe('ollama/qwen3.5:9b')
  })

  it('--model nope (no provider prefix) → E_MODEL_UNAVAILABLE', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--model', 'nope'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_MODEL_UNAVAILABLE')
  })

  it('config-file model is accepted and used', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'x', model: 'anthropic/from-config' })
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.model).toBe('anthropic/from-config')
  })

  it('CLI --model overrides the config-file model', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'x', model: 'anthropic/from-config' })
    const result = await runP(
      cliParse({ argv: ['run', '--model', 'anthropic/from-cli'], cwd }),
    )
    expect(result.runInput.model).toBe('anthropic/from-cli')
  })

  it('unset --model leaves runInput.model absent and the RunInput still validates (no regression)', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.model).toBeUndefined()
    const { runInputSchema } = await import('@generated/schemas')
    expect(runInputSchema.safeParse(result.runInput).success).toBe(true)
  })

  it('--preflight-model alone does not set runInput.model (the two flags are independent)', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', 'anthropic/glm-5.2'], cwd }),
    )
    expect(result.runInput.preflightModel).toBe('anthropic/glm-5.2')
    expect(result.runInput.model).toBeUndefined()
  })
})

describe('cliParse — watchdog flag', () => {
  it('default watchdog timeout is 90s', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.timeouts.watchdogSeconds).toBe(90)
  })

  it('--watchdog sets the watchdog timeout', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--watchdog', '120'], cwd }),
    )
    expect(result.runInput.timeouts.watchdogSeconds).toBe(120)
  })

  it('--timeout-watchdog is no longer a known flag → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--timeout-watchdog', '120'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — flags surface', () => {
  it('accepts the full set of value/boolean flags and reflects them on RunInput', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({
        argv: [
          'run', REPO, '--prompt', 'x',
          '--output', '/tmp/out', '--workspace', '/tmp/ws',
          '--opencode-version', '2.0.0', '--preflight-model', 'anthropic/glm-5.2',
          '--pricing-path', '/p.json', '--timeout-install', '42',
          '--auth', 'anthropic', '--auth', 'ssh',
          '--init', 'do setup', '--verify', 'check it', '--judge', 'decide',
          '--timeline-mode', 'tree-diff', '--log-level', 'debug',
          '--no-pure-baseline', '--no-preflight', '--diff-html', '--no-collapse-repeats',
        ],
        cwd,
      }),
    )
    const ri = result.runInput
    expect(ri.outputPath).toBe('/tmp/out')
    expect(ri.workspacePath).toBe('/tmp/ws')
    expect(ri.opencodeVersion).toBe('2.0.0')
    expect(ri.preflightModel).toBe('anthropic/glm-5.2')
    expect(ri.pricingPath).toBe('/p.json')
    expect(ri.timeouts.installSeconds).toBe(42)
    expect(ri.auth.anthropic).toBe(true)
    expect(ri.auth.ssh).toBe(true)
    expect(variantByName(ri, 'old')?.init).toBe('do setup')
    expect(variantByName(ri, 'new')?.init).toBe('do setup')
    expect(ri.verify).toBe('check it')
    expect(ri.judge).toBe('decide')
    expect(ri.timelineMode).toBe('tree-diff')
    expect(ri.logLevel).toBe('debug')
    expect(variantByName(ri, 'old')?.pure).toBe(false)
    expect(ri.preflightEnabled).toBe(false)
    expect(ri.diffHtml).toBe(true)
    expect(ri.collapseRepeats).toBe(false)
    expect(result.outputPathProvided).toBe(true)
  })

  it('outputPathProvided is false when --output is absent (default fallback)', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.outputPathProvided).toBe(false)
    expect(result.runInput.outputPath).toBe('./results')
  })

  it('outputPathProvided is true when outputPath comes from config', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { outputPath: '/from/config' })
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.outputPathProvided).toBe(true)
    expect(result.runInput.outputPath).toBe('/from/config')
  })

  it('supports the --flag=value inline form', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt=x', '--runs=5'], cwd }))
    expect(result.runInput.prompt).toBe('x')
    expect(result.runInput.runs).toBe(5)
  })

  it('rejects a second positional argument', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, 'extra', '--prompt', 'x'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('rejects a value flag with no value', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — dash-prefixed value flags', () => {
  it('a --prompt value starting with "-" parses (only known flag names are rejected as values)', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', '-fix the regression'], cwd }),
    )
    expect(result.runInput.prompt).toBe('-fix the regression')
  })

  it('a value flag followed by another known flag (no value given) still errors', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', '--runs', '3'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('a value flag followed by a known flag in --flag=value form (no value given) still errors', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', '--model=anthropic/claude-x'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — timeout positivity', () => {
  it('--timeout-run=-5 → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--timeout-run=-5'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--timeout-run=0 → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--timeout-run', '0'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('a negative timeout from the config file also errors', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'x', timeouts: { runSeconds: -1 } })
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('a positive --watchdog still works (no regression)', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--watchdog', '30'], cwd }),
    )
    expect(result.runInput.timeouts.watchdogSeconds).toBe(30)
  })
})

describe('cliParse — auth whitelist', () => {
  it('default (no auth flags) → opencode=true, npmrc=true, rest false', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.auth).toEqual({
      opencode: true, npmrc: true, anthropic: false, openai: false,
      gemini: false, aws: false, ssh: false, git: false,
    })
  })

  it('--no-auth-opencode disables only opencode (npmrc stays default-on)', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--no-auth-opencode'], cwd }),
    )
    expect(result.runInput.auth.opencode).toBe(false)
    expect(result.runInput.auth.npmrc).toBe(true)
  })

  it('--no-auth-npmrc disables only npmrc', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--no-auth-npmrc'], cwd }),
    )
    expect(result.runInput.auth.npmrc).toBe(false)
    expect(result.runInput.auth.opencode).toBe(true)
  })

  it('--auth aws enables aws alongside the defaults', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--auth', 'aws'], cwd }))
    expect(result.runInput.auth.aws).toBe(true)
    expect(result.runInput.auth.opencode).toBe(true)
    expect(result.runInput.auth.npmrc).toBe(true)
  })

  it('combines --auth aws with --no-auth-opencode', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({
        argv: ['run', REPO, '--prompt', 'x', '--auth', 'aws', '--no-auth-opencode'],
        cwd,
      }),
    )
    expect(result.runInput.auth.aws).toBe(true)
    expect(result.runInput.auth.opencode).toBe(false)
    expect(result.runInput.auth.npmrc).toBe(true)
  })

  it('config-file auth overrides defaults', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'x', auth: { opencode: false, aws: true } })
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.auth.opencode).toBe(false)
    expect(result.runInput.auth.npmrc).toBe(true)
    expect(result.runInput.auth.aws).toBe(true)
  })

  it('--no-auth-bogus → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--no-auth-bogus'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--auth bogus → E_CONFIG_INVALID (same as --no-auth-bogus, not silently ignored)', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--auth', 'bogus'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — protectGit', () => {
  it('defaults to false', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.protectGit).toBe(false)
  })

  it('--protect-git sets it to true', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--protect-git'], cwd }),
    )
    expect(result.runInput.protectGit).toBe(true)
  })

  it('--no-protect-git sets it to false explicitly', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--no-protect-git'], cwd }),
    )
    expect(result.runInput.protectGit).toBe(false)
  })

  it('config file protectGit:true is honored', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'x', protectGit: true })
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.protectGit).toBe(true)
  })

  it('CLI --no-protect-git overrides a config protectGit:true', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'x', protectGit: true })
    const result = await runP(
      cliParse({ argv: ['run', '--no-protect-git'], cwd }),
    )
    expect(result.runInput.protectGit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// n-way variants
// ---------------------------------------------------------------------------

describe('cliParse — n-way variants: desugaring snapshot', () => {
  it('legacy invocation --pack X --prompt P parses to 2 variants old/new, baseline old, parallel 2, pack registry of 1', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--pack', 'npm:x', '--prompt', 'P'], cwd }),
    )
    const ri = result.runInput
    expect(ri.baseline).toBe('old')
    expect(ri.parallel).toBe(2)
    expect(ri.packs).toHaveLength(1)
    expect(ri.variants).toHaveLength(2)
    expect(ri.variants.map((v) => v.name)).toEqual(['old', 'new'])
    const old = variantByName(ri, 'old') as VariantSpec
    const nw = variantByName(ri, 'new') as VariantSpec
    expect(old.packs).toEqual([])
    expect(old.pure).toBe(true)
    expect(nw.packs).toEqual([ri.packs[0]?.name])
    expect(nw.pure).toBe(false)
  })

  it('--no-pure-baseline sets variants[old].pure === false and legacyShim stays true (behavior-change notice is the pipeline\'s job)', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--no-pure-baseline'], cwd }),
    )
    expect(variantByName(result.runInput, 'old')?.pure).toBe(false)
    expect(result.flagDefaults.legacyShim).toBe(true)
  })

  it('3-variant config parses; order is preserved', async () => {
    const cwd = makeTempDir()
    const fixture = threeVariants()
    await writeConfig(cwd, {
      repoUrl: REPO,
      prompt: fixture.runInput.prompt,
      packs: fixture.runInput.packs,
      variants: fixture.runInput.variants,
      baseline: fixture.runInput.baseline,
    })
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.variants.map((v) => v.name)).toEqual(['base', 'graphify', 'astgrep'])
    expect(result.runInput.baseline).toBe('base')
    expect(result.flagDefaults.legacyShim).toBe(false)
  })

  it('variant.packs bare-ref shorthand registers a pack', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, {
      repoUrl: REPO,
      prompt: 'do it',
      variants: [
        { name: 'base', packs: [] },
        { name: 'x', packs: ['https://example.com/tool.git'] },
      ],
    })
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.packs).toHaveLength(1)
    const registered = result.runInput.packs[0] as { readonly name: string; readonly ref: string }
    expect(registered.ref).toBe('https://example.com/tool.git')
    expect(registered.name).toBe(packShortName('https://example.com/tool.git'))
    expect(variantByName(result.runInput, 'x')?.packs).toEqual([registered.name])
  })

  // Security (D4 bare-ref path): a user pasting a tokenised URL straight
  // onto a variant.packs entry is exactly the route the team lead flagged as
  // most likely — the auto-registered pack's NAME must not carry it either.
  it('variant.packs bare-ref shorthand with a credentialed URL registers a pack whose name has neither the username nor the secret', async () => {
    const cwd = makeTempDir()
    const credentialedRef = 'https://svc-bot:s3cr3t-tok3n@example.com/org/tool.git'
    await writeConfig(cwd, {
      repoUrl: REPO,
      prompt: 'do it',
      variants: [
        { name: 'base', packs: [] },
        { name: 'x', packs: [credentialedRef] },
      ],
    })
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    const registered = result.runInput.packs[0] as { readonly name: string; readonly ref: string }
    expect(registered.name).not.toContain('svc-bot')
    expect(registered.name).not.toContain('s3cr3t-tok3n')
    expect(registered.name).toBe('tool')
    // ref itself is untouched by this phase (still needed to actually clone).
    expect(registered.ref).toBe(credentialedRef)
    expect(variantByName(result.runInput, 'x')?.packs).toEqual([registered.name])
  })
})

describe('cliParse — n-way variants: variant-mode validation matrix', () => {
  const baseVariantConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    repoUrl: REPO,
    prompt: 'do it',
    variants: [
      { name: 'base', packs: [] },
      { name: 'other', packs: [] },
    ],
    ...over,
  })

  it('duplicate variant names → E_CONFIG_INVALID reason duplicate-variant-name', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, {
      repoUrl: REPO,
      prompt: 'x',
      variants: [{ name: 'a', packs: [] }, { name: 'a', packs: [] }],
    })
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('duplicate-variant-name')
    expect(err.context?.['variant']).toBe('a')
  })

  it('invalid variant name (uppercase) → reason invalid-variant-name', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, baseVariantConfig({ variants: [{ name: 'Base', packs: [] }] }))
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('invalid-variant-name')
  })

  it('reserved variant name "source" → reason reserved-variant-name', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, baseVariantConfig({ variants: [{ name: 'source', packs: [] }] }))
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('reserved-variant-name')
  })

  it('unknown baseline → reason unknown-baseline', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, baseVariantConfig({ baseline: 'nope' }))
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('unknown-baseline')
  })

  it('unknown pack ref in allowPacks → reason unknown-pack-ref', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({
        variants: [
          { name: 'base', packs: [], allowPacks: ['ghost-pack'] },
          { name: 'other', packs: [] },
        ],
      }),
    )
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('unknown-pack-ref')
    expect(err.context?.['pack']).toBe('ghost-pack')
  })

  it('pack-name-collision: two different bare refs resolve to the same short name', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({
        variants: [
          { name: 'a', packs: ['https://example.com/x/tool.git'] },
          { name: 'b', packs: ['https://other.example.com/y/tool.git'] },
        ],
      }),
    )
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('pack-name-collision')
  })

  it('multi-pack-stage2 guard: a variant with 2 packs is rejected in Stage 1', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({
        packs: [
          { name: 'p1', ref: 'https://example.com/p1.git' },
          { name: 'p2', ref: 'https://example.com/p2.git' },
        ],
        variants: [{ name: 'multi', packs: ['p1', 'p2'] }],
      }),
    )
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('multi-pack-stage2')
    expect(err.context?.['variant']).toBe('multi')
  })

  it('missing effective prompt on one variant → reason prompt-required naming that variant', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, {
      repoUrl: REPO,
      variants: [
        { name: 'has-prompt', packs: [], prompt: 'do it' },
        { name: 'no-prompt', packs: [] },
      ],
    })
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('prompt-required')
    expect(err.context?.['variant']).toBe('no-prompt')
  })

  it('a global prompt provides an effective fallback for every variant', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, baseVariantConfig())
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.variants.every((v) => effectiveOf(v, result.runInput.prompt, 'prompt'))).toBe(true)
  })

  it('an explicit empty-string variant prompt disables the global fallback → prompt-required', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({ variants: [{ name: 'base', packs: [], prompt: '' }, { name: 'other', packs: [] }] }),
    )
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('prompt-required')
    expect(err.context?.['variant']).toBe('base')
  })

  it('config with variants + --pack fails with legacy-flag-with-variants (key packRef)', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, baseVariantConfig())
    const err = await runFlip(cliParse({ argv: ['run', '--pack', 'npm:x'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('legacy-flag-with-variants')
    expect(err.context?.['key']).toBe('packRef')
  })

  it('config with variants + config-file pureBaseline fails with legacy-flag-with-variants (key pureBaseline)', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, baseVariantConfig({ pureBaseline: false }))
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('legacy-flag-with-variants')
    expect(err.context?.['key']).toBe('pureBaseline')
  })

  it('config with variants + --init-side fails with legacy-flag-with-variants (key initSide)', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, baseVariantConfig())
    const err = await runFlip(cliParse({ argv: ['run', '--init-side', 'new'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('legacy-flag-with-variants')
    expect(err.context?.['key']).toBe('initSide')
  })

  it('config with variants + --pack-hint (legacy alias) fails with legacy-flag-with-variants (key packHint)', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, baseVariantConfig())
    const err = await runFlip(cliParse({ argv: ['run', '--pack-hint', 'x'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('legacy-flag-with-variants')
    expect(err.context?.['key']).toBe('packHint')
  })

  it('config with variants + --hint (new global flag) is ALLOWED — hint is a global default, not variant-shaping', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, baseVariantConfig())
    const result = await runP(cliParse({ argv: ['run', '--hint', 'shared hint'], cwd }))
    expect(result.runInput.hint).toBe('shared hint')
  })

  it('empty variants array → reason no-variants', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, { repoUrl: REPO, prompt: 'x', variants: [] })
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('no-variants')
  })

  it('pack-check-without-preflight generalizes to native mode', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, {
      repoUrl: REPO,
      prompt: 'x',
      preflightEnabled: false,
      packs: [{ name: 'p', ref: 'https://example.com/p.git', check: 'p --version' }],
      variants: [{ name: 'base', packs: [] }, { name: 'p-variant', packs: ['p'] }],
    })
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('pack-check-without-preflight')
  })

  // B1 (security/containment): pack names become a `pack/<name>/` path
  // segment downstream with no containment guard there — phase 00 is the
  // single validation point.
  it('a config-declared pack name of "../x" is rejected as invalid-pack-name', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({
        packs: [{ name: '../x', ref: 'https://example.com/p.git' }],
        variants: [{ name: 'base', packs: ['../x'] }],
      }),
    )
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('invalid-pack-name')
    expect(err.context?.['pack']).toBe('../x')
  })

  it('a D4 bare-ref that resolves to ".." via packShortName is rejected as invalid-pack-name', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({
        variants: [{ name: 'base', packs: ['https://example.com/foo/..'] }],
      }),
    )
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('invalid-pack-name')
    expect(err.context?.['pack']).toBe('..')
  })

  // N5: two DIFFERENT explicit registry entries sharing a name are unrelated
  // to D4 bare-ref sharing (which reuses/collides by design) — reject them,
  // since packsOf (Map, last-wins) and the bare-ref resolver (.find,
  // first-wins) would otherwise silently disagree on which ref applies.
  it('duplicate pack names in the top-level registry are rejected as duplicate-pack-name', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({
        packs: [
          { name: 'x', ref: 'https://example.com/a.git' },
          { name: 'x', ref: 'https://example.com/b.git' },
        ],
        variants: [{ name: 'base', packs: ['x'] }],
      }),
    )
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('duplicate-pack-name')
    expect(err.context?.['pack']).toBe('x')
  })

  // N1: variant.exercise is the native-mode equivalent of --pack-exercise,
  // and needs the same "requires a pack somewhere" guard the legacy flag
  // already has.
  it('variant.exercise with no pack on the variant AND no pack anywhere in the run → pack-setup-without-pack', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({
        variants: [{ name: 'base', packs: [], exercise: 'run the pack pipeline' }],
      }),
    )
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('pack-setup-without-pack')
    expect(err.context?.['variant']).toBe('base')
  })

  it('variant.exercise is fine when the run has a pack ANYWHERE, even if this variant declares none itself', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({
        packs: [{ name: 'p', ref: 'https://example.com/p.git' }],
        variants: [
          { name: 'base', packs: [], exercise: 'run the pack pipeline' },
          { name: 'other', packs: ['p'] },
        ],
      }),
    )
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.variants.find((v) => v.name === 'base')?.exercise).toBe('run the pack pipeline')
  })

  it('variant.exercise is fine when the variant itself declares a pack', async () => {
    const cwd = makeTempDir()
    await writeConfig(
      cwd,
      baseVariantConfig({
        packs: [{ name: 'p', ref: 'https://example.com/p.git' }],
        variants: [{ name: 'base', packs: ['p'], exercise: 'run the pack pipeline' }],
      }),
    )
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.variants[0]?.exercise).toBe('run the pack pipeline')
  })
})

describe('cliParse — n-way variants: --parallel / --baseline', () => {
  it('default parallel is 2', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.parallel).toBe(2)
  })

  it('--parallel sets runInput.parallel and flagDefaults.parallel', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--parallel', '5'], cwd }))
    expect(result.runInput.parallel).toBe(5)
    expect(result.flagDefaults.parallel).toBe(5)
  })

  it('--parallel 0 → E_CONFIG_INVALID reason parallel-min', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--parallel', '0'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('parallel-min')
  })

  it('--parallel non-integer → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--parallel', 'abc'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--baseline overrides the shim\'s default baseline in legacy mode', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:x', '--baseline', 'new'], cwd }),
    )
    expect(result.runInput.baseline).toBe('new')
  })

  it('--baseline overrides variants[0] as the default baseline in variant mode', async () => {
    const cwd = makeTempDir()
    const fixture = threeVariants()
    await writeConfig(cwd, {
      repoUrl: REPO,
      prompt: fixture.runInput.prompt,
      packs: fixture.runInput.packs,
      variants: fixture.runInput.variants,
    })
    const result = await runP(cliParse({ argv: ['run', '--baseline', 'graphify'], cwd }))
    expect(result.runInput.baseline).toBe('graphify')
  })
})

describe('cliParse — n-way variants: mixed-mode rejection is symmetric (config key or CLI flag)', () => {
  it('a variant-shaping key set only in config (no CLI flag) still triggers legacy-flag-with-variants', async () => {
    const cwd = makeTempDir()
    await writeConfig(cwd, {
      repoUrl: REPO,
      prompt: 'x',
      variants: [{ name: 'a', packs: [] }],
      packSetup: 'setup-cmd',
    })
    const err = await runFlip(cliParse({ argv: ['run'], cwd }))
    expect(err.code).toBe('E_CONFIG_INVALID')
    expect(err.context?.['reason']).toBe('legacy-flag-with-variants')
    expect(err.context?.['key']).toBe('packSetup')
  })

  it('legacy mode (no variants key) is unaffected by the mixing guard', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:x', '--pure-baseline'], cwd }),
    )
    expect(result.runInput.variants.map((v) => v.name)).toEqual(['old', 'new'])
  })
})

// ---------------------------------------------------------------------------
// Shared conveniences — other packages import these from 00-cli-parse.ts
// ---------------------------------------------------------------------------

describe('shared helpers — VARIANT_NAME_RE / RESERVED_VARIANT_NAMES', () => {
  it.each(['old', 'new', 'a', 'variant-1', 'x'.repeat(32)])('%s is a valid variant name', (name) => {
    expect(VARIANT_NAME_RE.test(name)).toBe(true)
  })

  it.each(['Old', '-old', 'has_underscore', '', 'x'.repeat(33)])('%s is NOT a valid variant name', (name) => {
    expect(VARIANT_NAME_RE.test(name)).toBe(false)
  })

  // N3: pins the regex against traversal/injection/homoglyph shapes so a
  // future charset loosening (e.g. "allow dots for npm-style names") cannot
  // silently widen the variant-name surface — variant names land directly in
  // filesystem paths and opencode sessionIds, unlike pack names (B1, which
  // has its own separate, slightly wider PACK_NAME_SAFE_RE).
  it.each([
    ['path traversal', '../x'],
    ['forward slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['single dot', '.'],
    ['double dot', '..'],
    ['embedded dot', 'a.b'],
    ['embedded space', 'a b'],
    ['leading tab', '\told'],
    ['shell variable expansion', '$HOME'],
    ['shell command injection', 'a;rm -rf /'],
    ['backtick command substitution', 'a`whoami`b'],
    ['Cyrillic homoglyph о (U+043E) for Latin o', 'оld'],
    ['fullwidth homoglyph ｏ (U+FF4F) for Latin o', 'ｏld'],
  ])('%s (%j) is NOT a valid variant name', (_label, name) => {
    expect(VARIANT_NAME_RE.test(name)).toBe(false)
  })

  it('"source" is reserved', () => {
    expect(RESERVED_VARIANT_NAMES.has('source')).toBe(true)
  })
})

describe('shared helpers — packShortName', () => {
  it('strips npm: prefix', () => {
    expect(packShortName('npm:my-plugin')).toBe('my-plugin')
  })

  it('strips a trailing .git and takes the last path segment', () => {
    expect(packShortName('https://example.com/org/tool.git')).toBe('tool')
  })

  it('strips the mcp:name:config payload down to the name', () => {
    expect(packShortName('mcp:myserver:{"env":{}}')).toBe('myserver')
  })

  it('lowercases the result', () => {
    expect(packShortName('npm:MyTool')).toBe('mytool')
  })

  // Security: the derived NAME (unlike `ref`) is a disclosed identifier — it
  // lands in manifest/report provenance and the judge prompt, none of which
  // redact `ref` themselves. A credential in the ref must never survive into
  // the name.
  it('a URL with userinfo (user:token@host) never leaks the credential into the name', () => {
    const name = packShortName('https://user:s3cr3t@example.com/org/tool.git')
    expect(name).not.toContain('user')
    expect(name).not.toContain('s3cr3t')
    expect(name).toBe('tool')
  })

  it('a bare host URL with userinfo and no path still redacts (falls back to the host, not the credential)', () => {
    const name = packShortName('https://user:s3cr3t@example.com')
    expect(name).not.toContain('user')
    expect(name).not.toContain('s3cr3t')
    expect(name).toBe('example.com')
  })

  it('a ref with no http(s)/ssh/git:// scheme (e.g. a scoped npm name) is unaffected by the redaction pass', () => {
    // redactUrlCredentials only matches the http(s)/ssh/git:// scheme form —
    // confirms the fix does not corrupt refs that were never a leak vector.
    expect(packShortName('npm:@scope/my-tool')).toBe('my-tool')
  })
})

describe('shared helpers — effectiveOf', () => {
  const variant = (over: Partial<VariantSpec> = {}): VariantSpec => ({ name: 'v', packs: [], ...over })

  it('falls back to the global when the variant has no own value', () => {
    expect(effectiveOf(variant(), 'global text', 'prompt')).toBe('global text')
  })

  it("the variant's own value wins over the global", () => {
    expect(effectiveOf(variant({ prompt: 'own text' }), 'global text', 'prompt')).toBe('own text')
  })

  it('an explicit empty string on the variant DISABLES the global — returns undefined, not "" and not the global (D7)', () => {
    expect(effectiveOf(variant({ hint: '' }), 'global hint', 'hint')).toBeUndefined()
  })

  it('undefined global + undefined own → undefined', () => {
    expect(effectiveOf(variant(), undefined, 'verify')).toBeUndefined()
  })

  // D7 arbitration: an explicit '' must disable the global outright, never
  // fall back to it — every consumer (WP4's `?? sourceConnectivity.model`,
  // WP6's own-field checks) relies on this exact 3-way branching.
  const allKeys = ['prompt', 'init', 'hint', 'verify', 'model'] as const
  allKeys.forEach((key) => {
    describe(`key: ${key}`, () => {
      it('own undefined → returns the global', () => {
        expect(effectiveOf(variant(), 'global value', key)).toBe('global value')
      })

      it('own set (non-empty) → returns the own value, global ignored', () => {
        expect(effectiveOf(variant({ [key]: 'own value' }), 'global value', key)).toBe('own value')
      })

      it('own explicit "" → returns undefined, NOT the global and NOT ""', () => {
        const result = effectiveOf(variant({ [key]: '' }), 'global value', key)
        expect(result).toBeUndefined()
        expect(result).not.toBe('')
        expect(result).not.toBe('global value')
      })

      it('own explicit "" with an undefined global → still undefined', () => {
        expect(effectiveOf(variant({ [key]: '' }), undefined, key)).toBeUndefined()
      })
    })
  })
})

describe('shared helpers — packsOf / foreignPacksOf / baselineOf', () => {
  const fixture = threeVariants()
  const ri = fixture.runInput

  it('packsOf resolves variant.packs name references to PackSpec objects', () => {
    const graphify = variantByName(ri, 'graphify') as VariantSpec
    const resolved = packsOf(ri, graphify)
    expect(resolved.map((p) => p.name)).toEqual(['graphify'])
  })

  it('packsOf returns [] for a variant with no packs', () => {
    const base = variantByName(ri, 'base') as VariantSpec
    expect(packsOf(ri, base)).toEqual([])
  })

  it("foreignPacksOf returns every OTHER variant's packs, excluding this variant's own", () => {
    const graphify = variantByName(ri, 'graphify') as VariantSpec
    const foreign = foreignPacksOf(ri, graphify)
    expect(foreign.map((p) => p.name)).toEqual(['astgrep'])
  })

  it("foreignPacksOf for the baseline (no packs of its own) sees every other variant's packs", () => {
    const base = variantByName(ri, 'base') as VariantSpec
    const foreign = foreignPacksOf(ri, base)
    expect(foreign.map((p) => p.name).sort()).toEqual(['astgrep', 'graphify'])
  })

  it('baselineOf returns the VariantSpec named by runInput.baseline', () => {
    expect(baselineOf(ri).name).toBe('base')
  })

  it('baselineOf throws for a RunInput whose baseline names no variant (should never happen post-validation)', () => {
    expect(() => baselineOf({ ...ri, baseline: 'ghost' })).toThrow()
  })
})
