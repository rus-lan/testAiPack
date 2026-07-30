import { describe, it, expect } from 'vitest'
import { findRiskyCommand, isRiskyRm } from './risky-commands.js'

interface Case {
  readonly name: string
  readonly command: string
  readonly expected: boolean
}

const CASES: readonly Case[] = [
  { name: 'flags rm -rf', command: 'rm -rf /workspace/.git', expected: true },
  { name: 'flags rm -fr (flag order)', command: 'rm -fr build', expected: true },
  { name: 'flags rm -r -f (split flags)', command: 'rm -r -f build', expected: true },
  { name: 'flags rm -Rf (capital R)', command: 'rm -Rf build', expected: true },
  { name: 'flags long forms rm --recursive --force', command: 'rm --recursive --force build', expected: true },
  { name: 'rm -r alone is not risky', command: 'rm -r build', expected: false },
  { name: 'rm -f alone is not risky', command: 'rm -f build', expected: false },
  { name: 'rm behind && is flagged', command: 'echo hi && rm -rf x', expected: true },
  { name: 'rm behind ; is flagged', command: 'echo hi; rm -rf x', expected: true },
  { name: 'sudo rm -rf is flagged (prefix wrapper)', command: 'sudo rm -rf /var/log', expected: true },
  { name: 'env-assignment prefix rm -rf is flagged', command: 'FOO=1 rm -rf x', expected: true },
  { name: 'find -exec rm -rf is flagged (rm not in command position)', command: "find . -name '*.tmp' -exec rm -rf {} +", expected: true },
  { name: 'bash -c wrapping rm -rf is flagged (quoted inner script)', command: 'bash -c "rm -rf /"', expected: true },
  {
    name: 'multi-line script: rm -rf on its own line is flagged',
    command: 'set -e\nnpm install\nrm -rf node_modules\necho done',
    expected: true,
  },
  { name: 'git reset --hard', command: 'git reset --hard HEAD~1', expected: true },
  { name: 'git push --force', command: 'git push --force origin main', expected: true },
  { name: 'git push -f', command: 'git push -f origin main', expected: true },
  { name: 'git clean -fd', command: 'git clean -fd', expected: true },
  { name: 'chmod -R 777', command: 'chmod -R 777 /workspace', expected: true },
  { name: 'chmod 777 -R (flag after mode)', command: 'chmod 777 -R /workspace', expected: true },
  { name: 'chmod -R 0777 (leading zero)', command: 'chmod -R 0777 /workspace', expected: true },
  { name: 'dd with of= before if= is flagged (order-independent)', command: 'dd of=/dev/sda if=/dev/zero bs=1M', expected: true },
  { name: 'dd of= alone (no if=) is flagged — of= is the destructive half', command: 'dd of=/dev/sda bs=1M', expected: true },
  { name: 'dd if= alone (no of=) is not flagged — reading a device is harmless', command: 'dd if=/dev/sda bs=1M', expected: false },
  { name: 'DROP TABLE', command: 'psql -c "DROP TABLE users"', expected: true },
  { name: 'DROP SCHEMA', command: 'psql -c "DROP SCHEMA app CASCADE"', expected: true },
  {
    name: 'git checkout . followed by more commands is still flagged (per-segment end anchor)',
    command: 'git checkout . && npm test',
    expected: true,
  },
  {
    name: 'git checkout -- . is flagged (-- separator before the dot)',
    command: 'git checkout -- .',
    expected: true,
  },
  { name: 'git push +refspec force form is flagged', command: 'git push origin +main', expected: true },
  { name: 'git push --force-with-lease is flagged', command: 'git push --force-with-lease origin main', expected: true },
  { name: 'chmod -R a+rwx (symbolic full perms) is flagged', command: 'chmod -R a+rwx /workspace', expected: true },
  { name: 'chmod -R u+rwx (single class) is not flagged', command: 'chmod -R u+rwx /workspace', expected: false },
  { name: 'chmod -R go+w (write-only grant to group/other) is flagged', command: 'chmod -R go+w /etc', expected: true },
  {
    name: 'chmod -R u+rwx,go+rwx (comma-separated clause list, second clause is risky) is flagged',
    command: 'chmod -R u+rwx,go+rwx /',
    expected: true,
  },
  { name: 'does not flag ls -la', command: 'ls -la', expected: false },
  { name: 'does not flag npm run reset', command: 'npm run reset', expected: false },
  { name: 'does not flag rm file.txt', command: 'rm file.txt', expected: false },
  { name: 'does not flag git push origin main', command: 'git push origin main', expected: false },
  {
    name: 'does not flag git clean -n -- <path> (hyphen inside filename is not a flag token)',
    command: 'git clean -n -- src/my-file.ts',
    expected: false,
  },
  {
    name: 'does not flag a branch name that merely ends in -f',
    command: 'git push origin feature-f',
    expected: false,
  },
  {
    // Detection is per-line/segment scan of raw text, not a shell parser — a
    // command that merely mentions a pattern is flagged too (accepted false
    // positive, documented in the module JSDoc).
    name: 'documented false positive: a pattern quoted inside another command is flagged',
    command: 'echo "never run git reset --hard here"',
    expected: true,
  },
]

describe('findRiskyCommand — tabular', () => {
  for (const c of CASES) {
    it(`${c.name} -> ${String(c.expected)}`, () => {
      expect(findRiskyCommand(c.command)).toBe(c.expected)
    })
  }
})

describe('isRiskyRm — the split-flag case that broke a single regex', () => {
  it('rm -r -f flags true (proves the flag scan, not a regex, is used)', () => {
    expect(isRiskyRm('rm -r -f build')).toBe(true)
  })

  it('multi-line script: rm -rf on its own line is flagged', () => {
    expect(isRiskyRm('set -e\nrm -rf node_modules')).toBe(true)
  })
})
