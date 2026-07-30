import "../main.tsp";

using TestAiPack;

namespace TestAiPack.PackSetup;

@error
model PackSetupError {
  code: "E_PACK_SETUP_FAILED" | "E_PACK_SETUP_TIMEOUT";
  message: string;
  context?: Record<unknown>;
}

model PackSetupInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
  /** Результат фазы 03 — есть только когда задан хотя бы один пакет. */
  packInstall?: TestAiPack.PackInstall.PackInstallResult;
}

model PackSetupResult {
  report: PrepReport;
  logPath: string;
}
