// TestAiPack contract — single source of truth.
// All shared domain types live here. Phase contracts (./phases/*.tsp) import
// this file and reference types via `using TestAiPack;`.

namespace TestAiPack;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

enum IsolationMode {
  Home: "home";
  Docker: "docker";
}

enum PackType {
  Skill: "skill";
  Plugin: "plugin";
  Agent: "agent";
  Command: "command";
  Mcp: "mcp";
  All: "all";
}

enum TimelineMode {
  SideBySide: "side-by-side";
  TreeDiff: "tree-diff";
  Merged: "merged";
}

enum LogLevel {
  Debug: "debug";
  Info: "info";
  Warn: "warn";
  Error: "error";
}

enum FinishCause {
  Stop: "stop";
  ToolCalls: "tool-calls";
  Length: "length";
  Error: "error";
  Other: "other";
  Unknown: "unknown";
}

// 0 = crash, 1 = doom-loop, 2 = length-limit, 3 = tool-calls -> stop, 4 = clean stop.
scalar SuccessRank extends int32;

enum JudgeVerdict {
  Ok: "ok";
  Fail: "fail";
  Unclear: "unclear";
}

enum OutputFormat {
  Markdown: "md";
  Html: "html";
  Json: "json";
  Yaml: "yaml";
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

enum ErrorCode {
  ERepoTimeout: "E_REPO_TIMEOUT";
  ERepoCloneFailed: "E_REPO_CLONE_FAILED";
  EPackInvalidRef: "E_PACK_INVALID_REF";
  EPackUnknownType: "E_PACK_UNKNOWN_TYPE";
  EPackInstallTimeout: "E_PACK_INSTALL_TIMEOUT";
  EPackInstallFailed: "E_PACK_INSTALL_FAILED";
  EHomeSetupFailed: "E_HOME_SETUP_FAILED";
  EPreflightTimeout: "E_PREFLIGHT_TIMEOUT";
  EPreflightFailed: "E_PREFLIGHT_FAILED";
  EPreflightPackInvisible: "E_PREFLIGHT_PACK_INVISIBLE";
  ERunTimeout: "E_RUN_TIMEOUT";
  ERunHangWatchdog: "E_RUN_HANG_WATCHDOG";
  ERunCrash: "E_RUN_CRASH";
  EVerifyTimeout: "E_VERIFY_TIMEOUT";
  EVerifyFailed: "E_VERIFY_FAILED";
  EInstallTimeout: "E_INSTALL_TIMEOUT";
  EInstallFailed: "E_INSTALL_FAILED";
  ETotalTimeout: "E_TOTAL_TIMEOUT";
  EOom: "E_OOM";
  EDiskFull: "E_DISK_FULL";
  EWorktreeBroken: "E_WORKTREE_BROKEN";
  EPortConflict: "E_PORT_CONFLICT";
  EDockerFailed: "E_DOCKER_FAILED";
  EExportInvalid: "E_EXPORT_INVALID";
  EConfigInvalid: "E_CONFIG_INVALID";
  EAuthMissing: "E_AUTH_MISSING";
  EModelUnavailable: "E_MODEL_UNAVAILABLE";
  ERateLimitExhausted: "E_RATE_LIMIT_EXHAUSTED";
  EPackSetupFailed: "E_PACK_SETUP_FAILED";
  EPackSetupTimeout: "E_PACK_SETUP_TIMEOUT";
  EPackCheckFailed: "E_PACK_CHECK_FAILED";
  EPackExerciseFailed: "E_PACK_EXERCISE_FAILED";
  EPackExerciseDirty: "E_PACK_EXERCISE_DIRTY";
}

@error
model PhaseError {
  code: ErrorCode;
  phase: string;
  message: string;
  cause?: unknown;
  context?: Record<unknown>;
  timestamp: utcDateTime;
}

// ---------------------------------------------------------------------------
// Variants & packs (v2)
// ---------------------------------------------------------------------------

/** Wire-format version. 2 = n-way variants. Artifacts without the field are v1. */
scalar SchemaVersion extends int32;

/**
 * One pack in the experiment's registry. `setup`/`check` belong to the PACK
 * (they install/verify the pack's own runtime); `exercise` belongs to the
 * VARIANT (see VariantSpec.exercise).
 */
model PackSpec {
  /** Registry key, referenced by VariantSpec.packs. Same charset as variant names. */
  name: string;
  /** git URL, npm package, local path, or mcp:<name>:<config> — the old RunInput.packRef. */
  ref: string;
  /** Override the auto-detected pack type. */
  type?: PackType;
  /** Shell command that installs the pack's runtime into $HOME. Runs once per declaring variant (in its run-1 HOME, then copied out). */
  setup?: string;
  /** Shell command that exits 0 iff the pack's runtime is functional. Preflight gate 6 runs it in EVERY HOME of every variant: must pass where the pack is declared, must fail elsewhere (unless allowPacks). */
  check?: string;
}

/**
 * One experiment arm. Fields prompt/init/model/hint/verify fall back to the
 * same-named global RunInput field when absent; an explicit empty string
 * disables the inherited global (decision D7).
 */
model VariantSpec {
  /** ^[a-z0-9][a-z0-9-]{0,31}$, unique across the run, `source` reserved. Lands in paths and sessionIds. */
  name: string;
  /** PackSpec.name references. Stage 1 enforces length <= 1 at parse time. */
  packs: string[];
  prompt?: string;
  "init"?: string;
  "model"?: string;
  /** Appended to this variant's task prompt (successor of the global-only packHint). */
  hint?: string;
  /** Drives OPENCODE_PURE / OPENCODE_DISABLE_DEFAULT_PLUGINS / OPENCODE_DISABLE_EXTERNAL_SKILLS. Default: packs.length === 0. */
  pure?: boolean;
  verify?: string;
  /** Shell command run once per run of THIS variant, before the agent session (successor of --pack-exercise). */
  exercise?: string;
  /** Pack names whose `check` may pass in this variant's HOMEs without failing gate 6 — the per-(variant,pack) successor of --allow-baseline-tool. */
  allowPacks?: string[];
}

// ---------------------------------------------------------------------------
// Pipeline input
// ---------------------------------------------------------------------------

model RunInput {
  schemaVersion: SchemaVersion;
  repoUrl: string;
  /** Global default prompt. Optional in v2 — every variant must have an effective prompt (own or this). */
  prompt?: string;
  promptFiles?: string[];
  "init"?: string;
  initFiles?: string[];
  /** Global default (old packHint). */
  hint?: string;
  verify?: string;
  "model"?: string;
  runs: int32;
  /** Max variants executed concurrently in phase 06. Default 2. */
  parallel: int32;
  /** Name of the baseline variant. Defaults to variants[0].name. */
  baseline: string;
  packs: PackSpec[];
  variants: VariantSpec[];
  isolation: IsolationMode;
  dockerNetwork?: string;
  opencodeVersion?: string;
  auth: AuthWhitelist;
  judge?: string;
  judgeFiles?: string[];
  preflightEnabled: boolean;
  preflightModel?: string;
  formats: OutputFormat[];
  outputPath: string;
  diffHtml: boolean;
  protectGit: boolean;
  collapseRepeats: boolean;
  timelineMode: TimelineMode;
  timeouts: TimeoutConfig;
  workspacePath: string;
  logLevel: LogLevel;
  pricingPath?: string;
}

model AuthWhitelist {
  opencode: boolean;
  npmrc: boolean;
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
  aws: boolean;
  ssh: boolean;
  git: boolean;
}

model TimeoutConfig {
  preflightSeconds: int32;
  runSeconds: int32;
  verifySeconds: int32;
  installSeconds: int32;
  watchdogSeconds: int32;
  totalSeconds?: int32;
}

// ---------------------------------------------------------------------------
// Manifest (workspace-setup output, written as manifest.json)
// ---------------------------------------------------------------------------

model Manifest {
  schemaVersion: SchemaVersion;
  runId: string;
  timestamp: utcDateTime;
  repoUrl: string;
  /** Optional (global default only). */
  prompt?: string;
  "init"?: string;
  hint?: string;
  verify?: string;
  runs: int32;
  parallel: int32;
  baseline: string;
  /** Provenance copies — refs redacted like repoUrl (01-workspace-setup.ts:79-103). */
  packs: PackSpec[];
  variants: VariantSpec[];
  isolation: IsolationMode;
  opencodeVersion: string;
  flagDefaults: Record<unknown>;
}

// ---------------------------------------------------------------------------
// Opencode export schema (opencode export <session-id>)
// ---------------------------------------------------------------------------

model OpencodeExport {
  info: ExportInfo;
  messages: ExportMessage[];
}

model ExportInfo {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  agent: string;
  "model": ExportModel;
  version: string;
  summary: ExportSummary;
  cost: float64;
  tokens: ExportTokens;
  time: ExportTimeRange;
}

model ExportModel {
  id: string;
  providerID: string;
  variant?: string;
}

model ExportSummary {
  additions: int32;
  deletions: int32;
  files: int32;
}

model ExportTokens {
  input: int32;
  output: int32;
  reasoning: int32;
  cache: ExportCache;
}

model ExportCache {
  read: int32;
  write: int32;
}

model ExportTimeRange {
  created: safeint;
  updated: safeint;
}

model ExportMessage {
  info: ExportMessageInfo;
  parts: ExportPart[];
}

model ExportMessageInfo {
  role: "user" | "assistant";
  agent?: string;
  "model"?: { providerID: string; modelID: string };
  cost?: float64;
  tokens?: ExportTokens & { total?: int32 };
  time: { created: safeint; completed?: safeint };
  finish?: FinishCause;
  path?: { cwd: string; root: string };
  parentID?: string;
}

// Flat discriminated union on the `type` field. In TypeSpec >=1.x the
// `@discriminator` decorator targets only Model (via `extends`), and
// `@discriminated` produces an enveloped shape `{type, value}` that does not
// match opencode export. A plain union of models with a literal `type` field is
// the idiomatic closed discriminated union here; TS/Zod/OpenAPI emitters infer
// the discriminator from the literal automatically.
union ExportPart {
  text: ExportTextPart;
  reasoning: ExportReasoningPart;
  tool: ExportToolPart;
  "step-start": ExportStepStartPart;
  "step-finish": ExportStepFinishPart;
  patch: ExportPatchPart;
  // Tolerant catch-all: opencode may emit part types beyond the modelled set
  // (e.g. future part kinds). Listing it last keeps the typed members first so
  // the Zod union still resolves them; anything else falls through here instead
  // of failing validation. Extraction/timeline ignore unrecognised parts.
  other: ExportUnknownPart;
}

model ExportTextPart {
  type: "text";
  text: string;
  id: string;
}

model ExportReasoningPart {
  type: "reasoning";
  text: string;
  // `end` is optional: an interrupted part carries a `start` with no `end`.
  time: { start: safeint; end?: safeint };
  id: string;
}

model ExportToolPart {
  type: "tool";
  tool: string;
  callID: string;
  state: ExportToolState;
  id: string;
}

model ExportToolState {
  status: "pending" | "running" | "completed" | "error";
  // Optional: opencode's pending tool-call state carries no `input` yet.
  input?: unknown;
  output?: string;
  /** Error text opencode attaches to a failed tool call. */
  error?: string;
  metadata?: Record<unknown>;
  title?: string;
  // `end` is optional for the same reason as ExportReasoningPart.time.end.
  time?: { start: safeint; end?: safeint };
}

model ExportStepStartPart {
  type: "step-start";
  snapshot?: string;
  id: string;
}

model ExportStepFinishPart {
  type: "step-finish";
  reason?: string;
  snapshot?: string;
  tokens?: ExportTokens & { total?: int32 };
  cost?: float64;
  id: string;
}

model ExportPatchPart {
  type: "patch";
  hash: string;
  files: string[];
  id: string;
}

model ExportUnknownPart {
  type: string;
  id: string;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

model PrimaryMetrics {
  totalTokens: int64;
  wallClockMs: int64;
  costUsd: float64;
  stepCount: int32;
  toolCallCount: int32;
  successRank: SuccessRank;
  maxParallelism: int32;
}

model SecondaryMetrics {
  inputTokens: int64;
  outputTokens: int64;
  reasoningTokens: int64;
  cacheReadTokens: int64;
  perTool: Record<ToolStat>;
  reasoningTimeMs: int64;
  stepLatencyP50Ms: int64;
  stepLatencyP95Ms: int64;
  toolLatencyAvgMs: int64;
  finishCauseDistribution: Record<int32>;
  maxConsecutiveSameTool: int32;

  // -- wave 1: sums across runs (rare events; a median would hide (0,0,0,0,3) as 0) --
  /** Sum across runs of tool parts with tool === "invalid" (hallucinated tool names). */
  invalidToolCalls?: int32;
  /** Sum across runs of exact repeat tool calls (same tool + identical input JSON), counting repeats beyond the first. */
  duplicateToolCalls?: int32;
  /** Sum across runs of bash calls with state.metadata.exit !== 0. */
  bashFailCount?: int32;
  /** Top-5 distinct tool state.error texts by frequency, each truncated to 200 chars. */
  toolErrorTexts?: string[];

  // -- wave 2 / P5: latency profile from the streamed events (medians unless noted) --
  /** Median across runs of (first tool_use event timestamp − first event timestamp). */
  timeToFirstToolMs?: int64;
  /** Median over runs-that-edited of (first edit/write tool_use timestamp − first event timestamp). */
  timeToFirstEditMs?: int64;
  /** MAX across runs of the largest gap between consecutive event timestamps (worst silent stall). */
  maxEventGapMs?: int64;
  /** Sum across runs of event gaps exceeding the stall threshold (see stalledRunCount). */
  stallCount?: int32;
  /** Number of runs with at least one gap exceeding the stall threshold. */
  stalledRunCount?: int32;

  // -- wave 2 / P11: context growth from step-finish token counts (medians) --
  /** Median across runs of the FIRST step-finish tokens.input (baseline context: system prompt + tools + task). */
  firstStepInputTokens?: int64;
  /** Median across runs of the LAST step-finish tokens.input (final context size). */
  lastStepInputTokens?: int64;

  // -- wave 2 / P12: output volume (medians) --
  /** Median across runs of total text-part characters. */
  textChars?: int64;
  /** Median across runs of total reasoning-part characters. */
  reasoningChars?: int64;

  // -- promoted from anti-recommendations: recorded, never scored (median) --
  /** Median across runs of info.tokens.cache.write. */
  cacheWriteTokens?: int64;
}

/** One phase's share of the splittable primary metrics (init or task). See PhaseSplit. */
model PhaseSlice {
  totalTokens: int64;
  wallClockMs: int64;
  costUsd: float64;
  stepCount: int32;
  toolCallCount: int32;
}

/** Distributions for the five splittable metrics (mirror of AggregateStats). */
model PhaseSliceStats {
  totalTokens: MetricDistribution;
  wallClockMs: MetricDistribution;
  costUsd: MetricDistribution;
  stepCount: MetricDistribution;
  toolCallCount: MetricDistribution;
}

/**
 * Deterministic pack tooling the harness runs before the agent phases: no
 * model call, so no tokens/steps/cost — wall-clock is the ONLY metric that
 * exists for it. A separate model (not a PhaseSlice) so the absence of agent
 * metrics is structural, not a fabricated zero. Aggregated from
 * RunResult.setupWallMs (written by the pack-setup pipeline — see its
 * doc there for exactly what that per-run figure covers).
 */
model SetupSegment {
  wallClockMs: int64;
}

/**
 * Per-variant split of the primary metrics between the `--init` invocation and
 * the `--prompt` (task) invocation, derived from the export by cutting the
 * message list at the second user-role message. Absent on reports written
 * before the split existed. `task` covers every successful run (for a run
 * with no init the whole run IS the task); `init` covers only runs whose
 * export contains an init turn.
 */
model PhaseSplit {
  /** Successful runs whose export contains an init turn (2 user messages). */
  runsWithInit: int32;
  /** Successful runs where phase 06 ran an init but the export lost it (session continuation failed) — init cost unmeasured, not zero. */
  runsWithLostInit: int32;
  /** Median over runs-with-init. Absent when runsWithInit == 0. */
  "init"?: PhaseSlice;
  initStats?: PhaseSliceStats;
  /** Median over ALL successful runs (task == whole run when no init). */
  task: PhaseSlice;
  taskStats: PhaseSliceStats;
  /** True when at least one contributing run's phase cost was prorated from the session cost (per-message costs absent) — render as derived, never as measured. */
  costProrated?: boolean;
  /** Harness-run pack setup before the agent phases (see RunResult.setupWallMs): wall-clock only — median over runs that had one. Absent when no setup segment ran on this variant. */
  setup?: SetupSegment;
  setupStats?: MetricDistribution;
}

/** Deltas over the five splittable metrics only (rank/parallelism are whole-run). */
model PhaseDeltas {
  totalTokens: MetricDelta;
  wallClockMs: MetricDelta;
  costUsd: MetricDelta;
  stepCount: MetricDelta;
  toolCallCount: MetricDelta;
}

model ToolStat {
  count: int32;
  errorRate: float64;
  avgDurationMs: int64;
}

/** Pack invocations seen in one variant's exports, for ONE pack. */
model PackUse {
  pack: string;
  /** Sum of matching skill tool calls across the variant's successful runs. */
  calls: int32;
  /** Of those, calls whose tool state.status === "error". */
  errors: int32;
  /** Number of runs with at least one matching call. */
  runsWithCall: int32;
  /** Number of successful runs inspected. */
  runCount: int32;
  /** Median over runs-with-call of (first call state.time.start − root info.time.created). */
  firstCallMsMedian?: int64;
  /** false when the pack type cannot be seen in exports (plugin, mcp, agent, command). */
  canDetect: boolean;
  /**
   * True when preflight's pack-visibility gate proved the pack was present in
   * the declaring variant's HOME before any run started. Only meaningful
   * together with `calls === 0`: with this true, zero calls means the model
   * chose not to use the pack; with this false or absent, zero calls could
   * also mean the pack was never reachable (preflight skipped, disabled, or
   * ran before this field existed). Optional so a `report.json` written
   * before this field existed still parses — render sites must treat absent
   * the same as `false`.
   */
  visibilityConfirmed?: boolean;
  /** Run indexes with a successful extraction but zero pack calls — the pack was available and inspected, the agent just never called it. Observational, not a success criterion. */
  runsWithoutCall?: int32[];
}

enum PackSetupMode {
  /** setup + check + exercise all declared and all succeeded — the intended default. */
  Exercised: "exercised";
  /** No exercise declared (the pack has nothing runnable, e.g. a pure instruction skill). Not a failure. */
  InstalledOnly: "installed-only";
  /** No setup/check/exercise declared at all — legacy behavior, weakest evidence class. */
  DeliveredOnly: "delivered-only";
}

/** Harness command evidence — carries variant AND pack attribution now. */
model PackCmdResult {
  variant: string;
  /** Pack the command belongs to; absent for a variant-owned exercise. */
  pack?: string;
  /** 0 for the one-shot setup. */
  runIndex: int32;
  exitCode: int32;
  durationMs: int64;
  /** stdout+stderr tail, truncated (untrusted content). */
  outputTail?: string;
  /** exercise only: SHA-256 over the artifact tree it created. */
  artifactHash?: string;
}

/** Pack-owned prep evidence (setup + checks) — one per registry pack. */
model PackPrep {
  pack: string;
  mode: PackSetupMode;
  setupDeclared: boolean;
  checkDeclared: boolean;
  /** Any declaring variant has an exercise. */
  exerciseDeclared: boolean;
  /** Dependency markers (pyproject.toml, package.json with bin, pip/uv/npm install text, ...) found in the pack while nothing was declared. */
  undeclaredDepWarning?: string;
  /** One per declaring variant. */
  setups: PackCmdResult[];
  /** Every HOME of every variant (declared: must pass; foreign: must fail). */
  checks: PackCmdResult[];
}

/** Variant-owned prep evidence (the per-run exercise). */
model VariantPrep {
  variant: string;
  exerciseDeclared: boolean;
  /** One per variant-side run, only when exerciseDeclared. */
  exercises: PackCmdResult[];
}

/** Harness-side pack preparation record for the whole experiment. */
model PrepReport {
  packs: PackPrep[];
  variants: VariantPrep[];
}

/** One dangerous shell command found in a run's exports. */
model RiskyCommand {
  runIndex: int32;
  /** The bash tool input.command, truncated to 300 chars. */
  command: string;
  /** true when state.status === "completed". */
  completed: boolean;
  /** state.metadata.exit when present. */
  exitCode?: int32;
}

/**
 * One observed sign that a variant acquired or used a FOREIGN pack — a
 * heuristic tripwire, not proof. See `src/metrics/baseline-contamination.ts`.
 */
model ContaminationSignal {
  kind: "skill-call" | "bash-install" | "install-drift";
  /** Which FOREIGN pack the signal points at. */
  pack: string;
  /** Free text — agent-authored (a quoted command, or a drift summary), truncated for display. Render as untrusted content. */
  detail: string;
  /** Absent for `install-drift`, which is variant-level, not tied to one run. */
  runIndex?: int32;
}

/** Outcome of the --verify command across one variant's runs. Omitted when --verify is unset. */
model VerifyStats {
  /** Runs whose verify command exited 0. */
  passed: int32;
  /** Runs whose verify command exited non-zero. */
  failed: int32;
  /** Runs whose verify command hit the verify timeout. */
  timedOut: int32;
  /** Runs where verify was attempted. */
  runCount: int32;
}

model FileChange {
  path: string;
  additions: int32;
  deletions: int32;
}

model VariantAggregates {
  variant: string;
  /** primary: median-снимок первичных метрик по N прогонам — используется в дельте и рендере */
  primary: PrimaryMetrics;
  secondary: SecondaryMetrics;
  /** stats: полное распределение (median/min/max/IQR) по N прогонам для каждой первичной метрики */
  stats: AggregateStats;
  failedRuns: FailedRun[];
  rawRunIds: string[];
  /** One entry per pack in this variant's declared set. */
  packUses?: PackUse[];
  riskyCommands?: RiskyCommand[];
  /** Distinct export info.version values seen across the variant's runs. */
  opencodeVersions?: string[];
  verifyStats?: VerifyStats;
  /** Signals that THIS variant acquired/used a FOREIGN pack (another variant's set). */
  contaminationSignals?: ContaminationSignal[];
  /** Split of the primary metrics between the --init and --prompt invocations — see PhaseSplit. */
  phaseSplit?: PhaseSplit;
}

model AggregateStats {
  totalTokens: MetricDistribution;
  wallClockMs: MetricDistribution;
  costUsd: MetricDistribution;
  stepCount: MetricDistribution;
  toolCallCount: MetricDistribution;
  successRank: MetricDistribution;
}

model MetricDistribution {
  median: float64;
  min: float64;
  max: float64;
  iqr?: float64;
  samples: float64[];
}

model FailedRun {
  variant: string;
  runIndex: int32;
  errorCode: ErrorCode;
  errorMessage: string;
  timestamp: utcDateTime;
}

/** One non-baseline variant's deltas vs the baseline. */
model VariantDelta {
  variant: string;
  deltas: PrimaryDeltas;
  /** Present iff both this variant and the baseline carry phaseSplit. */
  taskDeltas?: PhaseDeltas;
  /** Present iff both carry runsWithInit > 0. */
  initDeltas?: PhaseDeltas;
  /** True when baseline or this variant produced zero samples — deltas then non-significant/neutral (same containment as computeDelta's anyFailed, src/metrics/aggregate.ts:568-588). */
  pairIncomplete: boolean;
}

model MetricsReport {
  baseline: string;
  /** Config order, baseline included. */
  variants: VariantAggregates[];
  /** N-1 entries, config order minus baseline. */
  deltas: VariantDelta[];
  /** Every variant produced zero samples (replaces bothFailed). */
  allFailed: boolean;
}

model PrimaryDeltas {
  totalTokens: MetricDelta;
  wallClockMs: MetricDelta;
  costUsd: MetricDelta;
  stepCount: MetricDelta;
  toolCallCount: MetricDelta;
  successRank: MetricDelta;
  maxParallelism: MetricDelta;
}

model MetricDelta {
  absolute: float64;
  percent?: float64;
  significant: boolean;
  better: "better" | "worse" | "neutral" | "context-dependent";
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

enum TimelineEventType {
  Reasoning: "reasoning";
  ToolCall: "tool-call";
  ToolResult: "tool-result";
  StepFinish: "step-finish";
  Text: "text";
}

model TimelineEvent {
  tStart: int64;
  tEnd: int64;
  variant: string;
  runIndex: int32;
  sessionId: string;
  parentSessionId?: string;
  swimlaneDepth: int32;
  type: TimelineEventType;
  tool?: string;
  tokens?: int32;
  status?: "pending" | "running" | "completed" | "error";
}

model VariantTimeline {
  variant: string;
  events: TimelineEvent[];
}

model Timeline {
  lanes: VariantTimeline[];
  mode: TimelineMode;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

model DiffResult {
  variant: string;
  runs: DiffRunResult[];
}

model DiffRunResult {
  runIndex: int32;
  fullPatch: string;
  summary: DiffSummary;
  htmlPath?: string;
  noChanges: boolean;
  // absent = "ok" — report.json written before this field existed must still parse
  state?: DiffRunState;
  error?: DiffRunError;
}

enum DiffRunState {
  Ok: "ok";
  GitRestored: "git-restored";
  GitReplaced: "git-replaced";
  Failed: "failed";
}

model DiffRunError {
  code: "E_WORKTREE_BROKEN";
  message: string;
}

model DiffSummary {
  filesChanged: int32;
  additions: int32;
  deletions: int32;
  perFile: FileChange[];
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

model VariantScore {
  variant: string;
  /** 0-10, clamped — same scale as today (09-judge.ts:217). */
  quality: int32;
}

model JudgeResult {
  verdict: JudgeVerdict;
  scores: VariantScore[];
  /** Variant names, best first. Derived from scores when the model omits or contradicts it. */
  ranking: string[];
  explanation: string;
  rawResponse?: string;
  modelUsed: string;
  timestamp: utcDateTime;
  // absent = true (reports written before this field existed)
  ran?: boolean;
  /** True when the single call would exceed the prompt budget and per-variant scores came from pairwise-vs-baseline calls (03-hard-problems.md §2). */
  pairwiseFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

model Report {
  schemaVersion: SchemaVersion;
  manifest: Manifest;
  metrics: MetricsReport;
  timeline: Timeline;
  diffs: DiffResult[];
  judge?: JudgeResult;
  summary: ReportSummary;
  prep?: PrepReport;
}

model VariantSummary {
  variant: string;
  improvements: MetricDelta[];
  regressions: MetricDelta[];
  neutral: MetricDelta[];
}

model ReportSummary {
  headlineResult: string;
  /** N-1 entries (non-baseline variants, config order). */
  perVariant: VariantSummary[];
  failures: FailedRun[];
  /** Which deltas fed headlineResult and the buckets: "task" (init/setup excluded) or "total". Absent = "total" (older reports). */
  basis?: "task" | "total";
}

// ---------------------------------------------------------------------------
// Shared phase data structures
// Referenced by 2+ phases, defined once here so phase files only import main.tsp.
// ---------------------------------------------------------------------------

/** Per-variant slice of the workspace layout (one path per run). */
model VariantTree {
  name: string;
  apps: string[];
  homes: string[];
  gitDirs: string[];
}

model WorkspaceTree {
  root: string;
  appsSource: string;
  /** Root of pack deliveries: pack/<packName>/. */
  pack: string;
  variantTrees: VariantTree[];
  config: string;
  results: string;
  raw: string;
  diff: string;
}

model HomeTree {
  basePath: string;
  structure: string[];
  copiedAuth: string[];
}

model EnvVarSet {
  HOME: string;
  OPENCODE_DISABLE_PROJECT_CONFIG: boolean;
  OPENCODE_DISABLE_DEFAULT_PLUGINS: boolean;
  OPENCODE_DISABLE_EXTERNAL_SKILLS: boolean;
  OPENCODE_PURE: boolean;
  OPENCODE_CONFIG_CONTENT?: string;
  /** Set only when the variant's pack declares PackSpec.setup: <homeDir>/.local/bin prepended; identical shape for every variant. */
  PATH?: string;
}

/** Env sets for one variant, one entry per run. Replaces EnvVarSet[][] magic indexing. */
model VariantEnv {
  name: string;
  envs: EnvVarSet[];
}

model RunResult {
  variant: string;
  runIndex: int32;
  exportPath: string;
  eventsLogPath: string;
  successRank: SuccessRank;
  finishCause: FinishCause;
  exitCode: int32;
  durationMs: int64;
  verifyExitCode?: int32;
  watchdogTriggered: boolean;
  errorCode?: ErrorCode;
  /**
   * Wall-clock consumed by harness pack-exercise work for THIS run, before
   * the agent session started — no model, no tokens, no opencode session.
   * Absent (not zero) when no exercise ran for this run: a zero here would
   * read as "measured none" rather than "not applicable". One-time
   * setup/check wall-clock is experiment-level, not per-run — see
   * PackPrep.setups / PackPrep.checks.
   */
  setupWallMs?: int64;
  /** True when this run actually executed an --init invocation. */
  initRan?: boolean;
  /** Harness wall-clock around the init invocation (ms). */
  initWallMs?: int64;
  /** Harness wall-clock around the prompt invocation (ms). */
  promptWallMs?: int64;
}
