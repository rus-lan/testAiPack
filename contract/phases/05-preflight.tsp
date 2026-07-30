import "../main.tsp";

using TestAiPack;

namespace TestAiPack.Preflight;

model HomeCheckTarget {
  homeDir: string;
  pathOverride?: string;
}

model VariantHomesForCheck {
  name: string;
  homes: HomeCheckTarget[];
}

model PreflightInput {
  runInput: RunInput;
  manifest: Manifest;
  homesForCheck: VariantHomesForCheck[];
}

@error
model PreflightError {
  code: "E_PREFLIGHT_TIMEOUT" | "E_PREFLIGHT_FAILED" | "E_PREFLIGHT_PACK_INVISIBLE" | "E_AUTH_MISSING" | "E_PACK_CHECK_FAILED";
  phase: "preflight";
  check: "opencode-launch" | "auth-ping" | "build-agent" | "pack-visibility" | "foreign-pack-absent" | "pack-functional";
  variant: string;
  message: string;
  context?: Record<unknown>;
}

model PreflightCheck {
  name: string;
  variant: string;
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
