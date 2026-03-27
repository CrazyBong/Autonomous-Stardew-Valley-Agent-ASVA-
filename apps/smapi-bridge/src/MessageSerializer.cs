using System.Text;
using Newtonsoft.Json;

namespace AsvaSmapiMod
{
    /// <summary>
    /// Centralised JSON serialisation for bridge-to-agent messages.
    /// Uses Newtonsoft.Json with camelCase settings to match TypeScript types.
    /// </summary>
    public static class MessageSerializer
    {
        private static readonly JsonSerializerSettings Settings = new()
        {
            ContractResolver = new Newtonsoft.Json.Serialization.CamelCasePropertyNamesContractResolver(),
            NullValueHandling = NullValueHandling.Include,
            DateFormatHandling = DateFormatHandling.IsoDateFormat,
        };

        public static string Serialize<T>(T obj) =>
            JsonConvert.SerializeObject(obj, Settings);

        public static T? Deserialize<T>(string json) =>
            JsonConvert.DeserializeObject<T>(json, Settings);

        public static byte[] SerializeToBytes<T>(T obj) =>
            Encoding.UTF8.GetBytes(Serialize(obj));
    }
}
