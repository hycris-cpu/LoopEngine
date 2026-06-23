# LoopEngine

A self-improving loop engineer agent framework.

LoopEngine is a Python library for building AI agents that can improve themselves by modifying their own code, prompts, and configuration. It provides a layered toolkit — primitives, composition, execution, evaluation, and evolution — that lets you assemble, run, benchmark, and evolve agent systems.

## Installation

Install the core package:

```bash
pip install loopengine
```

Install with all optional model-provider dependencies (Anthropic, OpenAI, etc.):

```bash
pip install "loopengine[full]"
```

For local development:

```bash
git clone <repository-url>
cd loopengine
pip install -e ".[dev,full]"
```

## Quick start

```python
import asyncio
import loopengine as le

# Build an agent configuration
config = (le.make_coding() | le.make_reliability()).build()

# Run it
async def main():
    harness = le.Harness(model=my_model, config=config)
    result = await harness.run(le.SimpleTask(prompt="Write a hello world"))
    print(result)

asyncio.run(main())
```

Run the full self-improvement loop:

```python
engine = le.LoopEngine(
    agent_builder=le.make_coding() | le.make_self_improve(),
    benchmark=le.Benchmark(judge=my_judge),
    strategies=[le.PromptEvolver(model=my_model)],
    gate=le.PromotionGate(),
)
report = await engine.run()
```

## Development

Run the test suite:

```bash
pytest
```

Run with coverage:

```bash
pytest --cov=loopengine
```

## Project structure

- `loopengine/primitives` — Events, state, tools, processors
- `loopengine/composition` — Builders, plugins, bundles, feature flags
- `loopengine/execution` — Run loop, harness, sandbox, tasks
- `loopengine/evaluation` — Judges, metrics, benchmarks
- `loopengine/evolution` — Self-improvement engine and strategies

## License

MIT. See [LICENSE](LICENSE) for details.
