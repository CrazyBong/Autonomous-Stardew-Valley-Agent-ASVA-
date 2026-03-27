using System;
using StardewModdingAPI;
using StardewModdingAPI.Events;

namespace AsvaSmapiMod
{
    /// <summary>
    /// Subscribes to SMAPI game events and forwards them as typed WebSocket
    /// messages to the connected Node.js agent.
    /// </summary>
    public class EventForwarder
    {
        private readonly WebSocketServer _wsServer;
        private readonly GameStateExtractor _extractor;
        private readonly IMonitor _monitor;

        // Tick counter — used to throttle GAME_STATE_UPDATE to every 1 in-game tick
        private int _tickCounter;

        public EventForwarder(WebSocketServer wsServer, GameStateExtractor extractor, IMonitor monitor)
        {
            _wsServer = wsServer;
            _extractor = extractor;
            _monitor = monitor;
        }

        public void RegisterEvents(IModEvents events)
        {
            events.GameLoop.UpdateTicked += OnUpdateTicked;
            events.GameLoop.DayStarted += OnDayStarted;
            events.GameLoop.DayEnding += OnDayEnding;
            events.Display.MenuChanged += OnMenuChanged;
        }

        // ── Handlers ──────────────────────────────────────────────────────────

        private async void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            // Extract and forward full game state every tick
            _tickCounter++;
            try
            {
                var state = _extractor.ExtractState();
                await _wsServer.BroadcastAsync("GAME_STATE_UPDATE", state);
            }
            catch (Exception ex)
            {
                _monitor.Log($"[ASVA] State extraction error on tick {_tickCounter}: {ex.Message}", LogLevel.Error);
            }
        }

        private async void OnDayStarted(object? sender, DayStartedEventArgs e)
        {
            try
            {
                var state = _extractor.ExtractState();
                await _wsServer.BroadcastAsync("DAY_STARTED", new
                {
                    day = state.GameDay,
                    season = state.Season,
                    year = state.Year,
                    snapshot = state,
                });
                _monitor.Log($"[ASVA] DAY_STARTED event forwarded: Day {state.GameDay} {state.Season} Y{state.Year}", LogLevel.Info);
            }
            catch (Exception ex)
            {
                _monitor.Log($"[ASVA] DAY_STARTED forward error: {ex.Message}", LogLevel.Error);
            }
        }

        private async void OnDayEnding(object? sender, DayEndingEventArgs e)
        {
            try
            {
                var state = _extractor.ExtractState();
                await _wsServer.BroadcastAsync("DAY_ENDED", new { day = state.GameDay });
            }
            catch (Exception ex)
            {
                _monitor.Log($"[ASVA] DAY_ENDED forward error: {ex.Message}", LogLevel.Error);
            }
        }

        private async void OnMenuChanged(object? sender, MenuChangedEventArgs e)
        {
            try
            {
                if (e.NewMenu is StardewValley.Menus.DialogueBox dialogueBox)
                {
                    await _wsServer.BroadcastAsync("DIALOG_OPENED", new
                    {
                        npcId = StardewValley.Game1.currentSpeaker?.Name ?? "unknown",
                        message = dialogueBox.getCurrentString(),
                    });
                }
            }
            catch (Exception ex)
            {
                _monitor.Log($"[ASVA] DIALOG_OPENED forward error: {ex.Message}", LogLevel.Error);
            }
        }
    }
}
