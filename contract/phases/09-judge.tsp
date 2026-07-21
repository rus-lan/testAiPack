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
  diff: { old: DiffResult; new: DiffResult };
}

model JudgeResultOutput {
  judge: JudgeResult | null;
}
