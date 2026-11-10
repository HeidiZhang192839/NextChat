import { create } from "zustand";
import {
  combine,
  persist,
  createJSONStorage,
  PersistStorage,
} from "zustand/middleware";
import { Updater } from "../typing";
import { deepClone } from "./clone";
import { indexedDBStorage } from "@/app/utils/indexedDB-storage";

type SecondParam<T> = T extends (
  _f: infer _F,
  _s: infer S,
  ...args: infer _U
) => any
  ? S
  : never;

type MakeUpdater<T> = {
  lastUpdateTime: number;
  _hasHydrated: boolean;

  markUpdate: () => void;
  update: Updater<T>;
  setHasHydrated: (state: boolean) => void;
};

type SetStoreState<T> = (
  partial: T | Partial<T> | ((state: T) => T | Partial<T>),
  replace?: boolean | undefined,
) => void;

const WRITE_INTERVAL_MS = 1000;

// a streaming reply updates the store every frame, and saving means serializing the whole
// state (every chat with its images and files), so saving each time piles up copies of it
// until the tab runs out of memory. Save the latest state at most once a second, one save
// at a time, and right away when the page is hidden or closed.
export function throttleWrites<S>(
  storage: PersistStorage<S>,
): PersistStorage<S> {
  let pending: Parameters<PersistStorage<S>["setItem"]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;

  function schedule() {
    if (!timer && !writing && pending) {
      timer = setTimeout(flush, WRITE_INTERVAL_MS);
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const [name, value] = pending;
    pending = undefined;
    writing = true;
    return Promise.resolve(storage.setItem(name, value)).finally(() => {
      writing = false;
      schedule();
    });
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flush();
    });
  }

  return {
    ...storage,
    setItem(name, value) {
      const first = !pending && !timer && !writing;
      pending = [name, value];
      if (first) return flush();
      schedule();
    },
  };
}

export function createPersistStore<T extends object, M>(
  state: T,
  methods: (
    set: SetStoreState<T & MakeUpdater<T>>,
    get: () => T & MakeUpdater<T>,
  ) => M,
  persistOptions: SecondParam<typeof persist<T & M & MakeUpdater<T>>>,
) {
  persistOptions.storage = throttleWrites(
    createJSONStorage(() => indexedDBStorage)!,
  );
  const oldOonRehydrateStorage = persistOptions?.onRehydrateStorage;
  persistOptions.onRehydrateStorage = (state) => {
    oldOonRehydrateStorage?.(state);
    return () => state.setHasHydrated(true);
  };

  return create(
    persist(
      combine(
        {
          ...state,
          lastUpdateTime: 0,
          _hasHydrated: false,
        },
        (set, get) => {
          return {
            ...methods(set, get as any),

            markUpdate() {
              set({ lastUpdateTime: Date.now() } as Partial<
                T & M & MakeUpdater<T>
              >);
            },
            update(updater) {
              const state = deepClone(get());
              updater(state);
              set({
                ...state,
                lastUpdateTime: Date.now(),
              });
            },
            setHasHydrated: (state: boolean) => {
              set({ _hasHydrated: state } as Partial<T & M & MakeUpdater<T>>);
            },
          } as M & MakeUpdater<T>;
        },
      ),
      persistOptions as any,
    ),
  );
}
