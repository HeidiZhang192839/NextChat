import { createWebDavClient } from "./webdav";
import { createUpstashClient } from "./upstash";
import { createGDriveClient } from "./gdrive";

export enum ProviderType {
  WebDAV = "webdav",
  UpStash = "upstash",
  GoogleDrive = "gdrive",
}

export const SyncClients = {
  [ProviderType.UpStash]: createUpstashClient,
  [ProviderType.WebDAV]: createWebDavClient,
  [ProviderType.GoogleDrive]: createGDriveClient,
} as const;

type SyncClientConfig = {
  [K in keyof typeof SyncClients]: (typeof SyncClients)[K] extends (
    _: infer C,
  ) => any
    ? C
    : never;
};

export type SyncClient = {
  get: (key: string) => Promise<string>;
  set: (key: string, value: string) => Promise<void>;
  check: () => Promise<boolean>;
};

export function createSyncClient<T extends ProviderType>(
  provider: T,
  config: SyncClientConfig[T],
): SyncClient {
  return SyncClients[provider](config as any) as any;
}
