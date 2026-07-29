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
