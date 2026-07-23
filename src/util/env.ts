/**
 * Build an env record that inherits the given keys from `process.env`, skipping
 * any that are unset. Shared by opencode runner / version probes and docker
 * availability checks.
 */

export const inheritEnv = (keys: readonly string[]): Record<string, string> =>
  keys.reduce<Record<string, string>>((acc, k) => {
    const v = process.env[k]
    return v === undefined ? acc : { ...acc, [k]: v }
  }, {})
