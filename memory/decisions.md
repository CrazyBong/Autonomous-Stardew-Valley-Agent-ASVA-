# Decisions

## Architecture Decisions
- **ADR-001**: Use Local WebSocket for Bridge communication (Node.js <-> C# boundary).
- **ADR-002**: Use SQLite for persistence to minimize infrastructure overhead.
- **ADR-003**: Deterministic execution layer to handle game tick timing separately from LLM latency.
- **ADR-004**: Versioned Markdown files for prompts to ensure reproducibility.

## Pattern Choices
- **Repository Pattern**: All DB access abstracted via L1.
- **Event Bus**: Inter-layer communication to prevent circular dependencies.
- **Zod Validation**: Guardrail for non-deterministic LLM responses.
