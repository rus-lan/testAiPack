// TestAiPack contract — single source of truth.
// All shared domain types live here. Phase contracts (./phases/*.tsp) import
// this file and reference types via `using TestAiPack;`.

namespace TestAiPack;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

enum Side {
  Old: "old";
  New: "new";
}

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

// Which side(s) receive `init` text. `Both` is the historical default:
// correct for environment prep (dependency installs) both sides need for a
// fair comparison, but wrong for a pack TRIGGER (e.g. a slash command),
// which only the pack-under-test side should ever see.
enum InitSide {
  Both: "both";
  New: "new";
  Old: "old";
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
// Pipeline input
// ---------------------------------------------------------------------------

model RunInput {
  repoUrl: string;
  packRef?: string;
  packType?: PackType;
  prompt: string;
  promptFiles?: string[];
  "init"?: string;
  initFiles?: string[];
  initSide: InitSide;
  verify?: string;
  runs: int32;
  isolation: IsolationMode;
  dockerNetwork?: string;
  opencodeVersion?: string;
  auth: AuthWhitelist;
  pureBaseline: boolean;
  judge?: string;
  judgeFiles?: string[];
  preflightEnabled: boolean;
  preflightModel?: string;
  "model"?: string;
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
  /** Shell command that installs the pack's runtime into $HOME. Runs once for the whole experiment. */
  packSetup?: string;
  /** Shell command that exits 0 iff the pack's runtime is functional. Runs in every new HOME (must pass) and every old HOME (must fail unless allowBaselineTool). */
  packCheck?: string;
  /** Shell command that runs the pack's own pipeline, once per new-side run, before the agent session starts. */
  packExercise?: string;
  /** Override for gate 6: do not hard-fail when packCheck already passes on the old (baseline) side. Absent = false (reports/run-input.json written before this field existed). */
  allowBaselineTool?: boolean;
  /** Text appended to the task prompt for BOTH sides, identically — never one-sided, that would make the comparison meaningless. Meant to tell the agent about tool output that may already sit in the workspace (e.g. from packExercise) without biasing which side looks for it. Must be phrased conditionally ("if X is present, use it; if not, work as usual") so its absence on the baseline side costs at most a couple of tool calls. */
  packHint?: string;
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
  runId: string;
  timestamp: utcDateTime;
  repoUrl: string;
  packRef?: string;
  packType?: PackType;
  prompt: string;
  "init"?: string;
  verify?: string;
  runs: int32;
  isolation: IsolationMode;
  opencodeVersion: string;
  flagDefaults: Record<unknown>;
  /** Provenance copy of RunInput.packSetup. */
  packSetup?: string;
  /** Provenance copy of RunInput.packCheck. */
  packCheck?: string;
  /** Provenance copy of RunInput.packExercise. */
  packExercise?: string;
  /** Provenance copy of RunInput.packHint — sent identically to both sides; see RunInput.packHint. */
  packHint?: string;
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
  time: { start: safeint; end: safeint };
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
  input: unknown;
  output?: string;
  /** Error text opencode attaches to a failed tool call. */
  error?: string;
  metadata?: Record<unknown>;
  title?: string;
  time?: { start: safeint; end: safeint };
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

/** One phase's share of the splittable primary metrics (init or task). See SidePhaseSplit. */
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
 * RunSideResult.setupWallMs (written by the pack-setup pipeline — see its
 * doc there for exactly what that per-run figure covers).
 */
model SetupSegment {
  wallClockMs: int64;
}

/**
 * Per-side split of the primary metrics between the `--init` invocation and
 * the `--prompt` (task) invocation, derived from the export by cutting the
 * message list at the second user-role message. Absent on reports written
 * before the split existed. `task` covers every successful run (for a run
 * with no init the whole run IS the task); `init` covers only runs whose
 * export contains an init turn.
 */
model SidePhaseSplit {
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
  /** Harness-run pack setup before the agent phases (see RunSideResult.setupWallMs): wall-clock only — median over runs that had one. Absent when no setup segment ran on this side. */
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

/** Pack invocations seen in the exports of one side (wave 1: skill packs only). */
model PackUse {
  /** Sum of matching skill tool calls across the side's successful runs. */
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
   * the new-side HOME before any run started. Only meaningful together with
   * `calls === 0`: with this true, zero calls means the model chose not to
   * use the pack; with this false or absent, zero calls could also mean the
   * pack was never reachable (preflight skipped, disabled, or ran before
   * this field existed). Optional so a `report.json` written before this
   * field existed still parses — render sites must treat absent the same as
   * `false`.
   */
  visibilityConfirmed?: boolean;
  /** Run indexes with a successful extraction but zero pack calls — the pack was available and inspected, the agent just never called it. Observational, not a success criterion. */
  runsWithoutCall?: int32[];
}

enum PackSetupMode {
  /** setup + check + exercise all declared and all succeeded — the intended default. */
  Exercised: "exercised";
  /** No packExercise declared (the pack has nothing runnable, e.g. a pure instruction skill). Not a failure. */
  InstalledOnly: "installed-only";
  /** No setup/check/exercise declared at all — legacy behavior, weakest evidence class. */
  DeliveredOnly: "delivered-only";
}

/** Result of one harness-run pack command (setup / check / exercise) — no model, no opencode session. */
model PackCmdResult {
  side: Side;
  /** 0 for the one-shot setup. */
  runIndex: int32;
  exitCode: int32;
  durationMs: int64;
  /** stdout+stderr tail, truncated (untrusted content). */
  outputTail?: string;
  /** exercise only: SHA-256 over the artifact tree it created. */
  artifactHash?: string;
}

/** Harness-side pack preparation record for the whole experiment — see RunInput.packSetup/packCheck/packExercise. */
model PackSetupReport {
  mode: PackSetupMode;
  setupDeclared: boolean;
  checkDeclared: boolean;
  exerciseDeclared: boolean;
  /** Dependency markers (pyproject.toml, package.json with bin, pip/uv/npm install text, ...) found in the pack while nothing was declared. */
  undeclaredDepWarning?: string;
  setup?: PackCmdResult;
  /** One per new HOME (must pass) + one per old HOME (must fail unless allowBaselineTool). */
  checks: PackCmdResult[];
  /** One per new-side run, only when exerciseDeclared. */
  exercises: PackCmdResult[];
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
 * One observed sign that the baseline (`old`) side acquired or used the
 * pack under test — a heuristic tripwire, not proof. See
 * `src/metrics/baseline-contamination.ts`.
 */
model ContaminationSignal {
  kind: "skill-call" | "bash-install" | "install-drift";
  /** Free text — agent-authored (a quoted command, or a drift summary), truncated for display. Render as untrusted content. */
  detail: string;
  /** Absent for `install-drift`, which is side-level, not tied to one run. */
  runIndex?: int32;
}

/** Outcome of the --verify command across one side's runs. Omitted when --verify is unset. */
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

model SideAggregates {
  side: Side;
  /** primary: median-снимок первичных метрик по N прогонам — используется в дельте и рендере */
  primary: PrimaryMetrics;
  secondary: SecondaryMetrics;
  /** stats: полное распределение (median/min/max/IQR) по N прогонам для каждой первичной метрики */
  stats: AggregateStats;
  failedRuns: FailedRun[];
  rawRunIds: string[];
  packUse?: PackUse;
  riskyCommands?: RiskyCommand[];
  /** Distinct export info.version values seen across the side's runs. */
  opencodeVersions?: string[];
  verifyStats?: VerifyStats;
  /** Only ever populated for `side: "old"` — see `ContaminationSignal`. */
  contaminationSignals?: ContaminationSignal[];
  /** Split of the primary metrics between the --init and --prompt invocations — see SidePhaseSplit. */
  phaseSplit?: SidePhaseSplit;
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
  runIndex: int32;
  errorCode: ErrorCode;
  errorMessage: string;
  timestamp: utcDateTime;
}

model MetricsDiff {
  old: SideAggregates;
  new: SideAggregates;
  deltas: PrimaryDeltas;
  bothFailed: boolean;
  /** Task-phase-only deltas (new task vs old task) — the like-for-like basis when init runs on one side. Present iff both sides carry phaseSplit. */
  taskDeltas?: PhaseDeltas;
  /** Init-vs-init deltas. Present iff BOTH sides have runsWithInit > 0 (i.e. --init-side both). */
  initDeltas?: PhaseDeltas;
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
  side: Side;
  runIndex: int32;
  sessionId: string;
  parentSessionId?: string;
  swimlaneDepth: int32;
  type: TimelineEventType;
  tool?: string;
  tokens?: int32;
  status?: "pending" | "running" | "completed" | "error";
}

model Timeline {
  old: TimelineEvent[];
  new: TimelineEvent[];
  mode: TimelineMode;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

model DiffResult {
  side: Side;
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

model JudgeResult {
  verdict: JudgeVerdict;
  oldQuality: int32;
  newQuality: int32;
  explanation: string;
  rawResponse?: string;
  modelUsed: string;
  timestamp: utcDateTime;
  // absent = true (reports written before this field existed)
  ran?: boolean;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

model Report {
  manifest: Manifest;
  metricsDiff: MetricsDiff;
  timeline: Timeline;
  diff: { old: DiffResult; new: DiffResult };
  judge?: JudgeResult;
  summary: ReportSummary;
  packSetup?: PackSetupReport;
}

model ReportSummary {
  headlineResult: string;
  improvements: MetricDelta[];
  regressions: MetricDelta[];
  neutral: MetricDelta[];
  failures: FailedRun[];
  /** Which deltas fed headlineResult and the buckets: "task" (init/setup excluded) or "total". Absent = "total" (older reports). */
  basis?: "task" | "total";
}

// ---------------------------------------------------------------------------
// Shared phase data structures
// Referenced by 2+ phases, defined once here so phase files only import main.tsp.
// ---------------------------------------------------------------------------

model WorkspaceTree {
  root: string;
  appsSource: string;
  appsOld: string[];
  appsNew: string[];
  pack: string;
  homeOld: string[];
  homeNew: string[];
  gitDirsOld: string[];
  gitDirsNew: string[];
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
  /** Set only when RunInput.packSetup is declared: <homeDir>/.local/bin prepended, identical shape on both sides. */
  PATH?: string;
}

model RunSideResult {
  side: Side;
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
   * Absent (not zero) when no exercise ran for this run: the old side never
   * exercises, and a zero here would read as "measured none" rather than
   * "not applicable". One-time setup/check wall-clock is experiment-level,
   * not per-run — see PackSetupReport.setup / PackSetupReport.checks.
   */
  setupWallMs?: int64;
  /** True when this run actually executed an --init invocation. */
  initRan?: boolean;
  /** Harness wall-clock around the init invocation (ms). */
  initWallMs?: int64;
  /** Harness wall-clock around the prompt invocation (ms). */
  promptWallMs?: int64;
}
