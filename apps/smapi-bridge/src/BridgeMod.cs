using System.Collections.Concurrent;
using StardewModdingAPI;
using StardewModdingAPI.Events;

namespace AsvaSmapiMod
{
    /// <summary>
    /// SMAPI entry point for the ASVA Bridge Mod.
    /// Bootstraps the WebSocket server, event forwarder, and action injector.
    /// </summary>
    public class BridgeMod : Mod, IMonitorLogger
    {
        private WebSocketServer? _wsServer;
        private GameStateExtractor? _extractor;
        private ActionInjector? _actionInjector;
        private EventForwarder? _eventForwarder;
        private readonly ConcurrentQueue<GameActionDto> _actionQueue = new();

        // ── Lifecycle ─────────────────────────────────────────────────────────

        public override void Entry(IModHelper helper)
        {
            var port = helper.ReadConfig<BridgeConfig>().BridgePort;

            _extractor = new GameStateExtractor();
            _wsServer = new WebSocketServer(port, this);
            _actionInjector = new ActionInjector(Monitor);
            _eventForwarder = new EventForwarder(_wsServer, _extractor, Monitor);

            // Wire incoming actions to the queue — background threads add, game thread drains
            _wsServer.ActionReceived += (_, action) => _actionQueue.Enqueue(action);

            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            helper.Events.GameLoop.GameExited += OnGameExited;

            _eventForwarder.RegisterEvents(helper.Events);
            _wsServer.Start();

            Monitor.Log($"[ASVA] BridgeMod v{ModManifest.Version} initialized on port {port}", LogLevel.Info);
        }

        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            // Drain the action queue on the game thread every tick
            while (_actionQueue.TryDequeue(out var action))
            {
                _actionInjector?.Execute(action);
            }
        }

        private void OnGameExited(object? sender, GameExitedEventArgs e)
        {
            _wsServer?.Dispose();
            Monitor.Log("[ASVA] BridgeMod: WebSocket server disposed", LogLevel.Info);
        }

        // ── IMonitorLogger ────────────────────────────────────────────────────

        void IMonitorLogger.Log(string message, LogLevel level) => Monitor.Log(message, level);
    }

    /// <summary>Config model for config.json — auto-written by SMAPI on first run.</summary>
    public class BridgeConfig
    {
        public int BridgePort { get; set; } = 7890;
    }
}
