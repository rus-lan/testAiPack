/**
 * Strips the userinfo component (`user:pass@` / `user@`) from any
 * `http(s)/ssh/git` URL found in a string — including one embedded inside a
 * larger message, e.g. a `git` CLI stderr line quoting the URL it tried. A
 * URL of the form `https://user:token@host/repo.git` carries the credential
 * directly, and `git` echoes that same URL back on failure, so both the URL
 * given to `git` and its stderr must be run through this before either
 * enters a log or error message.
 */
const URL_USERINFO_RE = /((?:https?|ssh|git):\/\/)[^/@\s]+@/gi

export const redactUrlCredentials = (text: string): string => text.replace(URL_USERINFO_RE, '$1')

/**
 * An opencode config object (`OPENCODE_CONFIG_CONTENT`, and the on-disk
 * `.config/opencode/opencode.json` merge layer) carries real provider API
 * keys (`provider.<id>.options.apiKey`) and mcp server secrets (`env`
 * blocks, `headers.Authorization`, a `url` with embedded userinfo) in plain
 * text — it has to, that exact value is what opencode uses to authenticate.
 * Once the same object is written to disk purely for a human to read, the
 * credential VALUES must not appear in the file; the key name is kept so a
 * reader can still see which credentials were configured.
 *
 * Two passes, both structural rather than a value-pattern secret scanner:
 * - key-name match: walks every plain object (including inside arrays) and
 *   replaces the value of any key whose name looks credential-shaped,
 *   regardless of where in the tree it sits — covers "nested and
 *   unknown-key" mcp/provider shapes without hardcoding a fixed field list;
 * - every string value that survives that (i.e. sits under a non-credential
 *   key) is also run through `redactUrlCredentials`, since a secret can
 *   arrive as `user:token@host` inside a URL under an innocuous key like
 *   `url`/`endpoint`, not just as a keyed credential field.
 *
 * Known gaps, stated plainly rather than silently: neither pass inspects
 * array elements for a secret passed positionally (e.g. `args: ["--token",
 * "sk-..."]`) — every secret testaipack's own config building puts into a
 * keyed `env`/`options`/`url` value, so that gap has no observed case. And
 * the key-name match is a maintained vocabulary (`CREDENTIAL_TOKENS` plus
 * the key/pat suffix families below), not an exhaustive detector — a
 * credential under a name outside that vocabulary (a proprietary vendor
 * abbreviation this list has never seen) will not be redacted. Extend the
 * vocabulary when a new shape is found rather than assuming coverage.
 */
const tokenizeKey = (key: string): readonly string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '')

/** Bare/compound "key" tokens are credential-shaped UNLESS they spell "public key" — an asymmetric public key is meant to be public. */
const isKeyToken = (token: string, index: number, tokens: readonly string[]): boolean =>
  (token === 'key' || token === 'keys' || token.endsWith('key') || token.endsWith('keys')) &&
  token !== 'publickey' &&
  token !== 'publickeys' &&
  !((token === 'key' || token === 'keys') && tokens[index - 1] === 'public')

const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set([
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd',
  'credential', 'credentials', 'authorization', 'bearer',
  // GitHub/GitLab/Azure DevOps "personal access token" family — the spelled-out
  // form already matches via the bare "token" entry above, this covers the
  // bare abbreviation (GITHUB_PAT, PAT) that name contains none of those words.
  'pat', 'pats',
])

const isCredentialKeyName = (key: string): boolean => {
  const tokens = tokenizeKey(key)
  return tokens.some((t, i) => CREDENTIAL_TOKENS.has(t) || isKeyToken(t, i, tokens))
}

const REDACTED_VALUE = '[REDACTED]'

export const redactConfigSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactConfigSecrets)
  if (typeof value === 'string') return redactUrlCredentials(value)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      isCredentialKeyName(key) ? REDACTED_VALUE : redactConfigSecrets(v),
    ]),
  )
}

/**
 * Same redaction, for call sites that hold the config as `OPENCODE_CONFIG_CONTENT`
 * text rather than a parsed object (re-serialized with the same `JSON.stringify(_, null, 2)`
 * + trailing newline convention every writer of these files already uses, so
 * a config with nothing to redact round-trips byte-identical). Unparseable
 * input never writes the original text back out — it is replaced with a
 * placeholder so a malformed value can't accidentally carry a secret to disk.
 */
export const redactConfigJsonText = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as unknown
    return `${JSON.stringify(redactConfigSecrets(parsed), null, 2)}\n`
  } catch {
    return '{"error":"could not parse config for redaction"}\n'
  }
}
