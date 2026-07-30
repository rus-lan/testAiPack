import "../main.tsp";

using TestAiPack;

namespace TestAiPack.Aggregate;

@error
model AggregateError {
  code: "E_EXPORT_INVALID";
  message: string;
  variant: string;
  runIndex?: int32;
  context?: Record<unknown>;
}

model VariantRunResults {
  name: string;
  runs: RunResult[];
}

model AggregateInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
  results: VariantRunResults[];
}

model AggregateResult {
  metrics: MetricsReport;
}
