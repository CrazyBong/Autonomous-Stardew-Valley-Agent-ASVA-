using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Newtonsoft.Json;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;

namespace AsvaSmapiMod
{
    /// <summary>
    /// Extracts the current game state on each tick and serializes it
    /// to a JSON-compatible DTO ready for WebSocket transmission.
    /// </summary>
    public class GameStateExtractor
    {
        // ── Public API ────────────────────────────────────────────────────────

        /// <summary>Builds a full game state snapshot from the current SMAPI context.</summary>
        public GameStateDto ExtractState()
        {
            var player = Game1.player;
            var farm = Game1.getFarm();

            if (player == null || farm == null)
            {
                return new GameStateDto
                {
                    Tick = (int)Game1.ticks,
                    GameDay = Game1.dayOfMonth,
                    Season = Game1.currentSeason?.ToLower() ?? "unknown",
                    Year = Game1.year
                };
            }

            return new GameStateDto
            {
                Tick = (int)Game1.ticks,
                GameDay = Game1.dayOfMonth,
                Season = Game1.currentSeason?.ToLower() ?? "unknown",
                Year = Game1.year,
                TimeOfDay = Game1.timeOfDay,
                Player = ExtractPlayer(player),
                Farm = ExtractFarm(farm),
                World = ExtractWorld(),
                Bundles = ExtractBundles(),
            };
        }

        // ── Private Helpers ────────────────────────────────────────────────────

        private static PlayerDto ExtractPlayer(Farmer player) => new()
        {
            Position = new PositionDto
            {
                X = (int)player.Position.X / 64,
                Y = (int)player.Position.Y / 64,
                Map = player.currentLocation?.Name ?? "Unknown",
            },
            Health = player.health,
            MaxHealth = player.maxHealth,
            Stamina = player.stamina,
            MaxStamina = (int)player.MaxStamina,
            Gold = player.Money,
            EquippedTool = player.CurrentTool?.DisplayName,
            Skills = new Dictionary<string, int>
            {
                ["farming"] = player.FarmingLevel,
                ["mining"] = player.MiningLevel,
                ["foraging"] = player.ForagingLevel,
                ["fishing"] = player.FishingLevel,
                ["combat"] = player.CombatLevel,
            },
            Inventory = ExtractInventory(player),
        };

        private static List<InventorySlotDto> ExtractInventory(Farmer player)
        {
            var slots = new List<InventorySlotDto>();
            foreach (var item in player.Items)
            {
                if (item is null) continue;
                slots.Add(new InventorySlotDto
                {
                    ItemId = item.ItemId,
                    Name = item.DisplayName,
                    Quantity = item.Stack,
                    Quality = item is StardewValley.Object obj ? obj.Quality : 0,
                    Stackable = item.maximumStackSize() > 1,
                });
            }
            return slots;
        }

        private static FarmDto ExtractFarm(Farm farm)
        {
            var tiles = new List<CropTileDto>();
            foreach (var pair in farm.terrainFeatures.Pairs)
            {
                if (pair.Value is HoeDirt dirt)
                {
                    tiles.Add(new CropTileDto
                    {
                        X = (int)pair.Key.X,
                        Y = (int)pair.Key.Y,
                        CropId = dirt.crop?.indexOfHarvest.Value.ToString(),
                        DaysToHarvest = CalculateDaysToHarvest(dirt.crop),
                        Watered = dirt.state.Value == HoeDirt.watered,
                        Fertilized = dirt.fertilizer.Value != HoeDirt.noFertilizer,
                    });
                }
            }

            var buildings = new List<BuildingDto>();
            foreach (var b in farm.buildings)
            {
                buildings.Add(new BuildingDto
                {
                    Type = b.buildingType.Value,
                    Position = new PositionDto { X = b.tileX.Value, Y = b.tileY.Value, Map = "Farm" },
                    Animals = b.indoors.Value is AnimalHouse ah ? ah.animalLimit.Value : 0,
                });
            }

            return new FarmDto { Tiles = tiles, Buildings = buildings, SprinklerCoverage = new List<PositionDto>() };
        }

        private static WorldDto ExtractWorld() => new()
        {
            Weather = Game1.isLightning ? "stormy"
                    : Game1.isRaining ? "rainy"
                    : Game1.isSnowing ? "snowy"
                    : Game1.isDebrisWeather ? "windy"
                    : "sunny",
            TomorrowWeather = Game1.weatherForTomorrow == Game1.weather_rain ? "rainy"
                            : Game1.weatherForTomorrow == Game1.weather_lightning ? "stormy"
                            : Game1.weatherForTomorrow == Game1.weather_snow ? "snowy"
                            : "sunny",
            MineLevel = MineShaft.lowestLevelReached,
            HasAccessToSkullCavern = Game1.player?.hasSkullKey ?? false,
        };

        private static BundleStateDto ExtractBundles()
        {
            var bundles = new List<BundleDto>();
            if (Game1.netWorldState?.Value?.BundleData is not { } bundleData) return new BundleStateDto { Bundles = bundles };

            foreach (var (key, value) in bundleData)
            {
                var parts = key.Split('/');
                if (parts.Length < 2) continue;

                var valueParts = value.Split('/');
                bundles.Add(new BundleDto
                {
                    BundleId = parts[1],
                    Name = valueParts.Length > 0 ? valueParts[0] : "Unknown",
                    RoomId = parts[0],
                    Complete = false, // Full completion check via BundleData state
                    Items = new List<BundleItemStatusDto>(),
                });
            }

        return new BundleStateDto { Bundles = bundles, TotalBundles = bundles.Count };
    }

    public static int? CalculateDaysToHarvest(Crop? crop)
    {
        if (crop == null || crop.dead.Value)
            return null;

        if (crop.currentPhase.Value >= crop.phaseDays.Count - 1)
            return 0;

        int daysLeft = 0;
        for (int i = crop.currentPhase.Value; i < crop.phaseDays.Count - 1; i++)
        {
            daysLeft += crop.phaseDays[i];
        }
        return Math.Max(0, daysLeft - crop.dayOfCurrentPhase.Value);
    }
}

    // ── Data Transfer Objects (mirror of shared-types JSON contract) ───────────

    public record GameStateDto
    {
        [JsonProperty("tick")] public int Tick { get; init; }
        [JsonProperty("gameDay")] public int GameDay { get; init; }
        [JsonProperty("season")] public string Season { get; init; } = "";
        [JsonProperty("year")] public int Year { get; init; }
        [JsonProperty("timeOfDay")] public int TimeOfDay { get; init; }
        [JsonProperty("player")] public PlayerDto Player { get; init; } = new();
        [JsonProperty("farm")] public FarmDto Farm { get; init; } = new();
        [JsonProperty("world")] public WorldDto World { get; init; } = new();
        [JsonProperty("bundles")] public BundleStateDto Bundles { get; init; } = new();
    }

    public record PlayerDto
    {
        [JsonProperty("position")] public PositionDto Position { get; init; } = new();
        [JsonProperty("health")] public int Health { get; init; }
        [JsonProperty("maxHealth")] public int MaxHealth { get; init; }
        [JsonProperty("stamina")] public float Stamina { get; init; }
        [JsonProperty("maxStamina")] public int MaxStamina { get; init; }
        [JsonProperty("gold")] public int Gold { get; init; }
        [JsonProperty("equippedTool")] public string? EquippedTool { get; init; }
        [JsonProperty("skills")] public Dictionary<string, int> Skills { get; init; } = new();
        [JsonProperty("inventory")] public List<InventorySlotDto> Inventory { get; init; } = new();
    }

    public record PositionDto
    {
        [JsonProperty("x")] public int X { get; init; }
        [JsonProperty("y")] public int Y { get; init; }
        [JsonProperty("map")] public string Map { get; init; } = "";
    }

    public record InventorySlotDto
    {
        [JsonProperty("itemId")] public string ItemId { get; init; } = "";
        [JsonProperty("name")] public string Name { get; init; } = "";
        [JsonProperty("quantity")] public int Quantity { get; init; }
        [JsonProperty("quality")] public int Quality { get; init; }
        [JsonProperty("stackable")] public bool Stackable { get; init; }
    }

    public record FarmDto
    {
        [JsonProperty("tiles")] public List<CropTileDto> Tiles { get; init; } = new();
        [JsonProperty("sprinklerCoverage")] public List<PositionDto> SprinklerCoverage { get; init; } = new();
        [JsonProperty("buildings")] public List<BuildingDto> Buildings { get; init; } = new();
    }

    public record CropTileDto
    {
        [JsonProperty("x")] public int X { get; init; }
        [JsonProperty("y")] public int Y { get; init; }
        [JsonProperty("cropId")] public string? CropId { get; init; }
        [JsonProperty("daysToHarvest")] public int? DaysToHarvest { get; init; }
        [JsonProperty("watered")] public bool Watered { get; init; }
        [JsonProperty("fertilized")] public bool Fertilized { get; init; }
    }

    public record BuildingDto
    {
        [JsonProperty("type")] public string Type { get; init; } = "";
        [JsonProperty("position")] public PositionDto Position { get; init; } = new();
        [JsonProperty("animals")] public int Animals { get; init; }
    }

    public record WorldDto
    {
        [JsonProperty("weather")] public string Weather { get; init; } = "sunny";
        [JsonProperty("tomorrowWeather")] public string TomorrowWeather { get; init; } = "sunny";
        [JsonProperty("mineLevel")] public int MineLevel { get; init; }
        [JsonProperty("hasAccessToSkullCavern")] public bool HasAccessToSkullCavern { get; init; }
    }

    public record BundleStateDto
    {
        [JsonProperty("bundles")] public List<BundleDto> Bundles { get; init; } = new();
        [JsonProperty("totalComplete")] public int TotalComplete { get; init; }
        [JsonProperty("totalBundles")] public int TotalBundles { get; init; }
    }

    public record BundleDto
    {
        [JsonProperty("bundleId")] public string BundleId { get; init; } = "";
        [JsonProperty("name")] public string Name { get; init; } = "";
        [JsonProperty("roomId")] public string RoomId { get; init; } = "";
        [JsonProperty("complete")] public bool Complete { get; init; }
        [JsonProperty("items")] public List<BundleItemStatusDto> Items { get; init; } = new();
    }

    public record BundleItemStatusDto
    {
        [JsonProperty("itemId")] public string ItemId { get; init; } = "";
        [JsonProperty("name")] public string Name { get; init; } = "";
        [JsonProperty("requiredQty")] public int RequiredQty { get; init; }
        [JsonProperty("deliveredQty")] public int DeliveredQty { get; init; }
        [JsonProperty("complete")] public bool Complete { get; init; }
    }
}
