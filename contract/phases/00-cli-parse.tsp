import "../main.tsp";

using TestAiPack;

namespace TestAiPack.CliParse;

@error
model CliParseError {
  code: "E_CONFIG_INVALID" | "E_MODEL_UNAVAILABLE";
  message: string;
  context?: Record<unknown>;
}

model CliParseInput {
  argv: string[];
  cwd: string;
  configFile?: string;
}

model CliParseResult {
  runInput: RunInput;
  configSource: "cli" | "config" | "merged";
}
