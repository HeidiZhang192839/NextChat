import { jest } from "@jest/globals";
import { createGDriveClient, deviceKey } from "../app/utils/cloud/gdrive";
import { StoreKey } from "../app/constant";
import { ProviderType } from "../app/utils/cloud";

type DriveFile = {
  id: string;
  name: string;
  parents?: string[];
  mimeType?: string;
  content: string;
};

const CLIENT_ID = "test-client";
let files: DriveFile[];
let requests: { method: string; url: string; auth: string }[];

function respond(status: number, body: unknown = {}, location = "") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status < 300,
    status,
    headers: { get: () => location },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

// a tiny in-memory Google Drive that answers the calls the client makes
function fakeDrive(url: string, init: any = {}) {
  const method = init.method ?? "GET";
  const { pathname, searchParams, host } = new URL(url);
  requests.push({ method, url, auth: init.headers.Authorization });
  const id = pathname.split("/").pop()!;

  if (host === "upload.test") {
    files.find((f) => f.id === id)!.content = init.body;
    return respond(200);
  }
  if (pathname.startsWith("/upload/")) {
    return respond(200, {}, `https://upload.test/${id}`);
  }
  if (method === "POST") {
    const file = { ...JSON.parse(init.body), id: `id-${files.length}` };
    files.push({ ...file, content: "" });
    return respond(200, file);
  }
  if (searchParams.get("alt") === "media") {
    return respond(200, files.find((f) => f.id === id)!.content);
  }

  const q = searchParams.get("q")!;
  const name = q.match(/name='([^']+)'/)![1];
  const parent = q.match(/'([^']+)' in parents/)?.[1];
  return respond(200, {
    files: files.filter(
      (f) => f.name === name && (!parent || f.parents?.includes(parent)),
    ),
  });
}

function createClient() {
  return createGDriveClient({ gdrive: { clientId: CLIENT_ID } } as any);
}

beforeEach(() => {
  files = [];
  requests = [];
  // the app also loads its own files (masks, plugins, prompts) on startup,
  // those are left unanswered
  (global as any).fetch = jest.fn((url: string, init: any) =>
    url.startsWith("https://")
      ? Promise.resolve().then(() => fakeDrive(url, init))
      : new Promise(() => {}),
  );
  localStorage.setItem(
    "gdrive-token",
    JSON.stringify({
      clientId: CLIENT_ID,
      token: "token-1",
      expire: Date.now() + 60_000,
    }),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

const chatOf = (id: string) =>
  ({
    id,
    topic: id,
    lastUpdate: Date.now(),
    messages: [{ id: `${id}-msg`, role: "user", content: "hi", date: "" }],
  }) as any;

async function configureSync() {
  const { useChatStore } = await import("../app/store");
  const { useSyncStore } = await import("../app/store/sync");
  useSyncStore.setState({
    provider: ProviderType.GoogleDrive,
    gdrive: { clientId: CLIENT_ID },
    lastSyncTime: 0,
    lastProvider: "",
  });
  return { useChatStore, useSyncStore };
}

test("nothing saved yet reads as empty", async () => {
  expect(await createClient().get("desktop")).toBe("");
});

test("phone and computer are saved to separate files in one folder", async () => {
  await createClient().set("desktop", "from computer");
  await createClient().set("mobile", "from phone");

  expect(await createClient().get("desktop")).toBe("from computer");
  expect(await createClient().get("mobile")).toBe("from phone");

  const folders = files.filter((f) => f.name === "NextChat");
  expect(folders).toHaveLength(1);
  expect(files.map((f) => f.name).sort()).toEqual([
    "NextChat",
    "desktop.json",
    "mobile.json",
  ]);
  expect(files.filter((f) => f !== folders[0]).map((f) => f.parents)).toEqual([
    [folders[0].id],
    [folders[0].id],
  ]);
});

test("saving again overwrites the same file", async () => {
  await createClient().set("desktop", "first");
  await createClient().set("desktop", "second");

  expect(await createClient().get("desktop")).toBe("second");
  expect(files.filter((f) => f.name === "desktop.json")).toHaveLength(1);
});

test("every request is signed with the saved token", async () => {
  await createClient().set("desktop", "data");

  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.auth === "Bearer token-1")).toBe(true);
});

test("a rejected token is forgotten so the next sync signs in again", async () => {
  (global as any).fetch = jest.fn(async () => respond(401, "expired"));

  await expect(createClient().get("desktop")).rejects.toThrow("401");
  expect(localStorage.getItem("gdrive-token")).toBeNull();
});

test("the connection check reports whether Drive is reachable", async () => {
  expect(await createClient().check()).toBe(true);

  (global as any).fetch = jest.fn(async () => respond(403, "forbidden"));
  expect(await createClient().check()).toBe(false);
});

test("the device decides which file is used", () => {
  expect(deviceKey()).toBe("desktop");

  jest
    .spyOn(navigator, "userAgent", "get")
    .mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
    );
  expect(deviceKey()).toBe("mobile");
  expect(deviceKey(false)).toBe("desktop");
  jest.restoreAllMocks();
});

test("each device syncs its own chats and can pull the other's on demand", async () => {
  const { useChatStore, useAppConfig } = await import("../app/store");
  const { useSyncStore } = await import("../app/store/sync");
  const localChats = () => useChatStore.getState().sessions.map((s) => s.id);
  const savedChats = (name: string) =>
    JSON.parse(files.find((f) => f.name === name)!.content)[
      "chat-next-web-store"
    ].sessions.map((s: any) => s.id);

  useSyncStore.setState({
    provider: "gdrive" as any,
    gdrive: { clientId: CLIENT_ID },
  });

  useChatStore.setState({ sessions: [chatOf("computer-chat")] });
  await useSyncStore.getState().sync();
  expect(savedChats("desktop.json")).toEqual(["computer-chat"]);

  jest.spyOn(navigator, "userAgent", "get").mockReturnValue("Android Mobile");
  useChatStore.setState({ sessions: [chatOf("phone-chat")] });
  useAppConfig.setState({ fontSize: 20 });
  await useSyncStore.getState().sync();
  expect(savedChats("mobile.json")).toEqual(["phone-chat"]);
  expect(savedChats("desktop.json")).toEqual(["computer-chat"]);
  expect(localChats()).toEqual(["phone-chat"]);

  expect(await useSyncStore.getState().pullOtherDevice()).toBe(true);
  expect(localChats().sort()).toEqual(["computer-chat", "phone-chat"]);
  expect(useAppConfig.getState().fontSize).toBe(20);
  expect(savedChats("desktop.json")).toEqual(["computer-chat"]);
  expect(savedChats("mobile.json")).toEqual(["phone-chat"]);
  jest.restoreAllMocks();
});

test("pulling before the other device ever synced changes nothing", async () => {
  const { useChatStore } = await import("../app/store");
  const { useSyncStore } = await import("../app/store/sync");
  useSyncStore.setState({
    provider: "gdrive" as any,
    gdrive: { clientId: CLIENT_ID },
  });
  const before = useChatStore.getState().sessions;

  expect(await useSyncStore.getState().pullOtherDevice()).toBe(false);
  expect(useChatStore.getState().sessions).toBe(before);
});

test.each([
  ["desktop", "Desktop Browser", "mobile"],
  ["mobile", "Android Mobile", "desktop"],
])(
  "%s upload replaces only its own backup without downloading or merging",
  async (key, userAgent, otherKey) => {
    const { useChatStore, useSyncStore } = await configureSync();
    const { getLocalAppState } = await import("../app/utils/sync");
    jest.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    useChatStore.setState({ sessions: [chatOf("old-cloud-chat")] });
    await createClient().set(key, JSON.stringify(getLocalAppState()));
    await createClient().set(otherKey, "other-device-backup");
    useChatStore.setState({ sessions: [chatOf("new-local-chat")] });
    requests = [];

    await useSyncStore.getState().upload();

    const backup = JSON.parse(
      files.find((f) => f.name === `${key}.json`)!.content,
    );
    expect(backup[StoreKey.Chat].sessions.map((s: any) => s.id)).toEqual([
      "new-local-chat",
    ]);
    expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual([
      "new-local-chat",
    ]);
    expect(files.find((f) => f.name === `${otherKey}.json`)!.content).toBe(
      "other-device-backup",
    );
    expect(requests.some((r) => r.url.includes("alt=media"))).toBe(false);
    expect(useSyncStore.getState().lastSyncTime).toBeGreaterThan(0);
    expect(useSyncStore.getState().lastProvider).toBe(ProviderType.GoogleDrive);
  },
);

test.each([
  ["desktop", "Desktop Browser", "mobile"],
  ["mobile", "Android Mobile", "desktop"],
])(
  "%s download merges only its own chats without changing either cloud backup",
  async (key, userAgent, otherKey) => {
    const { useChatStore, useSyncStore } = await configureSync();
    const { getLocalAppState } = await import("../app/utils/sync");
    jest.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    useChatStore.setState({ sessions: [chatOf("cloud-chat")] });
    await createClient().set(key, JSON.stringify(getLocalAppState()));
    useChatStore.setState({ sessions: [chatOf("other-device-chat")] });
    await createClient().set(otherKey, JSON.stringify(getLocalAppState()));
    useChatStore.setState({ sessions: [chatOf("local-chat")] });
    const cloudBefore = JSON.stringify(files);
    requests = [];

    expect(await useSyncStore.getState().download()).toBe(true);
    expect(
      useChatStore
        .getState()
        .sessions.map((s) => s.id)
        .sort(),
    ).toEqual(["cloud-chat", "local-chat"]);
    expect(JSON.stringify(files)).toBe(cloudBefore);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(useSyncStore.getState().lastSyncTime).toBeGreaterThan(0);

    // Repeated downloads do not duplicate chats or messages.
    expect(await useSyncStore.getState().download()).toBe(true);
    expect(useChatStore.getState().sessions).toHaveLength(2);
    expect(
      useChatStore.getState().sessions.every((s) => s.messages.length === 1),
    ).toBe(true);
    expect(JSON.stringify(files)).toBe(cloudBefore);
  },
);

test("downloading a missing device backup preserves local data and timestamp", async () => {
  const { useChatStore, useSyncStore } = await configureSync();
  jest.spyOn(navigator, "userAgent", "get").mockReturnValue("Desktop Browser");
  await createClient().set("mobile", "other-device-backup");
  useChatStore.setState({ sessions: [chatOf("local-chat")] });
  const before = useChatStore.getState().sessions;
  const cloudBefore = JSON.stringify(files);
  requests = [];

  expect(await useSyncStore.getState().download()).toBe(false);
  expect(useChatStore.getState().sessions).toBe(before);
  expect(JSON.stringify(files)).toBe(cloudBefore);
  expect(requests.every((r) => r.method === "GET")).toBe(true);
  expect(useSyncStore.getState().lastSyncTime).toBe(0);
});

test.each(["invalid-json", "incomplete-backup"])(
  "downloading %s fails without partially changing local data",
  async (kind) => {
    const { useChatStore, useSyncStore } = await configureSync();
    const { getLocalAppState } = await import("../app/utils/sync");
    jest
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Desktop Browser");
    useChatStore.setState({ sessions: [chatOf("cloud-chat")] });
    await createClient().set(
      "desktop",
      kind === "invalid-json"
        ? "not json"
        : JSON.stringify({
            [StoreKey.Chat]: getLocalAppState()[StoreKey.Chat],
          }),
    );
    useChatStore.setState({ sessions: [chatOf("local-chat")] });
    const before = JSON.stringify(getLocalAppState());
    const cloudBefore = JSON.stringify(files);

    await expect(useSyncStore.getState().download()).rejects.toThrow();
    expect(JSON.stringify(getLocalAppState())).toBe(before);
    expect(JSON.stringify(files)).toBe(cloudBefore);
    expect(useSyncStore.getState().lastSyncTime).toBe(0);
  },
);

test.each(["upload", "download"] as const)(
  "a failed %s does not change local data or mark success",
  async (action) => {
    const { useChatStore, useSyncStore } = await configureSync();
    const { getLocalAppState } = await import("../app/utils/sync");
    useChatStore.setState({ sessions: [chatOf("local-chat")] });
    const before = JSON.stringify(getLocalAppState());
    (global as any).fetch = jest.fn(async () => respond(403, "forbidden"));

    await expect(useSyncStore.getState()[action]()).rejects.toThrow("403");
    expect(JSON.stringify(getLocalAppState())).toBe(before);
    expect(useSyncStore.getState().lastSyncTime).toBe(0);
    expect(useSyncStore.getState().lastProvider).toBe("");
  },
);

test.each([ProviderType.WebDAV, ProviderType.UpStash])(
  "%s keeps using the configured backup name for upload and download",
  async (provider) => {
    const { useSyncStore } = await configureSync();
    useSyncStore.setState({
      provider,
      [provider]: {
        ...useSyncStore.getState()[provider],
        username: "custom-backup",
      },
    });

    expect(useSyncStore.getState().getSyncKey()).toBe("custom-backup");
  },
);
