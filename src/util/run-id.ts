import { Effect } from 'effect'
import crypto from 'node:crypto'

const pad2 = (n: number): string => n.toString().padStart(2, '0')

export const generateRunId = (now: Date = new Date()): Effect.Effect<string> =>
  Effect.sync(() => {
    const date = `${now.getUTCFullYear().toString()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`
    const time = `${pad2(now.getUTCHours())}-${pad2(now.getUTCMinutes())}-${pad2(now.getUTCSeconds())}`
    const hex = crypto.randomBytes(3).toString('hex')
    return `${date}_${time}_${hex}`
  })
