# System: Autonomous Stardew Valley Agent (ASVA)

## Overview
ASVA is a local-first AI agent designed to play Stardew Valley autonomously. It uses a multi-layered architecture to separate high-level strategic planning (via Ollama LLM) from low-level deterministic execution (via SMAPI).

## Core Architecture
- **L4 Strategic**: Multi-week goal setting and seasonal planning (LLM).
- **L3 Tactical**: Daily task scheduling and resource optimization (LLM).
- **L2 Execution**: Deterministic action dispatch, pathfinding, and UI handling.
- **L1 Infrastructure**: SMAPI Bridge (WebSocket), Ollama Client (HTTP), State Repository (SQLite).

## Key Technologies
- **Backend**: Node.js (Agent), C#/.NET (SMAPI Bridge).
- **LLM**: Ollama (local inference).
- **Database**: SQLite (WAL mode).
- **Protocol**: Local WebSocket for game interaction; REST for observability.

## Engineering Principles (GEMINI Rules)
- Strict dependency direction: UI → Service → Repository → DB.
- Zero `any` at API boundaries.
- Zod validation for all LLM outputs and API requests.
- Fail loudly, never silent; structured JSON logging.
