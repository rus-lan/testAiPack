import { describe, it, expect } from 'vitest'
import { redactConfigJsonText, redactConfigSecrets, redactUrlCredentials } from './redact.js'

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

describe('redactConfigSecrets', () => {
  it('redacts an apiKey nested in a provider options block, keeps the key visible', () => {
    const cfg = {
      provider: {
        anthropic: {
          npm: '@ai-sdk/anthropic',
          options: { apiKey: 'sk-ant-real-secret' },
        },
      },
    }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.provider.anthropic.options.apiKey).toBe('[REDACTED]')
    expect(out.provider.anthropic.npm).toBe('@ai-sdk/anthropic')
    expect(JSON.stringify(out)).not.toContain('sk-ant-real-secret')
  })

  it('redacts a token in an mcp server env block, keeps unrelated env vars', () => {
    const cfg = {
      mcp: {
        myserver: {
          command: 'npx',
          args: ['-y', 'myserver'],
          env: { API_TOKEN: 'super-secret-value', LOG_LEVEL: 'debug' },
        },
      },
    }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.mcp.myserver.env.API_TOKEN).toBe('[REDACTED]')
    expect(out.mcp.myserver.env.LOG_LEVEL).toBe('debug')
    expect(out.mcp.myserver.command).toBe('npx')
    expect(out.mcp.myserver.args).toEqual(['-y', 'myserver'])
  })

  it('redacts an Authorization header regardless of exact casing/spelling', () => {
    const cfg = { mcp: { remote: { headers: { Authorization: 'Bearer sk-live-abc' } } } }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.mcp.remote.headers.Authorization).toBe('[REDACTED]')
  })

  it('redacts an unknown/arbitrary key name that still looks credential-shaped', () => {
    const cfg = { mcp: { srv: { env: { MY_CUSTOM_CLIENT_SECRET: 'x' } } } }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.mcp.srv.env.MY_CUSTOM_CLIENT_SECRET).toBe('[REDACTED]')
  })

  it('redacts bare <VENDOR>_KEY shapes with no api/access qualifier', () => {
    const cfg = { mcp: { srv: { env: { OPENAI_KEY: 'k1', ANTHROPIC_KEY: 'k2', GEMINI_KEY: 'k3' } } } }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.mcp.srv.env.OPENAI_KEY).toBe('[REDACTED]')
    expect(out.mcp.srv.env.ANTHROPIC_KEY).toBe('[REDACTED]')
    expect(out.mcp.srv.env.GEMINI_KEY).toBe('[REDACTED]')
  })

  it('redacts a bare PAT / GITHUB_PAT (personal access token) abbreviation', () => {
    const cfg = { mcp: { srv: { env: { PAT: 'ghp_real1', GITHUB_PAT: 'ghp_real2', GITLAB_PAT: 'glpat_real3' } } } }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.mcp.srv.env.PAT).toBe('[REDACTED]')
    expect(out.mcp.srv.env.GITHUB_PAT).toBe('[REDACTED]')
    expect(out.mcp.srv.env.GITLAB_PAT).toBe('[REDACTED]')
  })

  it('does not redact words merely containing "pat" as a substring (compat, pattern)', () => {
    const cfg = { settings: { compat: 'v1', compatMode: true, pattern: '*.ts' } }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.settings.compat).toBe('v1')
    expect(out.settings.compatMode).toBe(true)
    expect(out.settings.pattern).toBe('*.ts')
  })

  it('strips embedded userinfo credentials from a URL string value under a non-credential key', () => {
    const cfg = { mcp: { remote: { url: 'https://user:token@host/sse' } } }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.mcp.remote.url).toBe('https://host/sse')
    expect(JSON.stringify(out)).not.toContain('user:token')
  })

  it('does not redact "keyboard" — a word merely containing "key" is not a credential field', () => {
    const cfg = { settings: { keyboard: 'qwerty' } }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.settings.keyboard).toBe('qwerty')
  })

  it('does not redact "public_key" / "publicKey" — asymmetric public keys are meant to be public', () => {
    const cfg = { auth: { public_key: 'ssh-ed25519 AAAA...', publicKey: 'ssh-ed25519 AAAA...' } }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.auth.public_key).toBe('ssh-ed25519 AAAA...')
    expect(out.auth.publicKey).toBe('ssh-ed25519 AAAA...')
  })

  it('still redacts "private_key" alongside the public_key exception', () => {
    const cfg = { auth: { public_key: 'pub', private_key: 'priv-real-secret' } }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.auth.public_key).toBe('pub')
    expect(out.auth.private_key).toBe('[REDACTED]')
  })

  it('recurses into objects nested inside arrays', () => {
    const cfg = { list: [{ password: 'p1' }, { name: 'ok' }] }
    const out = redactConfigSecrets(cfg) as typeof cfg
    expect(out.list[0]?.password).toBe('[REDACTED]')
    expect(out.list[1]?.name).toBe('ok')
  })

  it('leaves a config with no credential-shaped keys byte-identical', () => {
    const cfg = { $schema: 'x', model: 'ollama/qwen', agent: { build: { mode: 'primary' } } }
    expect(redactConfigSecrets(cfg)).toEqual(cfg)
  })

  it('leaves non-object primitives and null untouched', () => {
    expect(redactConfigSecrets('x')).toBe('x')
    expect(redactConfigSecrets(5)).toBe(5)
    expect(redactConfigSecrets(null)).toBe(null)
    expect(redactConfigSecrets(undefined)).toBe(undefined)
  })
})

describe('redactConfigJsonText', () => {
  it('round-trips valid JSON with matching keys redacted, 2-space indent + trailing newline', () => {
    const raw = JSON.stringify({ provider: { p: { options: { apiKey: 'secret' } } } }, null, 2)
    const out = redactConfigJsonText(raw)
    expect(out.endsWith('\n')).toBe(true)
    expect(out).not.toContain('secret')
    expect(JSON.parse(out)).toEqual({ provider: { p: { options: { apiKey: '[REDACTED]' } } } })
  })

  it('is byte-identical to JSON.stringify(_, null, 2) + "\\n" when nothing needs redacting', () => {
    const obj = { $schema: 'x', model: 'ollama/qwen' }
    const raw = JSON.stringify(obj, null, 2)
    expect(redactConfigJsonText(raw)).toBe(`${raw}\n`)
  })

  it('never throws and never echoes the original text back on unparseable input', () => {
    const out = redactConfigJsonText('{not valid json, has a fake "apiKey": "leak-me"')
    expect(out).not.toContain('leak-me')
    expect(() => {
      JSON.parse(out)
    }).not.toThrow()
  })
})
