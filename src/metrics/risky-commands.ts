/**
 * Metrics: risky commands — flags dangerous shell commands found in a run's
 * bash tool calls.
 *
 * Scope: matches literal text of the bash tool's `input.command` only —
 * obfuscated (e.g. base64-encoded) commands and destructive `write`/`edit`
 * tool calls are out of scope. The real risk here is UNDER-detection, not
 * over-flagging: a check that requires strict word order, token adjacency,
 * or one specific flag spelling misses the same effect reached through a
 * wrapper (`sudo …`, `find … -exec rm -rf {} +`, `bash -c "rm -rf /"`), an
 * env-var prefix (`FOO=1 rm -rf x`), or a reordered/differently-spelled flag
 * or keyword (`chmod 777 -R`, `chmod -R 0777`, `chmod -R a+rwx`,
 * `git push origin +main`, `git push --force-with-lease`, `DROP SCHEMA`).
 * Detection runs per segment of the
 * command (split on `;`, `&&`, `||`, `|`, and newlines) so a risky step
 * buried inside a longer script or pipeline is still caught, and a mention
 * of a pattern inside quoted text (`echo "never run rm -rf here"`) is
 * flagged the same as a real invocation — the report shows the full command
 * so a human can dismiss it.
 */

const SEGMENT_RE = /[;&|\n]+/

const splitSegments = (command: string): readonly string[] =>
  command
    .split(SEGMENT_RE)
    .map((s) => s.trim())
    .filter((s) => s !== '')

const stripQuotes = (t: string): string => t.replace(/^['"]+|['"]+$/g, '')

const tokenize = (segment: string): readonly string[] =>
  segment
    .split(/\s+/)
    .map(stripQuotes)
    .filter((t) => t !== '')

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIX_WORDS = new Set(['sudo', 'exec', 'nice', 'nohup'])

/** Drops leading `sudo`/`exec`/… wrappers and `VAR=value` env assignments. */
const skipPrefix = (tokens: readonly string[]): readonly string[] => {
  const [head, ...rest] = tokens
  if (head !== undefined && (PREFIX_WORDS.has(head) || ENV_ASSIGN_RE.test(head))) {
    return skipPrefix(rest)
  }
  return tokens
}

/** Short-flag letters (from single-dash tokens only) present anywhere in `tokens`. */
const shortFlagLetters = (tokens: readonly string[]): string =>
  tokens
    .filter((t) => t.startsWith('-') && !t.startsWith('--'))
    .map((t) => t.slice(1))
    .join('')

/** True when a real flag token (not a substring of a filename/branch name) matches. */
const hasFlag = (tokens: readonly string[], short: string, long: string): boolean =>
  shortFlagLetters(tokens).includes(short) || tokens.includes(long)

const RM_TOKEN_RE = /^(?:.*\/)?rm$/

/**
 * `rm`'s recursive flag accepts either case (`-r`/`-R`); force is lowercase
 * only (`-f`, no `-F`) — the one place a flag check needs per-letter case
 * rules instead of `hasFlag`'s exact match.
 */
const isRiskyRmSegment = (tokens: readonly string[]): boolean => {
  const rmIdx = tokens.findIndex((t) => RM_TOKEN_RE.test(t))
  if (rmIdx === -1) return false
  const rest = tokens.slice(rmIdx + 1)
  const letters = shortFlagLetters(rest)
  const hasR = /[rR]/.test(letters) || rest.includes('--recursive')
  const hasF = letters.includes('f') || rest.includes('--force')
  return hasR && hasF
}

/**
 * Force-push forms: `-f`/`--force`, `--force-with-lease`/`--force-if-includes`
 * (both prefixed `--force-`), or a `+refspec` (the plus-prefix shorthand for
 * "force this ref", e.g. `git push origin +main`).
 */
const isForcePush = (rest: readonly string[]): boolean =>
  hasFlag(rest, 'f', '--force') || rest.some((t) => t.startsWith('--force-') || t.startsWith('+'))

const isRiskyGitPushSegment = (tokens: readonly string[]): boolean => {
  const cmd = skipPrefix(tokens)
  return cmd[0] === 'git' && cmd[1] === 'push' && isForcePush(cmd.slice(2))
}

const isRiskyGitCleanSegment = (tokens: readonly string[]): boolean => {
  const cmd = skipPrefix(tokens)
  return cmd[0] === 'git' && cmd[1] === 'clean' && hasFlag(cmd.slice(2), 'f', '--force')
}

/**
 * One symbolic-mode clause is dangerous when it targets group and/or other —
 * explicit `g`/`o`, `a`, or an omitted class list (chmod treats that as
 * "all") — and grants (`+`/`=`) write, with or without read/execute: write
 * alone (`go+w`) is already the risky shape, not just full `rwx`. Owner-only
 * (`u`) clauses never match. `-` (revoke) never matches either.
 */
const isRiskyChmodClause = (clause: string): boolean => {
  const m = /^([ugoa]*)[+=]([rwxXst]+)$/.exec(clause)
  if (m === null) return false
  const classes = m[1] ?? ''
  const perms = m[2] ?? ''
  const targetsGroupOrOther = classes === '' || classes.includes('a') || classes.includes('g') || classes.includes('o')
  return targetsGroupOrOther && perms.includes('w')
}

/** A mode token may be a comma-separated list of clauses (`u+rwx,go+rwx`) — any one risky clause is enough. */
const isRiskySymbolicMode = (token: string): boolean =>
  token.split(',').some((clause) => isRiskyChmodClause(clause))

const isRiskyChmodSegment = (tokens: readonly string[]): boolean => {
  const cmd = skipPrefix(tokens)
  if (cmd[0] !== 'chmod') return false
  const rest = cmd.slice(1)
  if (!hasFlag(rest, 'R', '--recursive')) return false
  return rest.some((t) => /^0*777$/.test(t) || isRiskySymbolicMode(t))
}

/** `of=` is the destructive half of `dd` (it names the write target); `if=` alone only reads. */
const isRiskyDdSegment = (tokens: readonly string[]): boolean => {
  const cmd = skipPrefix(tokens)
  return cmd[0] === 'dd' && cmd.some((t) => t.startsWith('of='))
}

/** Fixed-phrase checks with no flag-ordering ambiguity — safe as plain regex per segment. */
const SEGMENT_PATTERNS: readonly RegExp[] = [
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+(?:--\s+)?\.\s*$/,
  /\bmkfs\b/,
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
]

const isRiskySegment = (segment: string): boolean => {
  const tokens = tokenize(segment)
  return (
    isRiskyRmSegment(tokens) ||
    isRiskyGitPushSegment(tokens) ||
    isRiskyGitCleanSegment(tokens) ||
    isRiskyChmodSegment(tokens) ||
    isRiskyDdSegment(tokens) ||
    SEGMENT_PATTERNS.some((p) => p.test(segment))
  )
}

/** True when an `rm` invocation carries both r(ecursive) and f(orce) flags, in any tokenization. */
export const isRiskyRm = (command: string): boolean =>
  splitSegments(command).some((seg) => isRiskyRmSegment(tokenize(seg)))

export const findRiskyCommand = (command: string): boolean =>
  splitSegments(command).some((seg) => isRiskySegment(seg))
