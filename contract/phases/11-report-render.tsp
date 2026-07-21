import "../main.tsp";

using TestAiPack;

namespace TestAiPack.ReportRender;

@error
model ReportRenderError {
  code: "E_DISK_FULL";
  message: string;
  context?: Record<unknown>;
}

model ReportRenderInput {
  runInput: RunInput;
  manifest: Manifest;
  metricsDiff: MetricsDiff;
  timeline: Timeline;
  diff: { old: DiffResult; new: DiffResult };
  judge?: JudgeResult;
  summary: ReportSummary;
}

model ReportRenderResult {
  formats: OutputFormat[];
  paths: {
    md?: string;
    json?: string;
    yaml?: string;
    html?: string;
  };
  stdoutFormat: "md" | "json";
}
