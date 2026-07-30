import "../main.tsp";

using TestAiPack;

namespace TestAiPack.Preflight;

model PreflightInput {
  runInput: RunInput;
  manifest: Manifest;
  homePaths: { old: string; new: string };
}

@error
model PreflightError {
  code: "E_PREFLIGHT_TIMEOUT" | "E_PREFLIGHT_FAILED" | "E_PREFLIGHT_PACK_INVISIBLE" | "E_AUTH_MISSING" | "E_PACK_CHECK_FAILED";
  phase: "preflight";
  check: "opencode-launch" | "auth-ping" | "build-agent" | "pack-visibility" | "baseline-identical" | "pack-functional";
  side: Side;
  message: string;
  context?: Record<unknown>;
}

model PreflightCheck {
  name: string;
  side: Side;
  passed: boolean;
  durationMs: int64;
  details?: string;
}

model PreflightResult {
  checks: PreflightCheck[];
  allPassed: boolean;
  exitCode: 0 | 2 | 3;
  logPath: string;
}
