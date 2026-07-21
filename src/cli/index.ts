/**
 * CLI entrypoint: parses argv with clipanion and dispatches to the phase pipeline.
 *
 * Stage 2.1 ships a throwing stub so the compiled binary is runnable and fails
 * loudly. The real command tree (run / review / report / compare / gc / list /
 * init / doctor) lands in Stage 2.2.
 *
 * @see docs/phases/00-cli-parse.ru.md
 * @see contract/phases/00-cli-parse.tsp
 */
export function runCli(argv: readonly string[]): Promise<void> {
  return Promise.reject(
    new Error(
      `testaipack: CLI not implemented yet (Stage 2.1 foundation). argv received: ${String(argv.length)} args`,
    ),
  )
}
