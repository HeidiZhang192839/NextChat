import { getClientConfig } from "../config/client";
import { ApiPath, STORAGE_KEY, StoreKey } from "../constant";
import { createPersistStore } from "../utils/store";
import {
  AppState,
  getLocalAppState,
  GetStoreState,
  mergeAppState,
  MergeStates,
  setLocalAppState,
} from "../utils/sync";
import { downloadAs, readFromFile } from "../utils";
import { showToast } from "../components/ui-lib";
import Locale from "../locales";
import { createSyncClient, ProviderType } from "../utils/cloud";
import { deviceKey, isMobileDevice } from "../utils/cloud/gdrive";

export interface WebDavConfig {
  server: string;
  username: string;
  password: string;
}

const isApp = !!getClientConfig()?.isApp;
export type SyncStore = GetStoreState<typeof useSyncStore>;

const DEFAULT_SYNC_STATE = {
  provider: ProviderType.WebDAV,
  useProxy: true,
  proxyUrl: ApiPath.Cors as string,

  webdav: {
    endpoint: "",
    username: "",
    password: "",
  },

  upstash: {
    endpoint: "",
    username: STORAGE_KEY,
    apiKey: "",
  },

  gdrive: {
    clientId: "",
  },

  lastSyncTime: 0,
  lastProvider: "",
};

export const useSyncStore = createPersistStore(
  DEFAULT_SYNC_STATE,
  (set, get) => ({
    cloudSync() {
      const config = get()[get().provider];
      return Object.values(config).every((c) => c.toString().length > 0);
    },

    markSyncTime() {
      set({ lastSyncTime: Date.now(), lastProvider: get().provider });
    },

    export() {
      const state = getLocalAppState();
      const datePart = isApp
        ? `${new Date().toLocaleDateString().replace(/\//g, "_")} ${new Date()
            .toLocaleTimeString()
            .replace(/:/g, "_")}`
        : new Date().toLocaleString();

      const fileName = `Backup-${datePart}.json`;
      downloadAs(JSON.stringify(state), fileName);
    },

    async import() {
      const rawContent = await readFromFile();

      try {
        const remoteState = JSON.parse(rawContent) as AppState;
        const localState = getLocalAppState();
        mergeAppState(localState, remoteState);
        setLocalAppState(localState);
        location.reload();
      } catch (e) {
        console.error("[Import]", e);
        showToast(Locale.Settings.Sync.ImportFailed);
      }
    },

    getClient() {
      const provider = get().provider;
      const client = createSyncClient(provider, get());
      return client;
    },

    getSyncKey() {
      const provider = get().provider;
      return provider === ProviderType.GoogleDrive
        ? deviceKey()
        : get()[provider].username;
    },

    // Upload only: replace this device's backup without merging remote data.
    async upload() {
      await this.getClient().set(
        this.getSyncKey(),
        JSON.stringify(getLocalAppState()),
      );
      this.markSyncTime();
    },

    // Download only: merge into local data, never write the backup back.
    async download() {
      const remoteState = await this.getClient().get(this.getSyncKey());
      if (!remoteState) return false;

      const parsedRemoteState = JSON.parse(remoteState) as AppState;
      const localState = JSON.parse(
        JSON.stringify(getLocalAppState()),
      ) as AppState;
      mergeAppState(localState, parsedRemoteState);
      setLocalAppState(localState);
      this.markSyncTime();
      return true;
    },

    async sync() {
      const localState = getLocalAppState();
      const key = this.getSyncKey();
      const client = this.getClient();

      try {
        const remoteState = await client.get(key);
        if (!remoteState || remoteState === "") {
          await client.set(key, JSON.stringify(localState));
          console.log(
            "[Sync] Remote state is empty, using local state instead.",
          );
          return;
        } else {
          const parsedRemoteState = JSON.parse(
            await client.get(key),
          ) as AppState;
          mergeAppState(localState, parsedRemoteState);
          setLocalAppState(localState);
        }
      } catch (e) {
        console.log("[Sync] failed to get remote state", e);
        throw e;
      }

      await client.set(key, JSON.stringify(localState));

      this.markSyncTime();
    },

    // merge the chats saved by the other device (phone <-> computer) into this one
    async pullOtherDevice() {
      const remoteState = await this.getClient().get(
        deviceKey(!isMobileDevice()),
      );
      if (!remoteState) return false;

      const localState = getLocalAppState();
      MergeStates[StoreKey.Chat](
        localState[StoreKey.Chat],
        (JSON.parse(remoteState) as AppState)[StoreKey.Chat],
      );
      setLocalAppState(localState);
      return true;
    },

    async check() {
      const client = this.getClient();
      return await client.check();
    },
  }),
  {
    name: StoreKey.Sync,
    version: 1.2,

    migrate(persistedState, version) {
      const newState = persistedState as typeof DEFAULT_SYNC_STATE;

      if (version < 1.1) {
        newState.upstash.username = STORAGE_KEY;
      }

      if (version < 1.2) {
        if (
          (persistedState as typeof DEFAULT_SYNC_STATE).proxyUrl ===
          "/api/cors/"
        ) {
          newState.proxyUrl = "";
        }
      }

      return newState as any;
    },
  },
);
