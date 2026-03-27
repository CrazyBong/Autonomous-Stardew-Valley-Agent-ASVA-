using System;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace AsvaSmapiMod
{
    /// <summary>
    /// Receives action DTOs from the agent and translates them into SMAPI
    /// in-game operations. Each action type maps to a specific Stardew Valley API call.
    /// </summary>
    public class ActionInjector
    {
        private readonly IMonitor _monitor;

        public ActionInjector(IMonitor monitor)
        {
            _monitor = monitor;
        }

        /// <summary>
        /// Handles an incoming action from the agent. Calls SMAPI APIs synchronously
        /// on the game loop thread (invoked via helper.GameContent events).
        /// </summary>
        public void Execute(GameActionDto action)
        {
            try
            {
                switch (action.Type)
                {
                    case "ACTION_MOVE":
                        ExecuteMove(action.Payload);
                        break;
                    case "ACTION_USE_TOOL":
                        ExecuteUseTool(action.Payload);
                        break;
                    case "ACTION_EQUIP_TOOL":
                        ExecuteEquipTool(action.Payload);
                        break;
                    case "ACTION_PICKUP_ITEM":
                        ExecutePickupItem(action.Payload);
                        break;
                    case "ACTION_SELECT_DIALOG":
                        ExecuteSelectDialog(action.Payload);
                        break;
                    case "ACTION_BUY_ITEM":
                        ExecuteBuyItem(action.Payload);
                        break;
                    case "ACTION_SELL_ITEM":
                        ExecuteSellItem(action.Payload);
                        break;
                    case "ACTION_SLEEP":
                        ExecuteSleep();
                        break;
                    default:
                        _monitor.Log($"[ASVA] Unknown action type: {action.Type}", LogLevel.Warn);
                        break;
                }
            }
            catch (Exception ex)
            {
                _monitor.Log($"[ASVA] Action execution failed [{action.Type}]: {ex.Message}", LogLevel.Error);
            }
        }

        // ── Action Implementations ─────────────────────────────────────────────

        private void ExecuteMove(object? payload)
        {
            if (payload is not JObject p) return;
            var x = p.Value<int>("targetX");
            var y = p.Value<int>("targetY");

            // Warp agent to tile coordinates (in full impl, this drives pathfinder steps)
            if (Game1.player?.currentLocation != null)
            {
                Game1.player.Position = new Microsoft.Xna.Framework.Vector2(x * 64f, y * 64f);
            }
        }

        private void ExecuteUseTool(object? payload)
        {
            if (payload is not JObject p) return;
            var x = p.Value<int>("x");
            var y = p.Value<int>("y");

            var loc = Game1.player.currentLocation;
            Game1.player.useTool();
            _ = x; _ = y; // Position set via game input in full implementation
        }

        private void ExecuteEquipTool(object? payload)
        {
            if (payload is not JObject p) return;
            var toolName = p.Value<string>("tool");
            if (toolName is null) return;

            var inventory = Game1.player.Items;
            for (var i = 0; i < inventory.Count; i++)
            {
                if (inventory[i] is Tool tool && tool.DisplayName.Equals(toolName, StringComparison.OrdinalIgnoreCase))
                {
                    Game1.player.CurrentToolIndex = i;
                    return;
                }
            }
        }

        private void ExecutePickupItem(object? payload)
        {
            // Simplified — full impl checks location drops and picks nearest matching itemId
        }

        private void ExecuteSelectDialog(object? payload)
        {
            if (payload is not JObject p) return;
            var optionIndex = p.Value<int>("optionIndex");

            if (Game1.currentSpeaker is not null)
            {
                Game1.dialogueUp = false;
            }
            if (Game1.activeClickableMenu is StardewValley.Menus.DialogueBox box)
            {
                // In Stardew, selecting an option usually involves setting the response
                // and letting the update loop handle the transition.
                if (optionIndex >= 0)
                {
                    // This is a simplified mock for Phase 1. 
                    // Real impl would use box.receiveLeftClick() on the specific response component.
                    _monitor.Log($"[ASVA] Selecting dialog option {optionIndex}", LogLevel.Debug);
                }
            }
        }

        private void ExecuteBuyItem(object? payload)
        {
            // Full implementation interacts with ShopMenu to purchase a specific item
        }

        private void ExecuteSellItem(object? payload)
        {
            // Full implementation places items in shipping bin or sells via shop
        }

        private void ExecuteSleep()
        {
            Game1.NewDay(0f);
        }
    }
}
