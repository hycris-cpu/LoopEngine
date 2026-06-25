# LoopEngine — Comprehensive User Manual

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Architecture](#architecture)
4. [Layer 1: Primitives](#layer-1-primitives)
5. [Layer 2: Composition](#layer-2-composition)
6. [Layer 3: Execution](#layer-3-execution)
7. [Layer 4: Evaluation](#layer-4-evaluation)
8. [Layer 5: Evolution](#layer-5-evolution)
9. [TypeScript Port](#typescript-port)
10. [Complete Examples](#complete-examples)
11. [API Reference](#api-reference)
12. [Troubleshooting](#troubleshooting)

---

## Overview

LoopEngine is a framework for building AI agents that can **improve themselves** by modifying their own code, prompts, and configuration. Think of it as giving an AI the ability to be its own software engineer — it writes code, tests it, evaluates the results, and keeps the changes that work.

### What makes LoopEngine unique?

- **Self-improvement loop**: The agent can propose, test, and apply modifications to itself
- **Layered architecture**: Five clean layers from primitives to evolution, each building on the last
- **Dual-language**: Identical APIs in both Python and TypeScript
- **Immutable by default**: Events, snapshots, and decisions are frozen — history can't be rewritten
- **Composable bundles**: Mix and match capabilities with the `|` operator (like `make_coding() | make_reliability()`)
- **Out-of-process grading**: Tamper-resistant evaluation that the agent can't cheat

### When to use LoopEngine

- Building coding agents that improve over time
- Creating benchmark-driven agent optimization systems
- Prototyping self-modifying AI systems safely
- Running controlled A/B experiments on agent configurations

---

## Installation

### Python

```bash
# Core package
pip install loopengine

# With optional model providers (OpenAI, Anthropic, etc.)
pip install "loopengine[full]"

# For development
pip install -e ".[dev,full]"
```

### TypeScript

```bash
cd typescript
bun install
```

### Requirements

- Python ≥ 3.11
- Node.js ≥ 18 (for TypeScript version)
- Bun (for running TypeScript tests)

---

## Architecture

LoopEngine is organized into 5 layers, each building on the one below:

```
┌─────────────────────────────────────────────────────┐
│  Layer 5: EVOLUTION   — Self-improvement engine     │  LoopEngine, Strategies, PromotionGate
├─────────────────────────────────────────────────────┤
│  Layer 4: EVALUATION  — Judges, metrics, benchmarks │  Benchmark, Judge, Metric
├─────────────────────────────────────────────────────┤
│  Layer 3: EXECUTION   — Run loop, sandbox, harness  │  Harness, run_loop, Sandbox
├─────────────────────────────────────────────────────┤
│  Layer 2: COMPOSITION — Builder, plugins, bundles   │  HarnessBuilder, Plugin, Bundle
├─────────────────────────────────────────────────────┤
│  Layer 1: PRIMITIVES  — Events, state, tools, etc.  │  Event, Message, State, Tool
└─────────────────────────────────────────────────────┘
```

### Design Patterns Used

| Pattern | Where | Purpose |
|---------|-------|---------|
| **Protocol/Interface** | Tool, Judge, Strategy, Plugin | Duck-typed contracts — any object with the right methods works |
| **Immutable Value Objects** | Event, EvalResult, PromotionDecision | Frozen dataclasses — history can't be rewritten |
| **Builder** | HarnessBuilder | Fluent, immutable config assembly — each method returns a NEW builder |
| **Pipeline** | ProcessorChain | Composable event processing — chain processors like assembly line stations |
| **Observer/Hook** | 8 hook points | Event-driven interception — processors observe and transform events |
| **Strategy** | EvolutionStrategy | Pluggable improvement approaches — swap strategies without changing the engine |
| **Gate/Specification** | PromotionGate | Quality control — only approve changes that pass all checks |
| **Memento** | StateSnapshot | State checkpoint/restore — save and rewind the agent's working memory |
| **Composite** | CompositeJudge, CompositeEvolutionStrategy | Combine multiple strategies into one |

---

## Layer 1: Primitives

### Events — "Things That Happen"

Every action in the system is recorded as an immutable `Event`:

```python
from loopengine import Event, Message, ToolCall, ToolResult, EvalResult, MessageType

# A message in the conversation
msg = Message(role="user", content="What is 2+2?")
msg = Message(role="assistant", content="The answer is 4.")
msg = Message(role="system", content="You are a helpful math tutor.")

# A tool call request
tc = ToolCall(name="calculator", input={"expr": "2+2"})

# A tool result
tr = ToolResult(call_id=tc.id, output="4")

# An evaluation result
eval_r = EvalResult(passed=True, score=0.95, reason="Correct answer")
```

All events are **frozen** — once created, they can never be changed. This ensures the integrity of execution history.

### State — "Working Memory"

State is the agent's mutable desk while working:

```python
from loopengine import State, Budget, StateSnapshot, StateSlot

# Create a state with custom budget
state = State(budget=Budget(max_tokens=128000, max_cost_usd=10.0, max_steps=100))

# Add messages (dual-track: raw + model view)
state.add_message(Message(role="user", content="Hello"))     # Goes to BOTH tracks
state.add_raw_event(ToolCall(name="search", input={"q": "test"}))  # Raw track only
state.inject_message(Message(role="system", content="Hint: try X"))  # Model view only

# Use slots for cross-processor communication
state.set_slot("context", "file contents here", slot_type="context")
slot = state.get_slot("context")
state.delete_slot("context")

# Track resource usage
state.record_usage(tokens=500, cost_usd=0.02)
if state.is_budget_exhausted:
    print("Out of resources!")

# Checkpoint and restore
snapshot = state.snapshot()          # Save current state
# ... do some work ...
state.restore(snapshot)              # Roll back

# Compute what changed
delta = state.compute_delta(snapshot)
print(f"Created: {delta.created_slots}, Updated: {delta.updated_slots}")
```

### Tools — "What the Agent Can Do"

```python
from loopengine import Tool, ToolSchema, ToolRegistry, ToolContext, ToolNotFoundError

# Define a tool (satisfies the Tool protocol)
class CalculatorTool:
    @property
    def name(self) -> str:
        return "calculator"

    @property
    def description(self) -> str:
        return "Evaluate mathematical expressions"

    @property
    def input_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "expression": {"type": "string", "description": "Math expression to evaluate"}
            },
            "required": ["expression"]
        }

    async def execute(self, input: dict, ctx: ToolContext) -> ToolResult:
        try:
            result = eval(input["expression"])  # In production, use a safe evaluator!
            return ToolResult(call_id=ctx.run_id, output=str(result))
        except Exception as e:
            return ToolResult(call_id=ctx.run_id, output="", error=str(e))

# Register tools
registry = ToolRegistry()
schema = registry.register(CalculatorTool())

# Look up and execute
tool = registry.get("calculator")
schemas = registry.list_schemas()  # For sending to the model
```

### Processors — "Behavioral Building Blocks"

Processors intercept events at 8 hook points:

```python
from loopengine import MultiHookProcessor, ProcessorChain, pipe, HOOK_POINTS

# Hook points (in execution order):
# 1. task_start    — New task begins
# 2. step_start    — Step begins
# 3. before_model  — Right before calling the AI
# 4. after_model   — Right after the AI responds
# 5. before_tool   — Right before running a tool
# 6. after_tool    — Right after a tool finishes
# 7. step_end      — Step complete (read-only)
# 8. task_end      — Task complete

# Create a custom processor
class LoggingProcessor(MultiHookProcessor):
    def __init__(self):
        super().__init__(name="logging")

    async def on_after_model(self, event):
        print(f"Model responded at step {event.step_id}")
        yield event  # Pass through unchanged

# Chain processors together
chain = ProcessorChain([LoggingProcessor(), AnotherProcessor()])
results = await pipe(some_event, [proc1, proc2])
all_results = await pipe_all([event1, event2], [proc1, proc2])
```

### Trajectory — "Flight Recorder"

```python
from loopengine import Trajectory, TrajectoryStep, load_trajectory

# Trajectories are built during execution
traj = Trajectory(task_id="run_abc123")

# Add steps (normally done by run_loop, not manually)
step = TrajectoryStep(
    state_before=snapshot,
    action=assistant_message,
    observations=(tool_result,),
    reward=0.8,
    delta=state_delta,
)
traj.add_step(step)

# Access trajectory data
print(f"Steps: {len(traj)}")
print(f"Total reward: {traj.total_reward}")
print(f"Last step: {traj.last_step}")

# Serialize for analysis
traj.to_jsonl("run_abc123.jsonl")
loaded = load_trajectory("run_abc123.jsonl")
```

---

## Layer 2: Composition

### HarnessBuilder — "Configuring Your Agent"

```python
from loopengine import HarnessBuilder, HarnessConfig, make_coding, make_reliability

# Start from scratch
builder = HarnessBuilder()
builder = builder.add(my_processor, hook="after_model", order=0)
builder = builder.tool(my_tool)
builder = builder.flag("verbose", enabled=True)
builder = builder.slot(working_dir="/tmp/project")

# Or start from a bundle
builder = make_coding(working_dir="/my/project")

# Compose bundles with | operator
builder = make_coding() | make_reliability()
builder = make_coding() | make_reliability() | make_evaluation()

# Build the config
config = builder.build()

# Validate the config
errors = config.validate()
if errors:
    for e in errors:
        print(f"Config error: {e}")

# Get a fingerprint for identity comparison
print(f"Config fingerprint: {config.fingerprint()}")
```

### Feature Flags

```python
from loopengine import FeatureFlag, FlagRegistry, flag

# Create and register flags
registry = FlagRegistry()
f = flag(registry, "verbose_mode", default=True, description="Enable verbose output")

# Check and modify flags
registry.is_enabled("verbose_mode")  # True
registry.set("verbose_mode", False)
registry.is_enabled("verbose_mode")  # False

# Reset to defaults
registry.reset("verbose_mode")   # Reset one flag
registry.reset()                   # Reset all flags
```

### Plugins

```python
from loopengine import SimplePlugin, PluginLoader

# Create a plugin
plugin = SimplePlugin(
    name="my_plugin",
    processors=[(my_processor, "step_end", 0)],
    tools=[my_tool],
    flags={"my_plugin.enabled": True},
)

# Register and use
loader = PluginLoader()
loader.register(plugin)

# Integrate into builder
builder = builder.plugin(plugin)
```

---

## Layer 3: Execution

### Harness — "The Agent You Actually Use"

```python
from loopengine import Harness, SimpleTask, BatchTask, RunResult

# Create from a builder
harness = Harness.from_builder(builder, model=my_model, sandbox=sandbox)

# Or create directly
harness = Harness(model=my_model, config=config, sandbox=sandbox)

# Run a single task
result = await harness.run(SimpleTask(prompt="Write a hello world"))

# Run a batch of tasks
results = await harness.run_batch(
    [SimpleTask(prompt=f"Task {i}") for i in range(10)],
    parallelism=4  # Up to 4 tasks concurrently
)

# Inspect results
print(f"Steps: {result.total_steps}")
print(f"Tokens: {result.total_tokens}")
print(f"Exit reason: {result.exit_reason}")
print(f"Score: {result.eval_result.score}")
```

### Tasks

```python
from loopengine import SimpleTask, BatchTask, Budget

# Simple task with defaults
task = SimpleTask(prompt="Write a hello world")

# Custom limits
task = SimpleTask(
    prompt="Solve this complex problem",
    max_steps=50,
    budget=Budget(max_tokens=50000, max_cost_usd=5.0),
)

# With completion condition
task = SimpleTask(
    prompt="Fix all test failures",
    done_condition=lambda state: "all tests pass" in str(state.messages[-1].content),
)

# With custom evaluation
async def grade(trajectory, task):
    # Custom grading logic
    return EvalResult(passed=True, score=0.9, reason="Tests pass")

task = SimpleTask(prompt="Fix tests", eval_fn=grade)

# Batch of tasks
batch = BatchTask(tasks=[task1, task2, task3])
```

### Sandbox

```python
from loopengine import LocalSandbox, LocalSandboxProvider

# Direct sandbox usage
sandbox = LocalSandbox()
stdout, stderr, code = await sandbox.exec("python -c 'print(42)'")
content = await sandbox.read_file("output.txt")
await sandbox.write_file("input.txt", "Hello, World!")
files = await sandbox.list_dir(".")
matches = await sandbox.glob_files("**/*.py")
results = await sandbox.grep_files("TODO", ".")

# Pool of sandboxes (for parallel execution)
provider = LocalSandboxProvider()
sandbox = await provider.acquire()
try:
    # Use the sandbox
    await sandbox.exec("pytest")
finally:
    await provider.release(sandbox)

await provider.shutdown()
```

### Model Provider

```python
from loopengine import ModelProvider, Message

# Implement the ModelProvider protocol
class OpenAIModel:
    def __init__(self, client):
        self.client = client

    async def complete(self, messages, tools=None):
        response = await self.client.chat.completions.create(
            model="gpt-4",
            messages=[m.to_openai_dict() for m in messages],
            tools=tools,
        )
        # Convert OpenAI response to Message
        return Message(
            role="assistant",
            content=response.choices[0].message.content or "",
            tool_calls=tuple(...)  # Convert tool calls
        )

    def count_tokens(self, messages):
        return sum(len(m.content.split()) for m in messages)  # Rough estimate
```

---

## Layer 4: Evaluation

### Judges

```python
from loopengine import (
    Judge, TestSuiteJudge, LLMJudge, MetricJudge, CompositeJudge,
    Benchmark, BenchmarkResult, compare,
)

# Test-suite judge — runs actual tests
test_judge = TestSuiteJudge(test_command="pytest tests/", sandbox=sandbox)

# LLM judge — asks another AI to evaluate
llm_judge = LLMJudge(model=my_model, rubric="Check code quality and correctness")

# Metric judge — combines multiple metrics
metric_judge = MetricJudge(metrics=[pass_rate_metric, efficiency_metric])

# Composite judge — weighted average of multiple judges
composite = CompositeJudge([
    (test_judge, 0.6),   # 60% weight on automated tests
    (llm_judge, 0.4),    # 40% weight on LLM review
])

# Evaluate
result = await judge.evaluate(trajectory, task)
print(f"Score: {result.score}, Passed: {result.passed}, Reason: {result.reason}")
```

### Metrics

```python
from loopengine import PassRateMetric, EfficiencyMetric, CustomMetric

# Pass rate — runs tests and counts passes
pass_rate = PassRateMetric(test_command="pytest", sandbox=sandbox)

# Efficiency — fewer steps = better
efficiency = EfficiencyMetric()

# Custom — your own evaluation function
async def correctness(traj, task):
    # Your custom scoring logic
    return 0.85

custom = CustomMetric(name="correctness", eval_fn=correctness)
```

### Benchmarks

```python
from loopengine import Benchmark, BenchmarkResult, compare

# Create a benchmark
benchmark = Benchmark(judge=my_judge, parallelism=4)

# Run evaluation on results
result = await benchmark.run(run_results, tasks=task_list)

# Compare two benchmark runs
comparison = compare(baseline_result, candidate_result)
print(comparison.summary)
# Output:
#   Benchmark comparison:
#     Mean score: 0.65 → 0.82 (delta: +0.17)
#     Pass rate:  0.50 → 0.80 (delta: +0.30)
#     Tasks improved:   3
#     Tasks regressed:  0
#     Tasks unchanged:  2
```

### Out-of-Process Grading

```python
from loopengine import GradeResult, IsolatedGrader, is_better, make_subprocess_runner

# Run grading in a separate process for tamper resistance
runner = make_subprocess_runner("grade_submission.py", timeout=60)
grader = IsolatedGrader(runner, direction="maximize")

result = await grader.grade({"code": "def solve(): return 42"})
print(f"Score: {result.score}, Valid: {result.valid}")

# Compare results
if is_better(result_a, result_b, direction="maximize"):
    print("A is better!")

# Handle invalid submissions
invalid = GradeResult.invalid(direction="maximize")
# Score is -inf, so it can never rank as best
```

---

## Layer 5: Evolution

### The Self-Improvement Cycle

```
1. MEASURE:  Run benchmark → baseline score
2. ANALYZE:  Analyze trajectories → insights
3. PROPOSE:  Strategies generate → CodeMods
4. TEST:     Apply mods in sandbox → candidate score
5. DECIDE:    Promotion gate → promote or reject
6. APPLY:     If promoted → update real code
7. REPEAT
```

### Code Modifications

```python
from loopengine import CodeMod, CodeModSet, parse_unified_diff

# Create a code modification
mod = CodeMod(
    target_file="system_prompt.py",
    description="Add step counting to system prompt",
    diff="""--- a/system_prompt.py
+++ b/system_prompt.py
@@ -1,3 +1,4 @@
 SYSTEM_PROMPT = """
+You are on step {step}.
 You are a helpful coding assistant.
 """,
""",
    rationale="Agent repeats itself — adding step awareness may reduce loops",
    expected_impact="Fewer repeated actions, higher efficiency",
)

# Check safety before applying
if not mod.is_safe():
    print("Modification contains dangerous patterns!")

# Apply to source files
source = {"system_prompt.py": 'SYSTEM_PROMPT = """\nYou are a helpful coding assistant.\n"""'}
modified = mod.apply_to(source)

# Check if the mod actually landed
new_source, applied = mod.apply_with_status(source)
if not applied:
    print("The diff's anchor text wasn't found — mod didn't apply")

# Bundle multiple mods
mod_set = CodeModSet(mods=(mod1, mod2))
if mod_set.is_safe():
    modified = mod_set.apply_to(source)
```

### Trajectory Analysis

```python
from loopengine import Insight, analyze_trajectory, summarize_trajectory

# Analyze a trajectory for patterns
insights = analyze_trajectory(trajectory)
for insight in insights:
    print(f"[{insight.severity}] {insight.category}: {insight.description}")
    print(f"  Fix: {insight.suggested_fix}")

# Get a summary
summary = summarize_trajectory(trajectory)
print(f"Steps: {summary['total_steps']}, Reward: {summary['avg_reward']:.3f}")
print(f"Errors: {summary['error_count']}, Unique actions: {summary['unique_actions']}")
```

### Evolution Strategies

```python
from loopengine import PromptEvolver, ConfigEvolver, CompositeEvolutionStrategy

# Prompt improvement strategy
prompt_evolver = PromptEvolver(model=my_model)

# Config tuning strategy
config_evolver = ConfigEvolver(
    score_threshold=0.5,   # Trigger budget increase below this score
    step_threshold=15,     # Trigger efficiency flags above this step count
)

# Combine strategies
composite = CompositeEvolutionStrategy([prompt_evolver, config_evolver])
mods = await composite.propose(trajectory, eval_result, config, source_code)
```

### Promotion Gate

```python
from loopengine import PromotionGate, PromotionDecision

# Create a gate with custom thresholds
gate = PromotionGate(
    min_improvement=0.01,     # Require at least 1% improvement
    no_regression=0.02,       # Allow at most 2% regression per task
    require_safety=True,      # Enforce is_safe() checks
)

# Or with a custom optimization direction
gate = PromotionGate(
    is_better=lambda candidate, baseline: candidate < baseline,  # Lower is better
)

# Validate a proposed change
decision = await gate.validate(baseline_result, candidate_result, mods)
print(f"Promoted: {decision.promoted}")
print(f"Reason: {decision.reason}")
print(f"Details: {decision.details}")
```

### LoopEngine — The Orchestrator

```python
from loopengine import LoopEngine, EvolutionReport

# Create the self-improvement engine
engine = LoopEngine(
    agent_builder=lambda config: Harness(model=my_model, config=config),
    benchmark=Benchmark(judge=test_judge),
    strategies=[PromptEvolver(model=my_model), ConfigEvolver()],
    gate=PromotionGate(min_improvement=0.02),
    sandbox=sandbox,
    max_iterations=100,
    patience=5,               # Stop after 5 consecutive non-promotions
    workspace_root="/tmp/loopengine_ws",
    checkpoint_path="/tmp/loopengine_checkpoint.json",
)

# Run the self-improvement cycle
report = await engine.run()
print(report.summary())

# Or resume from a checkpoint
report = await engine.run()
```

### Diagnostics — "Codex-Style Feedback"

```python
from loopengine import (
    ExecutionResult, LspDiagnostic, LoopDetector, LoopWarning,
    DiagnosticContext, format_for_llm, success, failure,
)

# Capture execution results
result = success(stdout="42", tool_name="calculator", tool_input={"expr": "2+2"})
result = failure(stderr="File not found", tool_name="read_file", exit_code=1)

# Detect loops
detector = LoopDetector(window_size=20, threshold=3)
warning = detector.check(result)
if warning:
    print(f"Loop detected! {warning.tool_name} called {warning.repeat_count} times")

# Format for LLM consumption
output = format_for_llm(result, lsp_diagnostics=[...], loop_warning=warning)
# Returns structured JSON with output, metadata, diagnostics, and context
```

### Checkpointing

```python
from loopengine import CheckpointStore, EvolutionCheckpoint

# Create a store
store = CheckpointStore(path="/tmp/evolution_checkpoint.json")

# Save (atomic write)
store.save(EvolutionCheckpoint(
    iteration=5,
    history=[...],
    current_source={"main.py": "..."},
    current_config={"flags": {"verbose": True}},
    improvements=3,
    rejections=2,
    final_score=0.85,
))

# Load
checkpoint = store.load()
if checkpoint:
    print(f"Resuming from iteration {checkpoint.iteration}")
```

---

## TypeScript Port

The TypeScript port provides identical functionality with idiomatic TypeScript patterns:

### Key Differences from Python

| Python | TypeScript |
|--------|------------|
| `@dataclass(frozen=True)` | `class` with `readonly` properties |
| `typing.Protocol` | `interface` |
| `tuple[T, ...]` | `readonly T[]` |
| `dict[str, Any]` | `Record<string, unknown>` |
| `__or__` merge (`\|`) | `.merge(other)` method |
| `isinstance(obj, Protocol)` | Duck-typing checks |
| `pytest.raises` | `expect(() => ...).toThrow()` |
| `structlog` | `pino` logger |

### TypeScript Usage

```typescript
import {
  Harness, HarnessBuilder, SimpleTask, make_coding, make_reliability,
  Benchmark, TestSuiteJudge, LoopEngine, PromptEvolver, PromotionGate,
} from 'loopengine-ts';

// Build an agent
const builder = make_coding().merge(make_reliability());
const config = builder.build();

// Run it
const harness = new Harness({ model: myModel, config });
const result = await harness.run(new SimpleTask({ prompt: "Write a hello world" }));

// Self-improvement loop
const engine = new LoopEngine({
  agentBuilder: (cfg) => new Harness({ model: myModel, config: cfg }),
  benchmark: new Benchmark({ judge: myJudge }),
  strategies: [new PromptEvolver({ model: myModel })],
  gate: new PromotionGate({ minImprovement: 0.01 }),
});
const report = await engine.run();
```

---

## Complete Examples

### Example 1: Simple Coding Agent

```python
import asyncio
import loopengine as le

class MyModel:
    async def complete(self, messages, tools=None):
        # Call your LLM here
        return le.Message(role="assistant", content="Hello! I can help with that.")

    def count_tokens(self, messages):
        return sum(len(m.content.split()) for m in messages)

async def main():
    config = (le.make_coding() | le.make_reliability()).build()
    harness = le.Harness(model=MyModel(), config=config)
    result = await harness.run(le.SimpleTask(prompt="Write a Fibonacci function"))
    print(f"Exit: {result.exit_reason}, Steps: {result.total_steps}")

asyncio.run(main())
```

### Example 2: Benchmark-Driven Evaluation

```python
async def benchmark_example():
    # Create tasks
    tasks = [
        le.SimpleTask(prompt=f"Solve problem {i}", max_steps=20)
        for i in range(5)
    ]

    # Run all tasks
    harness = le.Harness.from_builder(
        le.make_coding(), model=MyModel(), sandbox=le.LocalSandbox()
    )
    results = await harness.run_batch(tasks, parallelism=2)

    # Evaluate
    judge = le.TestSuiteJudge("pytest tests/", sandbox=le.LocalSandbox())
    benchmark = le.Benchmark(judge=judge)
    benchmark_result = await benchmark.run(results, tasks=tasks)

    print(f"Mean score: {benchmark_result.aggregate['mean_score']:.2f}")
    print(f"Pass rate: {benchmark_result.aggregate['pass_rate']:.0%}")
```

### Example 3: Self-Improvement Loop

```python
async def evolution_example():
    source_code = {
        "agent.py": open("agent.py").read(),
        "config.py": open("config.py").read(),
    }

    engine = le.LoopEngine(
        agent_builder=lambda cfg: le.Harness(model=MyModel(), config=cfg),
        benchmark=le.Benchmark(judge=le.TestSuiteJudge("pytest", sandbox=le.LocalSandbox())),
        strategies=[le.PromptEvolver(model=MyModel()), le.ConfigEvolver()],
        gate=le.PromotionGate(min_improvement=0.02, no_regression=0.05),
        sandbox=le.LocalSandbox(),
        max_iterations=50,
        patience=3,
        checkpoint_path="/tmp/loopengine_checkpoint.json",
    )

    report = await engine.run()
    print(report.summary())

    if report.improvements > 0:
        print(f"\nAgent improved by {report.final_score - report.history[0]['score']:.4f}!")
```

---

## API Reference

### Full Export List

| Layer | Export | Type | Description |
|-------|--------|------|-------------|
| **1** | `Event` | Class | Base event class |
| **1** | `Message` | Class | Conversation message |
| **1** | `MessageType` | Enum | SYSTEM, USER, ASSISTANT, TOOL |
| **1** | `ToolCall` | Class | Tool call request |
| **1** | `ToolCallMetadata` | Class | Extra tool call info |
| **1** | `ToolResult` | Class | Tool execution result |
| **1** | `EvalResult` | Class | Evaluation outcome |
| **1** | `HOOK_POINTS` | List | 8 processor hook points |
| **1** | `Processor` | Protocol | Event processor interface |
| **1** | `MultiHookProcessor` | Class | Hook-routing base class |
| **1** | `ProcessorChain` | Class | Pipeline of processors |
| **1** | `pipe` | Function | Run event through processors |
| **1** | `pipe_all` | Function | Run multiple events through processors |
| **1** | `Tool` | Protocol | Tool interface |
| **1** | `ToolSchema` | Class | Tool interface definition |
| **1** | `ToolContext` | Class | Tool execution context |
| **1** | `ToolRegistry` | Class | Tool name → tool mapping |
| **1** | `ToolNotFoundError` | Exception | Tool not in registry |
| **1** | `State` | Class | Agent's working memory |
| **1** | `Budget` | Class | Resource limits |
| **1** | `StateSlot` | Class | Cross-processor slot |
| **1** | `StateSnapshot` | Class | Frozen state checkpoint |
| **1** | `StateDelta` | Class | State diff |
| **1** | `Trajectory` | Class | Execution record |
| **1** | `TrajectoryStep` | Class | Single trajectory step |
| **1** | `load_trajectory` | Function | Load trajectory from JSONL |
| **2** | `FeatureFlag` | Class | Named on/off switch |
| **2** | `FlagRegistry` | Class | Flag manager |
| **2** | `flag` | Function | Create + register flag |
| **2** | `HarnessConfig` | Class | Agent blueprint |
| **2** | `ProcessorEntry` | Class | Processor + hook + order |
| **2** | `HarnessBuilder` | Class | Immutable config factory |
| **2** | `Plugin` | Protocol | Capability bundle interface |
| **2** | `SimplePlugin` | Class | Concrete plugin |
| **2** | `PluginLoader` | Class | Plugin registry |
| **2** | `make_coding` | Function | Coding agent bundle |
| **2** | `make_reliability` | Function | Safety net bundle |
| **2** | `make_evaluation` | Function | Judge bundle |
| **2** | `make_self_improve` | Function | Evolution bundle |
| **3** | `RunResult` | Class | Run outcome |
| **3** | `ModelProvider` | Protocol | LLM interface |
| **3** | `run_loop` | Function | Main execution loop |
| **3** | `Harness` | Class | Top-level agent API |
| **3** | `Sandbox` | Protocol | Execution environment |
| **3** | `LocalSandbox` | Class | Host machine sandbox |
| **3** | `SandboxProvider` | Protocol | Sandbox pool |
| **3** | `LocalSandboxProvider` | Class | Local sandbox pool |
| **3** | `Task` | Protocol | Task interface |
| **3** | `SimpleTask` | Class | Basic task |
| **3** | `BatchTask` | Class | Multiple tasks |
| **4** | `Judge` | Protocol | Evaluator interface |
| **4** | `TestSuiteJudge` | Class | Test-based judge |
| **4** | `LLMJudge` | Class | AI-based judge |
| **4** | `MetricJudge` | Class | Multi-metric judge |
| **4** | `CompositeJudge` | Class | Weighted judge panel |
| **4** | `Metric` | Protocol | Single measurement |
| **4** | `PassRateMetric` | Class | Test pass rate |
| **4** | `EfficiencyMetric` | Class | Step efficiency |
| **4** | `CustomMetric` | Class | User-defined metric |
| **4** | `Benchmark` | Class | Multi-task evaluator |
| **4** | `BenchmarkResult` | Class | Benchmark outcome |
| **4** | `Comparison` | Class | Benchmark diff |
| **4** | `compare` | Function | Compare two benchmarks |
| **4** | `GradeResult` | Class | Grader verdict |
| **4** | `IsolatedGrader` | Class | Out-of-process grader |
| **4** | `is_better` | Function | Compare GradeResults |
| **4** | `make_subprocess_runner` | Function | Subprocess grader |
| **5** | `CodeMod` | Class | Proposed modification |
| **5** | `CodeModSet` | Class | Bundle of modifications |
| **5** | `parse_unified_diff` | Function | Parse unified diff |
| **5** | `Insight` | Class | Trajectory observation |
| **5** | `analyze_trajectory` | Function | Find patterns in trajectory |
| **5** | `summarize_trajectory` | Function | Quick trajectory summary |
| **5** | `EvolutionStrategy` | Protocol | Improvement strategy |
| **5** | `PromptEvolver` | Class | Prompt improvement |
| **5** | `ConfigEvolver` | Class | Config tuning |
| **5** | `CompositeEvolutionStrategy` | Class | Multi-strategy |
| **5** | `PromotionDecision` | Class | Gate verdict |
| **5** | `PromotionGate` | Class | Quality gate |
| **5** | `EvolutionReport` | Class | Evolution summary |
| **5** | `LoopEngine` | Class | Self-improvement orchestrator |
| **5** | `CheckpointStore` | Class | Checkpoint read/write |
| **5** | `EvolutionCheckpoint` | Class | Resumable state |
| **5** | `ExecutionResult` | Class | Raw command output |
| **5** | `LspDiagnostic` | Class | Code-level error |
| **5** | `LoopDetector` | Class | Repeated-action detector |
| **5** | `LoopWarning` | Class | Loop detection alert |
| **5** | `DiagnosticContext` | Class | Data availability tracker |
| **5** | `format_for_llm` | Function | Format diagnostics for AI |
| **5** | `success` | Function | Create successful result |
| **5** | `failure` | Function | Create failed result |

---

## Troubleshooting

### Common Issues

**Q: "Tool not found" error when calling tools**
A: Make sure the tool is registered in your `HarnessConfig` via `builder.tool(my_tool)`.

**Q: FeatureFlag with `default=True` but `value=False` keeps getting overridden to `True`**
A: This was a bug in v0.1.0 — fixed. Update to the latest version.

**Q: Tool schemas not working with OpenAI API**
A: This was a bug where raw JSON Schema was passed instead of OpenAI format — fixed. Update to the latest version.

**Q: `is_safe()` returns True for all modifications**
A: This was caused by dangerous stub imports — fixed. Make sure you're not using old `try/except ImportError` stubs.

**Q: Agent runs forever without stopping**
A: Check your `Budget.max_steps` and ensure the task's `is_done()` method works correctly. Also verify `done_condition` is set.

**Q: How do I persist and resume evolution runs?**
A: Use the `checkpoint_path` parameter when creating `LoopEngine`. It automatically saves after each iteration and resumes on the next run.

**Q: How do I prevent the agent from cheating on evaluations?**
A: Use `IsolatedGrader` with `make_subprocess_runner()` to run grading in a separate process that the agent can't access or modify.

### Running Tests

```bash
# Python
pytest tests/ -v

# TypeScript
cd typescript && bun test

# With coverage
pytest --cov=loopengine --cov-report=html
```
