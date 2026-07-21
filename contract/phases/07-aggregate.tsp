import "../main.tsp";

using TestAiPack;

namespace TestAiPack.Aggregate;

@error
model AggregateError {
  code: "E_EXPORT_INVALID";
  message: string;
  side: Side;
  runIndex?: int32;
  context?: Record<unknown>;
}

model AggregateInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
  sideResults: { old: RunSideResult[]; new: RunSideResult[] };
}

model AggregateResult {
  metricsDiff: MetricsDiff;
  rawAggregates: { old: SideAggregates; new: SideAggregates };
}
