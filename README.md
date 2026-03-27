# 🌾 ASVA: Autonomous Stardew Valley Agent

**ASVA** (Autonomous Stardew Valley Agent) is a cutting-edge, open-source AI agent designed to play and optimize progression in *Stardew Valley*. Powered by a local-first architecture and the **Ollama** LLM engine, ASVA observes the game state, reasons about goals, and executes complex tasks with surgical precision.

---

## 🌟 Support the Project
ASVA is a 100% **Open Source** project. If you find this project interesting, helpful, or just plain cool, please **give us a ⭐ star on GitHub**! It helps the project grow and motivates further development.

---

## 🏗️ Architecture: The 4-Layer Brain

ASVA is built on a strictly decoupled 4-layer architecture, ensuring high reliability and modularity:

### 🧠 L4: Strategic Layer (The Brain)
- **Component**: `DayPlanner`
- **Engine**: Ollama (`qwen3:4b`)
- **Role**: Analyzes the game day, weather, and farm state to generate a high-level `DayPlan` JSON. It decides *what* to do (e.g., "Water crops", "Go to the Mines").

### 📊 L3: Tactical Layer (The Intelligence)
- **Components**: `TaskScheduler`, `TaskExpander`, `ReplanEngine`
- **Role**: Translates abstract goals into concrete coordinates. It expands "Water Crops" into N individual watering tasks for every dry tile on your farm. It handles reactive replanning if a path is blocked.

### ⚙️ L2: Execution Layer (The Reflexes)
- **Components**: `ActionDispatcher`, `Pathfinder`, `InventoryManager`
- **Role**: The "hands" of the agent. It calculates A* paths, manages tool swapping, and sends raw action sequences (Move/Use/Equip) to the game.

### 🌉 L1: Infrastructure Layer (The Senses)
- **Components**: `SMAPI Bridge` (C#), `OllamaClient`
- **Role**: Real-time bidirectional communication. It extracts the full GameState from Stardew Valley and injects actions back into the game loop.

---

## 🚀 Key Features

- **Local LLM Integration**: No API keys required. Uses Ollama to run powerful models (`qwen3`, `llama3`, `gemma`) entirely on your hardware.
- **Dynamic Replanning**: If a cat sits in the agent's path or a tool runs out of water, the `ReplanEngine` detects the stall and adjusts the queue in real-time.
- **Deterministic Pathfinding**: Custom A* pathfinding built for the Stardew grid, handling multi-map transitions and obstacle avoidance.
- **Robust Type Safety**: Built with 100% strict TypeScript and Zod schema validation for all LLM inputs/outputs.
- **Observability**: Built-in pino logging and decision-tracing for every LLM call made.

---

## 🛠️ Tech Stack

- **Agent**: Node.js 20+, TypeScript, Vitest.
- **Game Bridge**: C# / SMAPI (Stardew Modding API).
- **Inference**: Ollama (Local REST API).
- **Storage**: SQLite (via `better-sqlite3`).

---

## 📖 Getting Started

1. **Install Ollama**: Download and run [Ollama](https://ollama.ai/).
2. **Pull the Model**: `ollama pull qwen3:4b`
3. **Setup the Bridge**: Copy the `apps/smapi-bridge` folder to your Stardew Valley `Mods` directory.
4. **Install Dependencies**: `npm install` in the root.
5. **Start the Agent**: `npm run dev:agent`

---

## 🤝 Contributing
ASVA is open to contributions! Whether it's improving pathfinding heuristics, adding new LLM prompts, or fixing bugs, feel free to open a PR.

---

*Hehe, don't forget that star!* ⭐
