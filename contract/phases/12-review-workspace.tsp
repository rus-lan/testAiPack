import "../main.tsp";

using TestAiPack;

namespace TestAiPack.ReviewWorkspace;

// Phase never fails: even if VSCode does not launch, the workspace file exists.
model ReviewWorkspaceInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
}

model ReviewWorkspaceResult {
  workspacePath: string;
  opened: boolean;
  command: string;
}
