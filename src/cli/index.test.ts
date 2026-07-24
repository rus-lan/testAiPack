import { describe, it, expect, afterEach, vi } from 'vitest'
import pkg from '../../package.json' with { type: 'json' }
import { runCli } from './index.js'

const captureStdout = (): { readonly text: () => string } => {
  const chunks: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  })
  return { text: () => chunks.join('') }
}

describe('cli/index — runCli --version', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('--version prints "testaipack <version>" and exits 0', async () => {
    const out = captureStdout()
    const code = await runCli(['--version'])
    expect(code).toBe(0)
    expect(out.text()).toBe(`testaipack ${pkg.version}\n`)
  })

  it('-v (single top-level arg) prints the version', async () => {
    const out = captureStdout()
    const code = await runCli(['-v'])
    expect(code).toBe(0)
    expect(out.text()).toContain(pkg.version)
  })

  it('run --version is handled early (does not reach the phase-00 proxy)', async () => {
    const out = captureStdout()
    const code = await runCli(['run', '--version'])
    expect(code).toBe(0)
    expect(out.text()).toBe(`testaipack ${pkg.version}\n`)
  })
})
