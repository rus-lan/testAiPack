import "../main.tsp";

using TestAiPack;

namespace TestAiPack.WorkspaceSetup;

@error
model WorkspaceSetupError {
  code: "E_HOME_SETUP_FAILED";
  message: string;
  reason?: "already-exists" | "not-a-directory" | "mkdir-failed" | "write-failed";
  path?: string;
  context?: Record<unknown>;
}

model WorkspaceSetupInput {
  runInput: RunInput;
  runId: string;
}

model WorkspaceSetupResult {
  manifest: Manifest;
  rootPath: string;
  treePaths: WorkspaceTree;
}
