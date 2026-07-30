import "../main.tsp";

using TestAiPack;

namespace TestAiPack.TimelineBuild;

@error
model TimelineError {
  code: "E_EXPORT_INVALID";
  message: string;
  variant?: string;
  runIndex?: int32;
  context?: Record<unknown>;
}

model TimelineInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
  results: TestAiPack.Aggregate.VariantRunResults[];
}

model TimelineResult {
  timeline: Timeline;
  jsonPath: string;
  htmlPath?: string;
}
