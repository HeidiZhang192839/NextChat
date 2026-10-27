import { DEFAULT_MODELS, ServiceProvider } from "../constant";
import { Channel, useAppConfig } from "../store/config";
import { getClientConfig } from "../config/client";

// channel models are registered as custom models whose provider is the channel name
export function findChannel(providerName?: string) {
  return useAppConfig.getState().channels.find((c) => c.name === providerName);
}

export function channelCustomModels(channels: Channel[]) {
  return channels
    .flatMap((c) => c.models.map((m) => `+${m}@${c.name}`))
    .join(",");
}

// returns an error kind, or "" if the name can be used
export function validateChannelName(
  name: string,
  channels: Channel[],
): "" | "empty" | "chars" | "duplicate" {
  const lower = name.toLowerCase();
  if (!name) return "empty";
  if (/[@,=]/.test(name)) return "chars";
  const builtin = DEFAULT_MODELS.flatMap((m) => [
    m.provider.id,
    m.provider.providerName,
  ]).concat(Object.values(ServiceProvider));
  if (
    builtin.some((p) => p.toLowerCase() === lower) ||
    channels.some((c) => c.name.toLowerCase() === lower)
  ) {
    return "duplicate";
  }
  return "";
}

// base url without trailing "/" or "/v1", like the openai endpoint setting
function channelBaseUrl(channel: Channel) {
  return channel.url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

// the web app goes through the site proxy to avoid CORS
export function channelPath(channel: Channel, path: string) {
  return getClientConfig()?.isApp
    ? `${channelBaseUrl(channel)}/${path}`
    : `/api/proxy/${path}`;
}

export function channelHeaders(channel: Channel): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${channel.apiKey.trim()}`,
    "X-Base-URL": channelBaseUrl(channel),
  };
}
