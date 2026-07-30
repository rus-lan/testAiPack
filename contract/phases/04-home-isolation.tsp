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
  /** Результат фазы 03 — явная связь pack-install → home-isolation. Отсутствует, если ни один пакет не задан. */
  packInstall?: TestAiPack.PackInstall.PackInstallResult;
}

model VariantHomes {
  name: string;
  trees: HomeTree[];
}

model VariantConfig {
  name: string;
  config: string;
}

model HomeIsolationResult {
  homeTrees: VariantHomes[];
  envVars: VariantEnv[];
  generatedConfigs: VariantConfig[];
}
