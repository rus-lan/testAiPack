import "../main.tsp";

using TestAiPack;

namespace TestAiPack.Cleanup;

// Soft phase: errors are logged but never fail the run.
model CleanupInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
  ephemeral: boolean;
}

model CleanupResult {
  deleted: string[];
  kept: string[];
  gcLogPath: string;
}
