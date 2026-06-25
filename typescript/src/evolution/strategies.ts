/**
 * Evolution Strategies — the "brains" of self-improvement.
 *
 * Plain English: An EvolutionStrategy is like a coach watching game tape.
 * After watching the agent play (analyzing its trajectory), the coach
 * suggests specific improvements. Different coaches specialize in different things:
 *
 * - PromptEvolver: "Your instructions are confusing. Let me rewrite them."
 * - ToolEvolver: "You need a new tool, or your existing tools need tweaking."
 * - ProcessorEvolver: "Your behavioral checkpoints need adjustment."
 * - ConfigEvolver: "Your settings are suboptimal."
 *
 * Each strategy implements the same interface:
 *   propose(trajectory, eval_result, config, source_code) -> list[CodeMod]
 *
 * The strategies don't APPLY changes — they only PROPOSE them.
 * The PromotionGate decides whether to actually apply them.
 *
 * Real-world analogy: This is like having a team of consultants. Each one
 * specializes in a different area (marketing, operations, finance). They all
 * look at the same data (your trajectory) and each suggests changes in their
 * area of expertise. The PromotionGate is the CEO who decides which
 * suggestions to actually implement.
 */

import { Message, MessageType, ToolResult } from "../primitives/events";
import type { ModelProvider } from "../execution/runloop";
import type { Trajectory } from "../primitives/trajectory";
import { analyze_trajectory, Insight } from "./analysis";
import { CodeMod } from "./code_mod";

// ---------------------------------------------------------------------------
// EvolutionStrategy — the Protocol that all strategies implement
// ---------------------------------------------------------------------------

/**
 * The interface that every evolution strategy must implement.
 *
 * Plain English: Think of this as a job description for a "coach."
 * Every coach must have a name and must be able to propose improvements
 * when shown how the agent performed.
 *
 * The strategy receives:
 * - trajectory: The agent's "diary" of what it did step by step
 * - eval_result: How well it scored (like a test grade)
 * - config: The current settings/setup
 * - source_code: Dict of filename → content for the agent's own code
 *
 * And returns a list of CodeMods — proposed changes. The strategy
 * doesn't apply these changes; it just suggests them.
 */
export interface EvolutionStrategy {
    /** A human-readable name for this strategy (e.g., 'prompt_evolver'). */
    readonly name: string;

    /**
     * Analyze the trajectory and propose self-modifications.
     *
     * Args:
     *   trajectory: The agent's execution trajectory.
     *   eval_result: The evaluation result for this run.
     *   config: The current agent configuration.
     *   source_code: Dict mapping filename to file content.
     *
     * Returns:
     *   A list of CodeMod proposals. Empty list means no changes suggested.
     */
    propose(
        trajectory: unknown,
        eval_result: unknown,
        config: unknown,
        source_code: Record<string, string>,
    ): CodeMod[] | Promise<CodeMod[]>;
}

// ---------------------------------------------------------------------------
// PromptEvolver — proposes system prompt improvements
// ---------------------------------------------------------------------------

/**
 * Analyzes trajectory and proposes system prompt improvements.
 *
 * Plain English: Imagine a writing coach reading your agent's "instruction
 * manual" (system prompt) and saying: "This part is confusing, that part
 * is missing, and this other part contradicts itself." The PromptEvolver
 * looks at how the agent actually behaved (trajectory) vs. how it should
 * have behaved (eval_result), and suggests rewrites to the instructions.
 *
 * It uses a language model to generate the improved prompts — because
 * who better to write instructions for an AI than another AI?
 *
 * Attributes:
 *   _model: The language model provider used to generate prompt rewrites.
 */
export class PromptEvolver implements EvolutionStrategy {
    private readonly _model: ModelProvider;

    /**
     * Initialize the PromptEvolver.
     *
     * Args:
     *   model: A ModelProvider instance used to generate improved prompts.
     *          In production, this is a real LLM. In tests, use a mock.
     */
    constructor(model: ModelProvider) {
        this._model = model;
    }

    /** This strategy's name — 'prompt_evolver'. */
    get name(): string {
        return "prompt_evolver";
    }

    /**
     * Propose system prompt improvements based on trajectory analysis.
     *
     * Steps:
     * 1. Analyze the trajectory for signs of confusion, repetition, or errors
     * 2. Build a context describing what went wrong
     * 3. Ask the model to suggest improved instructions
     * 4. Return CodeMods targeting the system prompt file
     *
     * Args:
     *   trajectory: The agent's execution trajectory.
     *   eval_result: The evaluation result for this run.
     *   config: The current agent configuration.
     *   source_code: Dict mapping filename to file content.
     *
     * Returns:
     *   A list of CodeMod proposals targeting prompt files.
     */
    async propose(
        trajectory: unknown,
        eval_result: unknown,
        config: unknown,
        source_code: Record<string, string>,
    ): Promise<CodeMod[]> {
        // Step 1: Analyze trajectory for insights
        const insights = analyze_trajectory(trajectory as Trajectory);

        if (insights.length === 0 && this._has_good_score(eval_result)) {
            // No issues found and score is good — no changes needed
            return [];
        }

        // Step 2: Build context for the model
        const context = this._build_context(
            trajectory as Trajectory,
            eval_result,
            insights,
            source_code,
        );

        // Step 3: Ask the model for improved prompts
        const messages = [
            new Message({
                role: MessageType.SYSTEM,
                content: this._system_instruction(),
            }),
            new Message({ role: MessageType.USER, content: context }),
        ];

        const response = await this._model.complete(messages, null);

        // Step 4: Parse the response into CodeMods
        return this._parse_response(response, source_code);
    }

    private _has_good_score(eval_result: unknown): boolean {
        /**
         * Check if the evaluation score is already good enough.
         *
         * Args:
         *   eval_result: The evaluation result to check.
         *
         * Returns:
         *   True if score >= 0.8 (indicating good performance).
         */
        if (eval_result === null || eval_result === undefined) {
            return false;
        }
        const score =
            typeof eval_result === "object" && "score" in eval_result
                ? (eval_result as { score: unknown }).score
                : 0.0;
        return typeof score === "number" && score >= 0.8;
    }

    private _build_context(
        trajectory: Trajectory,
        eval_result: unknown,
        insights: Insight[],
        source_code: Record<string, string>,
    ): string {
        /**
         * Build the context string for the model prompt.
         *
         * This summarizes what happened and what went wrong, so the model
         * can suggest targeted improvements.
         */
        const parts: string[] = ["## Trajectory Analysis\n"];

        // Add trajectory summary
        const step_count = trajectory.steps?.length ?? 0;
        const total_reward = trajectory.total_reward ?? 0.0;
        parts.push(`Steps taken: ${step_count}`);
        parts.push(`Total reward: ${total_reward.toFixed(3)}`);

        // Add eval result
        if (eval_result !== null && eval_result !== undefined) {
            const score =
                typeof eval_result === "object" && "score" in eval_result
                    ? ((eval_result as { score: unknown }).score as number)
                    : 0.0;
            const passed =
                typeof eval_result === "object" && "passed" in eval_result
                    ? ((eval_result as { passed: unknown }).passed as boolean)
                    : false;
            const reason =
                typeof eval_result === "object" && "reason" in eval_result
                    ? ((eval_result as { reason: unknown }).reason as string)
                    : "";
            parts.push(`Score: ${score.toFixed(3)} (passed=${passed})`);
            if (reason) {
                parts.push(`Reason: ${reason}`);
            }
        }

        // Add insights
        if (insights.length > 0) {
            parts.push("\n## Insights\n");
            for (const insight of insights) {
                parts.push(
                    `- [${insight.severity}] ${insight.category}: ${insight.description}`,
                );
                if (insight.suggested_fix) {
                    parts.push(`  Suggested fix: ${insight.suggested_fix}`);
                }
            }
        }

        // Add current system prompt (if present in source)
        for (const [fname, content] of Object.entries(source_code)) {
            if (
                fname.toLowerCase().includes("prompt") ||
                fname.toLowerCase().includes("system")
            ) {
                parts.push(
                    `\n## Current ${fname}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``,
                );
            }
        }

        return parts.join("\n");
    }

    private _system_instruction(): string {
        /**
         * The system instruction for the prompt improvement model.
         *
         * Returns:
         *   A system prompt telling the model what to do.
         */
        return (
            "You are a prompt engineering expert. Analyze the agent's performance " +
            "data and suggest improved system prompts. Return your suggestions as " +
            "a JSON object with fields: target_file, description, diff, rationale, " +
            "expected_impact. The diff should be a unified diff format."
        );
    }

    private _parse_response(
        response: { content?: string } | string,
        source_code: Record<string, string>,
    ): CodeMod[] {
        /**
         * Parse the model's response into CodeMod proposals.
         *
         * The model should return JSON with fields matching CodeMod.
         * If parsing fails, return an empty list (don't crash the evolution loop).
         *
         * Args:
         *   response: The model's response Message.
         *   source_code: Current source code (for fallback targeting).
         *
         * Returns:
         *   A list of parsed CodeMod objects.
         */
        let content = "";
        if (typeof response === "string") {
            content = response;
        } else if (
            response !== null &&
            typeof response === "object" &&
            "content" in response
        ) {
            content = (response as { content: string }).content;
        }

        if (!content) {
            return [];
        }

        // Try to parse as JSON
        try {
            const data = JSON.parse(content) as
                | Record<string, unknown>
                | Record<string, unknown>[];
            // Handle both single object and list
            const items: Record<string, unknown>[] = Array.isArray(data)
                ? data
                : [data];
            const mods: CodeMod[] = [];
            for (const item of items) {
                if (item !== null && typeof item === "object") {
                    mods.push(
                        new CodeMod({
                            target_file: (item["target_file"] as string) ?? "",
                            description: (item["description"] as string) ?? "",
                            diff: (item["diff"] as string) ?? "",
                            rationale: (item["rationale"] as string) ?? "",
                            expected_impact:
                                (item["expected_impact"] as string) ?? "",
                        }),
                    );
                }
            }
            return mods;
        } catch {
            // JSON parsing failed — fall through to raw-text fallback
        }

        // Fallback: create a single CodeMod from the raw text
        const target = Object.keys(source_code)[0] ?? "system_prompt.py";
        return [
            new CodeMod({
                target_file: target,
                description: "Prompt improvement suggested by evolver",
                diff: content.slice(0, 500),
                rationale:
                    "Generated by prompt evolver based on trajectory analysis",
                expected_impact: "Improved agent behavior",
            }),
        ];
    }
}

// ---------------------------------------------------------------------------
// ConfigEvolver — proposes config changes
// ---------------------------------------------------------------------------

/**
 * Proposes configuration changes based on trajectory analysis.
 *
 * Plain English: This is like a settings optimizer. It looks at how the
 * agent performed and suggests tweaking the knobs and dials:
 * - "Turn on the retry flag — the agent failed too often."
 * - "Increase the budget — it ran out of steps."
 * - "Disable that plugin — it was causing confusion."
 *
 * Unlike PromptEvolver, ConfigEvolver doesn't need a language model.
 * It uses simple heuristics based on the trajectory metrics.
 *
 * Attributes:
 *   _score_threshold: Below this score, propose config changes.
 *   _step_threshold: Above this step count, flag as "too many steps".
 */
export class ConfigEvolver implements EvolutionStrategy {
    private readonly _score_threshold: number;
    private readonly _step_threshold: number;

    /**
     * Initialize the ConfigEvolver.
     *
     * Args:
     *   score_threshold: Score below which config changes are proposed.
     *   step_threshold: Step count above which efficiency flags are proposed.
     */
    constructor(score_threshold: number = 0.7, step_threshold: number = 50) {
        this._score_threshold = score_threshold;
        this._step_threshold = step_threshold;
    }

    /** This strategy's name — 'config_evolver'. */
    get name(): string {
        return "config_evolver";
    }

    /**
     * Propose config changes based on trajectory metrics.
     *
     * Heuristics:
     * - Low score → suggest increasing max_steps or budget
     * - Too many steps → suggest enabling retry flags
     * - High tool error rate → suggest adding error-handling processors
     *
     * Args:
     *   trajectory: The agent's execution trajectory.
     *   eval_result: The evaluation result for this run.
     *   config: The current agent configuration.
     *   source_code: Dict mapping filename to file content.
     *
     * Returns:
     *   A list of CodeMod proposals targeting config files.
     */
    propose(
        trajectory: unknown,
        eval_result: unknown,
        _config: unknown,
        source_code: Record<string, string>,
    ): CodeMod[] {
        const mods: CodeMod[] = [];

        // Target a config file that actually exists in the source map. A hard-coded
        // 'config.py' is usually absent, so the mod could never apply (bug M4).
        const target = this._pick_target(source_code);

        const score =
            eval_result !== null &&
            eval_result !== undefined &&
            typeof eval_result === "object"
                ? (((eval_result as { score?: unknown }).score as number) ??
                  0.0)
                : 0.0;
        const step_count =
            trajectory !== null &&
            typeof trajectory === "object" &&
            "steps" in trajectory
                ? ((trajectory as { steps: unknown }).steps as unknown[]).length
                : 0;

        // Heuristic 1: Low score → suggest budget increase
        if (score < this._score_threshold) {
            mods.push(
                new CodeMod({
                    target_file: target,
                    description: "Increase budget due to low score",
                    diff: this._budget_diff(trajectory),
                    rationale: `Score ${score.toFixed(3)} is below threshold ${this._score_threshold}. The agent may need more resources to complete tasks effectively.`,
                    expected_impact: "Higher score with increased budget",
                }),
            );
        }

        // Heuristic 2: Too many steps → suggest efficiency improvements
        if (step_count > this._step_threshold) {
            mods.push(
                new CodeMod({
                    target_file: target,
                    description:
                        "Enable efficiency flags due to excessive steps",
                    diff: this._efficiency_diff(),
                    rationale: `Agent took ${step_count} steps (threshold: ${this._step_threshold}). Enabling retry limits and early-stop flags may help.`,
                    expected_impact: "Fewer steps per task, faster completion",
                }),
            );
        }

        // Heuristic 3: Check for tool errors in trajectory
        const tool_errors = this._count_tool_errors(trajectory);
        if (tool_errors > 2) {
            mods.push(
                new CodeMod({
                    target_file: target,
                    description: "Add error recovery due to tool failures",
                    diff: this._error_recovery_diff(),
                    rationale: `Detected ${tool_errors} tool errors in trajectory. Adding error recovery processors may improve reliability.`,
                    expected_impact: "Fewer failures from tool errors",
                }),
            );
        }

        return mods;
    }

    /**
     * Choose a config file to target from the actual source map.
     *
     * Prefers a file whose name looks config-related; otherwise falls back to any
     * available file, and finally to a bare 'config.py' when the map is empty
     * (bug M4).
     */
    private _pick_target(source_code: Record<string, string>): string {
        const names = Object.keys(source_code);
        if (names.length > 0) {
            for (const name of names) {
                const lowered = name.toLowerCase();
                if (
                    lowered.includes("config") ||
                    lowered.includes("settings")
                ) {
                    return name;
                }
            }
            return names[0];
        }
        return "config.py";
    }

    private _budget_diff(_trajectory: unknown): string {
        /**
         * Generate a diff that increases the budget.
         *
         * Returns:
         *   A unified diff string suggesting budget increase.
         */
        return (
            "--- a/config.py\n" +
            "+++ b/config.py\n" +
            "@@ -1,3 +1,3 @@\n" +
            " budget = Budget(\n" +
            "-    max_tokens=10000,\n" +
            "+    max_tokens=20000,\n" +
            " )\n"
        );
    }

    private _efficiency_diff(): string {
        /**
         * Generate a diff that enables efficiency flags.
         *
         * Returns:
         *   A unified diff string suggesting efficiency improvements.
         */
        return (
            "--- a/config.py\n" +
            "+++ b/config.py\n" +
            "@@ -1,3 +1,4 @@\n" +
            " flags = {\n" +
            '     "retry_on_error": True,\n' +
            '+    "early_stop_on_loop": True,\n' +
            '     "max_tool_retries": 3,\n' +
            " }\n"
        );
    }

    private _error_recovery_diff(): string {
        /**
         * Generate a diff that adds error recovery.
         *
         * Returns:
         *   A unified diff string suggesting error recovery.
         */
        return (
            "--- a/config.py\n" +
            "+++ b/config.py\n" +
            "@@ -1,3 +1,4 @@\n" +
            " processors = [\n" +
            "+    ErrorRecoveryProcessor(),\n" +
            "     ContextProcessor(),\n" +
            " ]\n"
        );
    }

    private _count_tool_errors(trajectory: unknown): number {
        /**
         * Count the number of tool errors in a trajectory.
         *
         * Looks at trajectory steps' observations for ToolResults with errors.
         *
         * Args:
         *   trajectory: The trajectory to analyze.
         *
         * Returns:
         *   Number of tool error observations found.
         */
        if (
            trajectory === null ||
            typeof trajectory !== "object" ||
            !("steps" in trajectory)
        ) {
            return 0;
        }

        let errors = 0;
        for (const step of (trajectory as { steps: unknown[] }).steps) {
            if (step === null || typeof step !== "object") {
                continue;
            }
            const observations =
                "observations" in step
                    ? ((step as { observations: unknown })
                          .observations as unknown[])
                    : [];
            for (const obs of observations) {
                if (obs instanceof ToolResult) {
                    if (obs.error !== null) {
                        errors++;
                    } else if (obs.is_error) {
                        errors++;
                    }
                } else if (obs !== null && typeof obs === "object") {
                    if (
                        "error" in obs &&
                        (obs as { error: unknown }).error !== null
                    ) {
                        errors++;
                    } else if (
                        "is_error" in obs &&
                        (obs as { is_error: unknown }).is_error
                    ) {
                        errors++;
                    }
                }
            }
        }
        return errors;
    }
}

// ---------------------------------------------------------------------------
// ToolEvolver — proposes tool implementation improvements
// ---------------------------------------------------------------------------

/**
 * Analyzes tool usage and proposes tool implementation improvements.
 *
 * Plain English: This is like a code reviewer who specializes in tool functions.
 * It looks at how tools are used in trajectories and proposes actual code
 * changes to make them more robust, efficient, and reliable.
 *
 * Unlike ConfigEvolver (which just changes settings), ToolEvolver proposes
 * changes to the actual tool code — adding error handling, improving validation,
 * optimizing performance, etc.
 *
 * It uses a language model to generate code improvements — because who better
 * to suggest code changes than another AI that understands code?
 */
export class ToolEvolver implements EvolutionStrategy {
    private readonly _model: ModelProvider;

    /**
     * Initialize the ToolEvolver.
     *
     * Args:
     *   model: A ModelProvider instance used to analyze tool code and propose improvements.
     */
    constructor(model: ModelProvider) {
        this._model = model;
    }

    /** This strategy's name — 'tool_evolver'. */
    get name(): string {
        return "tool_evolver";
    }

    /**
     * Propose tool implementation improvements based on trajectory analysis.
     *
     * Steps:
     * 1. Analyze trajectory for tool failures, errors, and inefficiencies
     * 2. Identify problematic tool implementations
     * 3. Ask the model to propose code improvements
     * 4. Return CodeMods targeting tool source files
     */
    async propose(
        trajectory: unknown,
        eval_result: unknown,
        _config: unknown,
        source_code: Record<string, string>,
    ): Promise<CodeMod[]> {
        // Step 1: Find tool-related issues in the trajectory
        const tool_issues = this._analyze_tool_usage(trajectory);

        if (
            tool_issues.length === 0 &&
            this._has_good_tool_score(eval_result)
        ) {
            // No issues found and tool performance is good
            return [];
        }

        // Step 2: Identify tool files in source code
        const tool_files = this._find_tool_files(source_code);

        // Step 3: Ask model to propose code improvements
        const context = this._build_tool_context(
            tool_issues,
            tool_files,
            source_code,
        );

        if (context === "") {
            return [];
        }

        const messages = [
            new Message({
                role: MessageType.SYSTEM,
                content: this._tool_system_instruction(),
            }),
            new Message({
                role: MessageType.USER,
                content: context,
            }),
        ];

        const response = await this._model.complete(messages, null);
        return this._parse_tool_response(response, source_code);
    }

    private _analyze_tool_usage(trajectory: unknown): Array<{
        tool_name: string;
        issue_type: string;
        description: string;
        count: number;
    }> {
        // Analyze tool usage and find issues
        const issues: Array<{
            tool_name: string;
            issue_type: string;
            description: string;
            count: number;
        }> = [];

        if (
            !trajectory ||
            typeof trajectory !== "object" ||
            !("steps" in trajectory)
        ) {
            return issues;
        }

        const steps = (trajectory as { steps: unknown[] }).steps;
        const tool_stats: Record<string, { errors: number; calls: number }> =
            {};

        for (const step of steps) {
            const observations =
                (step as { observations?: unknown[] })?.observations ?? [];
            for (const obs of observations) {
                if (obs instanceof ToolResult) {
                    // Use call_id as identifier since ToolResult doesn't have a name property
                    const tool_name = obs.call_id || "unknown_tool";
                    if (!tool_stats[tool_name]) {
                        tool_stats[tool_name] = { errors: 0, calls: 0 };
                    }
                    tool_stats[tool_name].calls++;
                    if (obs.error) {
                        tool_stats[tool_name].errors++;
                    }
                }
            }
        }

        // Find tools with high error rates
        for (const [tool_name, stats] of Object.entries(tool_stats)) {
            if (stats.calls > 0 && stats.errors / stats.calls > 0.3) {
                issues.push({
                    tool_name,
                    issue_type: "high_error_rate",
                    description: `Tool ${tool_name} has ${Math.round((stats.errors / stats.calls) * 100)}% error rate`,
                    count: stats.errors,
                });
            }
        }

        return issues;
    }

    private _has_good_tool_score(eval_result: unknown): boolean {
        if (!eval_result || typeof eval_result !== "object") {
            return false;
        }
        const hasToolMetrics =
            "tool_metrics" in (eval_result as Record<string, unknown>);
        if (!hasToolMetrics) {
            return false;
        }
        const tool_metrics = (
            eval_result as { tool_metrics?: { errors?: number } }
        ).tool_metrics;
        return !tool_metrics || tool_metrics.errors === 0;
    }

    private _find_tool_files(source_code: Record<string, string>): string[] {
        return Object.keys(source_code).filter(
            (key) =>
                key.includes("/tools/") ||
                key.includes("_tool.ts") ||
                key.endsWith("Tool.ts"),
        );
    }

    private _build_tool_context(
        issues: Array<{
            tool_name: string;
            issue_type: string;
            description: string;
            count: number;
        }>,
        tool_files: string[],
        source_code: Record<string, string>,
    ): string {
        if (issues.length === 0 || tool_files.length === 0) {
            return "";
        }

        let context = "## Tool Implementation Analysis\n\n";

        // Add issues
        context += "### Issues Found\n";
        for (const issue of issues) {
            context += `\n- **Tool**: ${issue.tool_name}\n`;
            context += `- **Issue**: ${issue.issue_type}\n`;
            context += `- **Description**: ${issue.description}\n`;
            context += `- **Occurrences**: ${issue.count}\n`;
        }

        // Add source code for affected tools
        context += "\n### Current Tool Implementations\n";
        for (const file of tool_files) {
            context += `\n\`${file}\`:\n\n\`typescript\n${source_code[file].substring(0, 1000)}\n\`\n`;
        }

        return context;
    }

    private _tool_system_instruction(): string {
        return `You are a tool implementation code reviewer and improvement suggestor.

Your job is to analyze tool code and suggest specific, actionable improvements based on usage patterns and errors.

Focus on:
1. **Error handling**: Add try-catch blocks, input validation, fallback strategies
2. **Robustness**: Handle edge cases, invalid inputs, network failures
3. **Efficiency**: Optimize expensive operations, add caching where appropriate
4. **Clarity**: Improve error messages, add documentation, use clear variable names

Return your suggestions in this JSON format:
{
  "improvements": [
    {
      "file": "path/to/tool.ts",
      "description": "What the change does",
      "diff": "--- old code\n+++ new code\n@@ -old,lines +new,lines @@\n old text\n+new text",
      "rationale": "Why this change is needed based on usage data",
      "expected_impact": "Metric that should improve"
    }
  ]
}

Only suggest changes that are clearly beneficial based on the usage data provided.`;
    }

    private _parse_tool_response(
        response: Message,
        source_code: Record<string, string>,
    ): CodeMod[] {
        let content = response.content;

        // Extract JSON if wrapped in other text
        const jsonMatch = content.match(/\{[\s\S]*"improvements"[\s\S]*\}/);
        if (!jsonMatch) {
            return [];
        }

        try {
            const data = JSON.parse(jsonMatch[0]) as {
                improvements?: Array<{
                    file: string;
                    description: string;
                    diff: string;
                    rationale: string;
                    expected_impact: string;
                }>;
            };

            const improvements = data.improvements ?? [];
            const mods: CodeMod[] = [];

            for (const item of improvements) {
                // Only suggest changes for files that exist
                if (item.file in source_code) {
                    mods.push(
                        new CodeMod({
                            target_file: item.file,
                            description: item.description,
                            diff: item.diff,
                            rationale: item.rationale,
                            expected_impact: item.expected_impact,
                        }),
                    );
                }
            }

            return mods;
        } catch {
            return [];
        }
    }
}

// ---------------------------------------------------------------------------
// ToolEvolver — proposes tool implementation improvements
// ---------------------------------------------------------------------------

/**
 * Analyzes tool usage and proposes tool implementation improvements.
 *
 * Plain English: This is like a code reviewer who watches how tools are used
 * and suggests improvements to make them more reliable and effective.
 *
 * It looks for patterns like:
 * - Tools with high error rates → suggest adding error handling
 * - Tools with slow performance → suggest optimization
 * - Tools being used incorrectly → suggest improving tool specifications
 */
export class ToolEvolver implements EvolutionStrategy {
    private readonly _model: ModelProvider;

    /**
     * Initialize the ToolEvolver.
     *
     * Args:
     *   model: A ModelProvider instance used to analyze tool code and suggest improvements.
     */
    constructor(model: ModelProvider) {
        this._model = model;
    }

    /** This strategy's name — 'tool_evolver'. */
    get name(): string {
        return "tool_evolver";
    }

    /**
     * Propose tool implementation improvements based on trajectory analysis.
     *
     * Steps:
     * 1. Analyze tool usage patterns in the trajectory
     * 2. Identify problematic tool calls (errors, slow performance, etc.)
     * 3. Ask the model to suggest tool implementation improvements
     * 4. Return CodeMods targeting tool implementation files
     */
    async propose(
        trajectory: unknown,
        eval_result: unknown,
        _config: unknown,
        source_code: Record<string, string>,
    ): Promise<CodeMod[]> {
        // Step 1: Analyze tool usage patterns
        const tool_analysis = this._analyze_tool_usage(trajectory);

        // Step 2: Identify tools with issues
        const problematic_tools =
            this._identify_problematic_tools(tool_analysis);
        if (problematic_tools.length === 0) {
            return [];
        }

        // Step 3: Build context for the model
        const context = this._build_tool_context(
            problematic_tools,
            source_code,
        );

        // Step 4: Ask the model for tool improvements
        const messages = [
            new Message({
                role: MessageType.SYSTEM,
                content: this._tool_system_instruction(),
            }),
            new Message({ role: MessageType.USER, content: context }),
        ];

        const response = await this._model.complete(messages, null);

        // Step 5: Parse response into CodeMods
        return this._parse_tool_response(response);
    }

    /**
     * Analyze tool usage in the trajectory.
     *
     * Returns tool performance statistics including error rates, average duration, etc.
     */
    private _analyze_tool_usage(
        trajectory: unknown,
    ): Record<string, { errors: number; calls: number; durations: number[] }> {
        const tool_stats: Record<
            string,
            { errors: number; calls: number; durations: number[] }
        > = {};

        if (
            !trajectory ||
            typeof trajectory !== "object" ||
            !("steps" in trajectory)
        ) {
            return tool_stats;
        }

        const steps = (trajectory as { steps: unknown[] }).steps;
        for (const step of steps) {
            if (step && "tool_call" in step) {
                const toolCall = (step as { tool_call?: unknown })
                    ?.tool_call as { name?: string };
                if (!toolCall || !("name" in toolCall)) continue;

                const tool_name = (toolCall as { name: string }).name;
                if (!tool_stats[tool_name]) {
                    tool_stats[tool_name] = {
                        errors: 0,
                        calls: 0,
                        durations: [],
                    };
                }

                tool_stats[tool_name].calls++;

                // Check if tool call resulted in error
                if (step && "tool_result" in step) {
                    const toolResult = (step as { tool_result?: unknown })
                        ?.tool_result as { error?: string };
                    if (toolResult && toolResult.error) {
                        tool_stats[tool_name].errors++;
                    }
                }
            }
        }

        return tool_stats;
    }

    /**
     * Identify tools that have performance issues.
     */
    private _identify_problematic_tools(
        tool_analysis: Record<
            string,
            { errors: number; calls: number; durations: number[] }
        >,
    ): string[] {
        const problematic: string[] = [];
        const HIGH_ERROR_RATE = 0.3; // 30% error rate is problematic
        const MIN_CALLS = 5; // Need minimum 5 calls to judge

        for (const [tool_name, stats] of Object.entries(tool_analysis)) {
            if (stats.calls < MIN_CALLS) continue;

            const error_rate = stats.errors / stats.calls;
            if (error_rate > HIGH_ERROR_RATE) {
                problematic.push(tool_name);
            }
        }

        return problematic;
    }

    /**
     * Build context string for the model to analyze.
     */
    private _build_tool_context(
        problematic_tools: string[],
        source_code: Record<string, string>,
    ): string {
        const parts: string[] = ["## Tool Performance Analysis\n"];

        parts.push("### Problematic Tools Found:\n");
        for (const tool_name of problematic_tools) {
            parts.push(
                `- ${tool_name}: High error rate or other performance issues\n`,
            );
        }

        parts.push("\n### Tool Implementations to Review:\n");
        for (const [file_path, source] of Object.entries(source_code)) {
            if (file_path.includes("tool") || file_path.includes("Tool")) {
                parts.push(`\n
t# ${file_path}

t
${source.substring(0, 5000)}


t
`);
            }
        }

        return parts.join("");
    }

    /**
     * Generate system instruction for tool analysis.
     */
    private _tool_system_instruction(): string {
        return `You are a tool implementation code reviewer. Analyze the tool implementations provided and suggest specific code improvements to:

1. Improve error handling (add proper try/catch blocks, input validation)
2. Add better error messages
3. Optimize performance (cache results, reduce redundant operations)
4. Add type checking and input validation
5. Improve robustness against edge cases

Respond with a list of proposed code modifications in this JSON format:
[{
  "target_file": "path/to/tool/file.ts",
  "description": "Brief description of the improvement",
  "diff": "unified diff showing the exact changes",
  "rationale": "Why this change is needed based on error patterns",
  "expected_impact": "Metric that should improve"
}]

Focus on improvements that will reduce error rates and improve tool reliability.`;
    }

    /**
     * Parse the model's response into CodeMod proposals.
     */
    private _parse_tool_response(response: Message): CodeMod[] {
        try {
            const content = response.content;
            const mods: CodeMod[] = [];

            // Try to extract JSON from the response
            const json_match = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
            if (!json_match) {
                return [];
            }

            const proposed_mods = JSON.parse(json_match[0]);
            if (!Array.isArray(proposed_mods)) {
                return [];
            }

            for (const item of proposed_mods) {
                if (item.target_file && item.diff) {
                    mods.push(
                        new CodeMod({
                            target_file: item.target_file,
                            description:
                                item.description || "No description provided",
                            diff: item.diff,
                            rationale:
                                item.rationale || "No rationale provided",
                            expected_impact:
                                item.expected_impact || "No expected impact",
                        }),
                    );
                }
            }

            return mods;
        } catch {
            return [];
        }
    }
}

// ---------------------------------------------------------------------------
// ToolEvolver — proposes tool implementation improvements
// ---------------------------------------------------------------------------

/**
 * Analyzes tool usage and proposes tool implementation improvements.
 *
 * Plain English: This is like a code reviewer watching tool usage patterns
 * and suggesting improvements to make tools more robust, efficient, or
 * better at handling edge cases.
 *
 * It looks at:
 * - Tools with high error rates → suggest error handling improvements
 * - Tools being used inefficiently → suggest optimization
 * - Tools with inconsistent patterns → suggest standardization
 */
export class ToolEvolver implements EvolutionStrategy {
    private readonly _model: ModelProvider;

    /**
     * Initialize the ToolEvolver.
     *
     * Args:
     *   model: A ModelProvider instance used to analyze tool code and suggest improvements.
     */
    constructor(model: ModelProvider) {
        this._model = model;
    }

    /** This strategy's name — 'tool_evolver'. */
    get name(): string {
        return "tool_evolver";
    }

    /**
     * Propose tool implementation improvements based on trajectory analysis.
     *
     * Steps:
     * 1. Analyze tool usage patterns in the trajectory
     * 2. Identify problematic tool calls (errors, inefficiency, etc.)
     * 3. Ask the model to suggest tool implementation improvements
     * 4. Return CodeMods targeting tool implementation files
     */
    async propose(
        trajectory: unknown,
        eval_result: unknown,
        _config: unknown,
        source_code: Record<string, string>,
    ): Promise<CodeMod[]> {
        // Step 1: Analyze tool usage patterns
        const tool_analysis = this._analyze_tool_usage(trajectory);

        // Step 2: Identify tools with issues
        const problematic_tools =
            this._identify_problematic_tools(tool_analysis);
        if (problematic_tools.length === 0) {
            return [];
        }

        // Step 3: Build context for the model
        const context = this._build_tool_context(
            problematic_tools,
            source_code,
        );

        // Step 4: Ask the model for tool improvements
        const messages = [
            new Message({
                role: MessageType.SYSTEM,
                content: this._tool_system_instruction(),
            }),
            new Message({ role: MessageType.USER, content: context }),
        ];

        const response = await this._model.complete(messages, null);

        // Step 5: Parse response into CodeMods
        return this._parse_tool_response(response);
    }

    /**
     * Analyze tool usage in the trajectory.
     *
     * Returns tool performance statistics including error rates, average duration, etc.
     */
    private _analyze_tool_usage(
        trajectory: unknown,
    ): Record<string, { errors: number; calls: number; durations: number[] }> {
        const tool_stats: Record<
            string,
            { errors: number; calls: number; durations: number[] }
        > = {};

        if (
            !trajectory ||
            typeof trajectory !== "object" ||
            !("steps" in trajectory)
        ) {
            return tool_stats;
        }

        const steps = (trajectory as { steps: unknown[] }).steps;
        for (const step of steps) {
            if (step && "tool_call" in step) {
                const toolCall = (step as { tool_call?: unknown })
                    ?.tool_call as { name?: string };
                if (!toolCall || !("name" in toolCall)) continue;

                const tool_name = (toolCall as { name: string }).name;
                if (!tool_stats[tool_name]) {
                    tool_stats[tool_name] = {
                        errors: 0,
                        calls: 0,
                        durations: [],
                    };
                }

                tool_stats[tool_name].calls++;

                // Check if tool call resulted in error
                if (step && "tool_result" in step) {
                    const toolResult = (step as { tool_result?: unknown })
                        ?.tool_result as { error?: string };
                    if (toolResult && toolResult.error) {
                        tool_stats[tool_name].errors++;
                    }
                }
            }
        }

        return tool_stats;
    }

    /**
     * Identify tools that have performance issues.
     */
    private _identify_problematic_tools(
        tool_analysis: Record<
            string,
            { errors: number; calls: number; durations: number[] }
        >,
    ): string[] {
        const problematic: string[] = [];
        const HIGH_ERROR_RATE = 0.3; // 30% error rate is problematic
        const MIN_CALLS = 5; // Need minimum 5 calls to judge

        for (const [tool_name, stats] of Object.entries(tool_analysis)) {
            if (stats.calls < MIN_CALLS) continue;

            const error_rate = stats.errors / stats.calls;
            if (error_rate > HIGH_ERROR_RATE) {
                problematic.push(tool_name);
            }
        }

        return problematic;
    }

    /**
     * Build context string for the model to analyze.
     */
    private _build_tool_context(
        problematic_tools: string[],
        source_code: Record<string, string>,
    ): string {
        const parts: string[] = ["## Tool Performance Analysis\n"];

        parts.push("### Problematic Tools Found:\n");
        for (const tool_name of problematic_tools) {
            parts.push(
                `- ${tool_name}: High error rate or other performance issues\n`,
            );
        }

        parts.push("\n### Tool Implementations to Review:\n");
        for (const [file_path, source] of Object.entries(source_code)) {
            if (file_path.includes("tool") || file_path.includes("Tool")) {
                parts.push(`\n
# ${file_path}


${source.substring(0, 5000)}


`);
            }
        }

        return parts.join("");
    }

    /**
     * Generate system instruction for tool analysis.
     */
    private _tool_system_instruction(): string {
        return `You are a tool implementation code reviewer. Analyze the tool implementations provided and suggest specific code improvements to:

1. Improve error handling (add proper try/catch blocks, input validation)
2. Add better error messages
3. Optimize performance (cache results, reduce redundant operations)
4. Add type checking and input validation
5. Improve robustness against edge cases

Respond with a list of proposed code modifications in this JSON format:
[{
  "target_file": "path/to/tool/file.ts",
  "description": "Brief description of the improvement",
  "diff": "unified diff showing the exact changes",
  "rationale": "Why this change is needed based on error patterns",
  "expected_impact": "Metric that should improve"
}]

Focus on improvements that will reduce error rates and improve tool reliability.`;
    }

    /**
     * Parse the model's response into CodeMod proposals.
     */
    private _parse_tool_response(response: Message): CodeMod[] {
        try {
            const content = response.content;
            const mods: CodeMod[] = [];

            // Try to extract JSON from the response
            const json_match = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
            if (!json_match) {
                return [];
            }

            const proposed_mods = JSON.parse(json_match[0]);
            if (!Array.isArray(proposed_mods)) {
                return [];
            }

            for (const item of proposed_mods) {
                if (item.target_file && item.diff) {
                    mods.push(
                        new CodeMod({
                            target_file: item.target_file,
                            description:
                                item.description || "No description provided",
                            diff: item.diff,
                            rationale:
                                item.rationale || "No rationale provided",
                            expected_impact:
                                item.expected_impact || "No expected impact",
                        }),
                    );
                }
            }

            return mods;
        } catch {
            return [];
        }
    }
}

// ---------------------------------------------------------------------------
// ToolEvolver — proposes tool implementation improvements
// ---------------------------------------------------------------------------

/**
 * Analyzes tool usage and proposes tool implementation improvements.
 *
 * Plain English: This is like a code reviewer who watches how tools are used
 * and suggests improvements to make them more robust, efficient, or reliable.
 *
 * It looks for patterns like:
 * - Tools with high error rates → suggest adding error handling
 * - Tools with slow performance → suggest optimization
 * - Tools being used incorrectly → suggest better documentation
 */
export class ToolEvolver implements EvolutionStrategy {
    private readonly _model: ModelProvider;

    /**
     * Initialize the ToolEvolver.
     *
     * Args:
     *   model: A ModelProvider instance used to analyze tool code and suggest improvements.
     */
    constructor(model: ModelProvider) {
        this._model = model;
    }

    /** This strategy's name — 'tool_evolver'. */
    get name(): string {
        return "tool_evolver";
    }

    /**
     * Propose tool implementation improvements based on trajectory analysis.
     *
     * Steps:
     * 1. Analyze tool usage patterns in the trajectory
     * 2. Identify problematic tool calls (errors, slow performance, etc.)
     * 3. Ask the model to suggest tool implementation improvements
     * 4. Return CodeMods targeting tool implementation files
     */
    async propose(
        trajectory: unknown,
        eval_result: unknown,
        _config: unknown,
        source_code: Record<string, string>,
    ): Promise<CodeMod[]> {
        // Step 1: Analyze tool usage patterns
        const tool_analysis = this._analyze_tool_usage(trajectory);

        // Step 2: Identify tools with issues
        const problematic_tools =
            this._identify_problematic_tools(tool_analysis);
        if (problematic_tools.length === 0) {
            return [];
        }

        // Step 3: Build context for the model
        const context = this._build_tool_context(
            problematic_tools,
            source_code,
        );

        // Step 4: Ask the model for tool improvements
        const messages = [
            new Message({
                role: MessageType.SYSTEM,
                content: this._tool_system_instruction(),
            }),
            new Message({ role: MessageType.USER, content: context }),
        ];

        const response = await this._model.complete(messages, null);

        // Step 5: Parse response into CodeMods
        return this._parse_tool_response(response);
    }

    /**
     * Analyze tool usage in the trajectory.
     *
     * Returns tool performance statistics including error rates, average duration, etc.
     */
    private _analyze_tool_usage(
        trajectory: unknown,
    ): Record<string, { errors: number; calls: number; durations: number[] }> {
        const tool_stats: Record<
            string,
            { errors: number; calls: number; durations: number[] }
        > = {};

        if (
            !trajectory ||
            typeof trajectory !== "object" ||
            !("steps" in trajectory)
        ) {
            return tool_stats;
        }

        const steps = (trajectory as { steps: unknown[] }).steps;
        for (const step of steps) {
            if (step && "tool_call" in step) {
                const toolCall = (step as { tool_call?: unknown })
                    ?.tool_call as { name?: string };
                if (!toolCall || !("name" in toolCall)) continue;

                const tool_name = (toolCall as { name: string }).name;
                if (!tool_stats[tool_name]) {
                    tool_stats[tool_name] = {
                        errors: 0,
                        calls: 0,
                        durations: [],
                    };
                }

                tool_stats[tool_name].calls++;

                // Check if tool call resulted in error
                if (step && "tool_result" in step) {
                    const toolResult = (step as { tool_result?: unknown })
                        ?.tool_result as { error?: string };
                    if (toolResult && toolResult.error) {
                        tool_stats[tool_name].errors++;
                    }
                }
            }
        }

        return tool_stats;
    }

    /**
     * Identify tools that have performance issues.
     */
    private _identify_problematic_tools(
        tool_analysis: Record<
            string,
            { errors: number; calls: number; durations: number[] }
        >,
    ): string[] {
        const problematic: string[] = [];
        const HIGH_ERROR_RATE = 0.3; // 30% error rate is problematic
        const MIN_CALLS = 5; // Need minimum 5 calls to judge

        for (const [tool_name, stats] of Object.entries(tool_analysis)) {
            if (stats.calls < MIN_CALLS) continue;

            const error_rate = stats.errors / stats.calls;
            if (error_rate > HIGH_ERROR_RATE) {
                problematic.push(tool_name);
            }
        }

        return problematic;
    }

    /**
     * Build context string for the model to analyze.
     */
    private _build_tool_context(
        problematic_tools: string[],
        source_code: Record<string, string>,
    ): string {
        const parts: string[] = ["## Tool Performance Analysis\n"];

        parts.push("### Problematic Tools Found:\n");
        for (const tool_name of problematic_tools) {
            parts.push(
                `- ${tool_name}: High error rate or other performance issues\n`,
            );
        }

        parts.push("\n### Tool Implementations to Review:\n");
        for (const [file_path, source] of Object.entries(source_code)) {
            if (file_path.includes("tool") || file_path.includes("Tool")) {
                parts.push(`\n
# ${file_path}


${source.substring(0, 5000)}


`);
            }
        }

        return parts.join("");
    }

    /**
     * Generate system instruction for tool analysis.
     */
    private _tool_system_instruction(): string {
        return `You are a tool implementation code reviewer. Analyze the tool implementations provided and suggest specific code improvements to:

1. Improve error handling (add proper try/catch blocks, input validation)
2. Add better error messages
3. Optimize performance (cache results, reduce redundant operations)
4. Add type checking and input validation
5. Improve robustness against edge cases

Respond with a list of proposed code modifications in this JSON format:
[{
  "target_file": "path/to/tool/file.ts",
  "description": "Brief description of the improvement",
  "diff": "unified diff showing the exact changes",
  "rationale": "Why this change is needed based on error patterns",
  "expected_impact": "Metric that should improve"
}]

Focus on improvements that will reduce error rates and improve tool reliability.`;
    }

    /**
     * Parse the model's response into CodeMod proposals.
     */
    private _parse_tool_response(response: Message): CodeMod[] {
        try {
            const content = response.content;
            const mods: CodeMod[] = [];

            // Try to extract JSON from the response
            const json_match = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
            if (!json_match) {
                return [];
            }

            const proposed_mods = JSON.parse(json_match[0]);
            if (!Array.isArray(proposed_mods)) {
                return [];
            }

            for (const item of proposed_mods) {
                if (item.target_file && item.diff) {
                    mods.push(
                        new CodeMod({
                            target_file: item.target_file,
                            description:
                                item.description || "No description provided",
                            diff: item.diff,
                            rationale:
                                item.rationale || "No rationale provided",
                            expected_impact:
                                item.expected_impact || "No expected impact",
                        }),
                    );
                }
            }

            return mods;
        } catch {
            return [];
        }
    }
}

// ---------------------------------------------------------------------------
// CompositeEvolutionStrategy — runs multiple strategies, collects all proposals
// ---------------------------------------------------------------------------

/**
 * Runs multiple evolution strategies and aggregates all their proposals.
 *
 * Plain English: This is like a board of advisors. Each advisor (strategy)
 * looks at the same data and proposes changes in their area of expertise.
 * The composite collects ALL proposals from ALL advisors into one big list.
 *
 * The strategies are independent — they don't know about each other.
 * The PromotionGate later decides which proposals to actually apply.
 *
 * Attributes:
 *   _strategies: The list of strategies to run.
 */
export class CompositeEvolutionStrategy implements EvolutionStrategy {
    private readonly _strategies: EvolutionStrategy[];

    /**
     * Initialize the composite strategy.
     *
     * Args:
     *   strategies: List of EvolutionStrategy instances to aggregate.
     */
    constructor(strategies: EvolutionStrategy[]) {
        this._strategies = [...strategies];
    }

    /** This strategy's name — 'composite'. */
    get name(): string {
        return "composite";
    }

    /** The list of sub-strategies (read-only view). */
    get strategies(): EvolutionStrategy[] {
        return [...this._strategies];
    }

    /**
     * Run all sub-strategies and collect all proposals.
     *
     * Each strategy runs independently. If one strategy fails, the
     * others still run — we don't let one bad apple spoil the bunch.
     *
     * Args:
     *   trajectory: The agent's execution trajectory.
     *   eval_result: The evaluation result for this run.
     *   config: The current agent configuration.
     *   source_code: Dict mapping filename to file content.
     *
     * Returns:
     *   A combined list of CodeMod proposals from all strategies.
     */
    async propose(
        trajectory: unknown,
        eval_result: unknown,
        config: unknown,
        source_code: Record<string, string>,
    ): Promise<CodeMod[]> {
        const all_mods: CodeMod[] = [];

        for (const strategy of this._strategies) {
            try {
                const mods = await strategy.propose(
                    trajectory,
                    eval_result,
                    config,
                    source_code,
                );
                all_mods.push(...mods);
            } catch {
                // Strategy failed — skip it but don't crash the whole loop
                // In production, this would be logged
            }
        }

        return all_mods;
    }
}
