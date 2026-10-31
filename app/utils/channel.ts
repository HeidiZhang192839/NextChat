import { Azure, DEFAULT_MODELS, ServiceProvider } from "../constant";
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

export const AZURE_DEFAULT_API_VERSION = "2024-10-21";

// base url without trailing "/" or "/v1", like the openai endpoint setting.
// azure's "/openai" prefix goes in the base url, not the path:
// next.config.mjs rewrites /api/proxy/openai/* to api.openai.com
function channelBaseUrl(channel: Channel) {
  const url = channel.url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return channel.type === "azure"
    ? url.replace(/\/openai$/, "") + "/openai"
    : url;
}

export function azureChannelPath(channel: Channel, deployment: string) {
  const version = channel.apiVersion?.trim() || AZURE_DEFAULT_API_VERSION;
  return Azure.ChatPath(deployment, version);
}

// the web app goes through the site proxy to avoid CORS, except for
// local servers: the proxy runs on the host (e.g. vercel), where
// 127.0.0.1 is not the user's machine, so the browser calls them directly
const LOCAL_URL = /^https?:\/\/(localhost|127(\.\d+){3}|\[::1\])(:\d+)?(\/|$)/i;

export function channelPath(channel: Channel, path: string) {
  const baseUrl = channelBaseUrl(channel);
  return getClientConfig()?.isApp || LOCAL_URL.test(baseUrl)
    ? `${baseUrl}/${path}`
    : `/api/proxy/${path}`;
}

export function channelHeaders(channel: Channel): Record<string, string> {
  const key = channel.apiKey.trim();
  const auth: Record<string, string> = {
    openai: { Authorization: `Bearer ${key}` },
    azure: { "api-key": key },
    anthropic: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    google: { "x-goog-api-key": key },
  }[channel.type ?? "openai"];
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...auth,
    "X-Base-URL": channelBaseUrl(channel),
  };
}
