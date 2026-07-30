import "../main.tsp";

using TestAiPack;

namespace TestAiPack.PackInstall;

@error
model PackInstallError {
  code: "E_PACK_INVALID_REF" | "E_PACK_UNKNOWN_TYPE" | "E_INSTALL_TIMEOUT" | "E_INSTALL_FAILED";
  message: string;
  packRef: string;
  context?: Record<unknown>;
}

model PackInstallInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
}

model PackDelivery {
  pack: string;
  packPath: string;
  detectedType: PackType | null;
  registeredIn: string[];
}

model PackInstallResult {
  deliveries: PackDelivery[];
  installLogPath: string;
}
