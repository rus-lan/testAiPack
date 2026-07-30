import "../main.tsp";

using TestAiPack;

namespace TestAiPack.Diff;

@error
model DiffError {
  code: "E_DISK_FULL" | "E_WORKTREE_BROKEN";
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
