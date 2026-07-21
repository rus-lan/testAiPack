import "../main.tsp";

using TestAiPack;

namespace TestAiPack.TimelineBuild;

@error
model TimelineError {
  code: "E_EXPORT_INVALID";
  message: string;
  side?: Side;
  runIndex?: int32;
  context?: Record<unknown>;
}

model TimelineInput {
  runInput: RunInput;
  manifest: Manifest;
  workspace: WorkspaceTree;
  sideResults: { old: RunSideResult[]; new: RunSideResult[] };
}

model TimelineResult {
  timeline: Timeline;
  jsonPath: string;
  htmlPath?: string;
}
