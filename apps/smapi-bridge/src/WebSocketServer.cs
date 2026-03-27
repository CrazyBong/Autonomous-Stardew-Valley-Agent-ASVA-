using System;
using System.Net;
using System.Text;
using Newtonsoft.Json;
using WatsonWebsocket;

namespace AsvaSmapiMod
{
    /// <summary>
    /// Local WebSocket server (ws://0.0.0.0:7890) that bridges the game
    /// process to the Node.js agent process. All messages are typed JSON.
    /// </summary>
    public class WebSocketServer : IDisposable
    {
        private readonly WatsonWsServer _server;
        private readonly IMonitorLogger _logger;
        private string? _connectedClientIp;

        public event EventHandler<GameActionDto>? ActionReceived;

        public WebSocketServer(int port, IMonitorLogger logger)
        {
            _logger = logger;
            _server = new WatsonWsServer(new WatsonWsServerSettings
            {
                Hostname = "127.0.0.1",
                Port = port,
                Ssl = false,
            });

            _server.ClientConnected += OnClientConnected;
            _server.ClientDisconnected += OnClientDisconnected;
            _server.MessageReceived += OnMessageReceived;
        }

        public void Start()
        {
            _server.Start();
            _logger.Log($"[ASVA] WebSocket server started on ws://127.0.0.1:{_server.Settings.Port}", StardewModdingAPI.LogLevel.Info);
        }

        /// <summary>Broadcasts a typed event to the connected agent (if any).</summary>
        public async Task BroadcastAsync<T>(string eventType, T payload)
        {
            string? targetIp = _connectedClientIp;
            if (targetIp is null) return;

            var message = new
            {
                messageId = Guid.NewGuid().ToString(),
                timestamp = DateTime.UtcNow.ToString("o"),
                type = eventType,
                payload,
            };

            var json = JsonConvert.SerializeObject(message);
            var bytes = Encoding.UTF8.GetBytes(json);

            try
            {
                await _server.SendAsync(targetIp, bytes);
            }
            catch (Exception ex)
            {
                _logger.Log($"[ASVA] Failed to send message: {ex.Message}", StardewModdingAPI.LogLevel.Error);
            }
        }

        // ── Event Handlers ────────────────────────────────────────────────────

        private void OnClientConnected(object? sender, ConnectionEventArgs e)
        {
            _connectedClientIp = e.Client.IpPort;
            _logger.Log($"[ASVA] Agent connected from {_connectedClientIp}", StardewModdingAPI.LogLevel.Info);
        }

        private void OnClientDisconnected(object? sender, DisconnectionEventArgs e)
        {
            _logger.Log($"[ASVA] Agent disconnected ({e.Client.IpPort}): {e.Reason}", StardewModdingAPI.LogLevel.Warn);
            if (_connectedClientIp == e.Client.IpPort)
            {
                _connectedClientIp = null;
            }
        }

        private void OnMessageReceived(object? sender, MessageReceivedEventArgs e)
        {
            try
            {
                var json = Encoding.UTF8.GetString(e.Data.ToArray());
                var action = JsonConvert.DeserializeObject<GameActionDto>(json);
                if (action is not null)
                {
                    ActionReceived?.Invoke(this, action);
                }
            }
            catch (Exception ex)
            {
                _logger.Log($"[ASVA] Failed to parse incoming action: {ex.Message}", StardewModdingAPI.LogLevel.Error);
            }
        }

        public void Dispose() => _server.Dispose();
    }

    /// <summary>Minimal interface for SMAPI monitor, used for testability.</summary>
    public interface IMonitorLogger
    {
        void Log(string message, StardewModdingAPI.LogLevel level);
    }

    /// <summary>Incoming action DTO from the agent.</summary>
    public record GameActionDto
    {
        [JsonProperty("type")] public string Type { get; init; } = "";
        [JsonProperty("payload")] public object? Payload { get; init; }
    }
}
