import "../main.tsp";

using TestAiPack;

namespace TestAiPack.RepoClone;

@error
model RepoCloneError {
  code: "E_REPO_TIMEOUT" | "E_REPO_CLONE_FAILED";
  message: string;
  repoUrl: string;
  context?: Record<unknown>;
}

model RepoCloneInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
}

model VariantCopyPaths {
  name: string;
  paths: string[];
}

model RepoCloneResult {
  sourcePath: string;
  copyPaths: VariantCopyPaths[];
  cloneDurationMs: int64;
}
