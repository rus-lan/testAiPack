import "../main.tsp";

using TestAiPack;

namespace TestAiPack.RunSide;

@error
model RunSideError {
  code: "E_RUN_TIMEOUT"
    | "E_RUN_HANG_WATCHDOG"
    | "E_RUN_CRASH"
    | "E_VERIFY_TIMEOUT"
    | "E_VERIFY_FAILED"
    | "E_RATE_LIMIT_EXHAUSTED"
    | "E_OOM"
    | "E_DISK_FULL"
    | "E_PORT_CONFLICT"
    | "E_EXPORT_INVALID"
    | "E_TOTAL_TIMEOUT";
  message: string;
  variant: string;
  runIndex: int32;
  context?: Record<unknown>;
}

model RunSideInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
  homeEnv: EnvVarSet;
  variant: string;
  runIndex: int32;
  sessionId: string;
}
