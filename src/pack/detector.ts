import { Data, Effect } from 'effect'
import type { PackType } from '@generated/types'
import { redactUrlCredentials } from '../util/redact.js'

export type PackSource = 'git' | 'npm' | 'local' | 'inline'

export interface PackRef {
  readonly raw: string
  readonly type: PackType
  readonly source: PackSource
  readonly name: string
  readonly url?: string
  readonly path?: string
  /**
   * Raw MCP config payload for `mcp:` refs. Either an inline JSON string or an
   * `@<path>` reference to a config file. Absent when only `mcp:<name>` is
   * given (phase 03 then falls back to standard file locations).
   */
  readonly config?: string
}

export class PackDetectError extends Data.TaggedError('PackDetectError')<{
  readonly ref: string
  readonly reason: string
}> {}

/**
 * A version of a pack ref safe to put into an error message or log context.
 * An inline `mcp:<name>:<config>` ref's payload can carry provider secrets in
 * its `env` block, so it is truncated to the `mcp:<name>` prefix. Every other
 * ref shape (URL, local path, plugin name) has no comparable payload, but a
 * git URL can still carry `user:token@host` credentials, so those go through
 * `redactUrlCredentials` instead of passing through unchanged.
 */
export const safeRefDisplay = (ref: string): string => {
  const trimmed = ref.trim()
  if (!trimmed.startsWith('mcp:')) return redactUrlCredentials(ref)
  const rest = trimmed.slice('mcp:'.length)
  const colonIdx = rest.indexOf(':')
  return colonIdx === -1 ? trimmed : `mcp:${rest.slice(0, colonIdx)}`
}

const GIT_URL_RE = /^(https?|git\+https?|git\+ssh|ssh|git):\/\/[^\s]+(?:\.git)?$/
const GIT_SCP_RE = /^git@[^@\s]+:[^@\s/]+\/[^@\s]+(?:\.git)?$/
const GITHUB_SHORT_RE = /^github:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/
const NPM_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/

const isGitUrl = (s: string): boolean =>
  GIT_URL_RE.test(s) || GIT_SCP_RE.test(s) || GITHUB_SHORT_RE.test(s)

const isLocalPath = (s: string): boolean =>
  s.startsWith('/') ||
  s.startsWith('./') ||
  s.startsWith('../') ||
  s.startsWith('~/')

const baseName = (s: string): string => {
  const clean = s.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = clean.split('/')
  const last = parts[parts.length - 1] ?? clean
  return last === '' ? clean : last
}

const normalizeGitUrl = (s: string): { readonly url: string; readonly name: string } => {
  const githubMatch = GITHUB_SHORT_RE.exec(s)
  if (githubMatch !== null) {
    const owner = githubMatch[1] ?? ''
    const repo = githubMatch[2] ?? ''
    return { url: `https://github.com/${owner}/${repo}.git`, name: repo }
  }
  // git rejects the npm-style "git+" prefix as an unknown remote helper.
  const url = s.replace(/^git\+/, '')
  return { url, name: baseName(s) }
}

interface Detected {
  readonly type: PackType
  readonly source: PackSource
  readonly name: string
  readonly url?: string
  readonly path?: string
  readonly config?: string
}

const detectGitLike = (s: string): Detected => {
  const { url, name } = normalizeGitUrl(s)
  return { type: 'skill', source: 'git', name, url }
}

const detectLocal = (s: string): Detected => ({
  type: 'skill',
  source: 'local',
  name: baseName(s),
  path: s,
})

const detectPrefixed = (prefix: string, ref: string): Detected => {
  const inner = ref.slice(prefix.length)
  if (isGitUrl(inner)) {
    const { url, name } = normalizeGitUrl(inner)
    const type: PackType = prefix === 'agent:' ? 'agent' : 'command'
    return { type, source: 'git', name, url }
  }
  if (isLocalPath(inner)) {
    const type: PackType = prefix === 'agent:' ? 'agent' : 'command'
    return { type, source: 'local', name: baseName(inner), path: inner }
  }
  throw new PackDetectError({
    ref,
    reason: `${prefix} target must be a git url or a local path`,
  })
}

const detectInner = (ref: string): Detected => {
  if (ref.startsWith('npm:')) {
    return { type: 'plugin', source: 'npm', name: ref.slice('npm:'.length) }
  }
  if (ref.startsWith('mcp:')) {
    const rest = ref.slice('mcp:'.length)
    const colonIdx = rest.indexOf(':')
    if (colonIdx === -1) {
      return { type: 'mcp', source: 'inline', name: rest }
    }
    const name = rest.slice(0, colonIdx)
    const config = rest.slice(colonIdx + 1)
    if (name === '') {
      throw new PackDetectError({ ref, reason: 'mcp pack name must not be empty' })
    }
    if (config === '') {
      throw new PackDetectError({ ref, reason: 'mcp config payload must not be empty' })
    }
    return { type: 'mcp', source: 'inline', name, config }
  }
  if (ref.startsWith('agent:') || ref.startsWith('command:')) {
    const prefix = ref.startsWith('agent:') ? 'agent:' : 'command:'
    return detectPrefixed(prefix, ref)
  }
  if (isGitUrl(ref)) return detectGitLike(ref)
  if (isLocalPath(ref)) return detectLocal(ref)
  if (NPM_NAME_RE.test(ref)) {
    return { type: 'plugin', source: 'npm', name: ref }
  }
  throw new PackDetectError({ ref, reason: 'unrecognized pack reference format' })
}

export const detectPack = (ref: string): Effect.Effect<PackRef, PackDetectError> =>
  Effect.gen(function* () {
    const trimmed = ref.trim()
    if (trimmed === '') {
      yield* Effect.fail(
        new PackDetectError({ ref, reason: 'pack reference must not be empty' }),
      )
    }
    const detected = yield* Effect.try({
      try: () => detectInner(trimmed),
      catch: (e) =>
        e instanceof PackDetectError
          ? e
          : new PackDetectError({ ref, reason: 'unexpected detection failure', ...(e === undefined ? {} : { cause: e }) }),
    })
    const { type, source, name, url, path: localPath, config } = detected
    // npm names never become a directory segment (installPlugin passes them
    // straight to `opencode plugin <name>`), so scoped names (`@scope/name`)
    // stay valid there; every other source must resolve to one safe segment.
    const nameIsSafe = source === 'npm' ? NPM_NAME_RE.test(name) : SAFE_NAME_RE.test(name) && name !== '.' && name !== '..'
    if (!nameIsSafe) {
      yield* Effect.fail(
        new PackDetectError({
          ref,
          reason: `pack name must be a single safe path segment, got: ${name}`,
        }),
      )
    }
    return {
      raw: ref,
      type,
      source,
      name,
      ...(url === undefined ? {} : { url }),
      ...(localPath === undefined ? {} : { path: localPath }),
      ...(config === undefined ? {} : { config }),
    }
  })
