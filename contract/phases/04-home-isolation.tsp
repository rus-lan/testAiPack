import "../main.tsp";

using TestAiPack;

namespace TestAiPack.HomeIsolation;

@error
model HomeIsolationError {
  code: "E_HOME_SETUP_FAILED" | "E_AUTH_MISSING" | "E_DOCKER_FAILED" | "E_PACK_INSTALL_TIMEOUT" | "E_PACK_INSTALL_FAILED";
  message: string;
  context?: Record<unknown>;
}

model HomeIsolationInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
  /** Результат фазы 03 — явная связь pack-install → home-isolation. Отсутствует в smoke-test режиме (packRef не задан). */
  packInstall?: TestAiPack.PackInstall.PackInstallResult;
}

model HomeIsolationResult {
  homeTrees: { old: HomeTree[]; new: HomeTree[] };
  /** [side: 0=old, 1=new][runIndex-1] — env vars для каждого прогона каждой стороны */
  envVars: EnvVarSet[][];
  generatedConfigs: { baseline: string; new: string };
}
