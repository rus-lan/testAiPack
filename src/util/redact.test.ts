import { describe, it, expect } from 'vitest'
import { redactUrlCredentials } from './redact.js'

describe('redactUrlCredentials', () => {
  it('strips user:pass@ from an https URL', () => {
    expect(redactUrlCredentials('https://user:sk-fake-token@example.invalid/repo.git')).toBe(
      'https://example.invalid/repo.git',
    )
  })

  it('strips user@ (no password) from an https URL', () => {
    expect(redactUrlCredentials('https://user@example.invalid/repo.git')).toBe(
      'https://example.invalid/repo.git',
    )
  })

  it('strips credentials from a URL embedded inside a larger message', () => {
    const stderr =
      "fatal: unable to access 'https://user:sk-fake-token@example.invalid/repo.git/': The requested URL returned error: 403"
    expect(redactUrlCredentials(stderr)).toBe(
      "fatal: unable to access 'https://example.invalid/repo.git/': The requested URL returned error: 403",
    )
  })

  it('strips credentials from an ssh:// URL', () => {
    expect(redactUrlCredentials('ssh://user:sk-fake-token@example.invalid:22/repo.git')).toBe(
      'ssh://example.invalid:22/repo.git',
    )
  })

  it('strips every match when multiple credentialed URLs appear', () => {
    const text = 'multiple: https://a:b@x.invalid/1.git and https://c:d@y.invalid/2.git both failed'
    expect(redactUrlCredentials(text)).toBe('multiple: https://x.invalid/1.git and https://y.invalid/2.git both failed')
  })

  it('leaves a URL with no credentials unchanged', () => {
    expect(redactUrlCredentials('https://example.invalid/repo.git')).toBe(
      'https://example.invalid/repo.git',
    )
  })

  it('leaves an scp-style git@host:path ref unchanged (no url scheme, no password slot)', () => {
    expect(redactUrlCredentials('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git')
  })

  it('leaves a bare email mention unchanged (no scheme prefix)', () => {
    expect(redactUrlCredentials('contact git@example.com for help')).toBe('contact git@example.com for help')
  })

  it('leaves text with no URL unchanged', () => {
    expect(redactUrlCredentials('no url here at all')).toBe('no url here at all')
  })
})
