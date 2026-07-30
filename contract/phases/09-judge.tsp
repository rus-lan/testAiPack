import "../main.tsp";

using TestAiPack;

namespace TestAiPack.Judge;

@error
model JudgeError {
  code: "E_MODEL_UNAVAILABLE";
  message: string;
  context?: Record<unknown>;
}

model JudgeInput {
  runInput: RunInput;
  manifest: Manifest;
  diffs: DiffResult[];
}

model JudgeResultOutput {
  judge: JudgeResult | null;
}
