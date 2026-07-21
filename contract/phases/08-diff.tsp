import "../main.tsp";

using TestAiPack;

namespace TestAiPack.Diff;

@error
model DiffError {
  code: "E_DISK_FULL";
  message: string;
  side: Side;
  runIndex?: int32;
  context?: Record<unknown>;
}

model DiffInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
}

model DiffResultOutput {
  diff: { old: DiffResult; new: DiffResult };
}
