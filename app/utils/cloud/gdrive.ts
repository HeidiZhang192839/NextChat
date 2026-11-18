import { SyncStore } from "@/app/store/sync";

export type GDriveConfig = SyncStore["gdrive"];
export type GDriveClient = ReturnType<typeof createGDriveClient>;

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
// only lets the app touch the files it created itself
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "NextChat";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const TOKEN_KEY = "gdrive-token";

export function isMobileDevice() {
  return /mobi|android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

// phone and computer each sync with their own file
export function deviceKey(mobile = isMobileDevice()) {
  return mobile ? "mobile" : "desktop";
}

let signInScript: Promise<void> | undefined;

// browsers block the sign-in popup unless it opens right after a click,
// so the script is loaded ahead of time
export function loadGoogleSignIn() {
  return (signInScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = () => resolve();
    script.onerror = () => {
      signInScript = undefined;
      reject(new Error("[GDrive] failed to load Google sign-in"));
    };
    document.head.appendChild(script);
  }));
}

async function getToken(clientId: string) {
  const cached = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? "{}");
  if (cached.clientId === clientId && cached.expire > Date.now()) {
    return cached.token as string;
  }

  await loadGoogleSignIn();
  const res = await new Promise<any>((resolve, reject) => {
    (window as any).google.accounts.oauth2
      .initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: resolve,
        error_callback: reject,
      })
      .requestAccessToken({ prompt: "" });
  });
  if (!res.access_token) {
    throw new Error(`[GDrive] sign-in failed: ${res.error}`);
  }

  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({
      clientId,
      token: res.access_token,
      expire: Date.now() + (res.expires_in - 60) * 1000,
    }),
  );
  return res.access_token as string;
}

export function createGDriveClient(store: SyncStore) {
  const config = store.gdrive;
  let folder: Promise<string> | undefined;

  return {
    async check() {
      try {
        await this.folderId();
        return true;
      } catch (e) {
        console.error("[GDrive] failed to check", e);
      }

      return false;
    },

    async get(key: string) {
      const id = await this.fileId(key);
      if (!id) return "";

      const res = await this.request(`${API}/${id}?alt=media`);
      return await res.text();
    },

    async set(key: string, value: string) {
      const id =
        (await this.fileId(key)) ??
        (await this.create({
          name: `${key}.json`,
          parents: [await this.folderId()],
        }));

      // a resumable upload has no size limit, a plain one stops at 5MB
      const session = await this.request(
        `${UPLOAD_API}/${id}?uploadType=resumable`,
        { method: "PATCH" },
      );
      await this.request(session.headers.get("Location")!, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: value,
      });
    },

    folderId() {
      return (folder ??= this.find(
        `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}'`,
      ).then(
        (id) => id ?? this.create({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
      ));
    },

    async fileId(key: string) {
      return this.find(
        `name='${key}.json' and '${await this.folderId()}' in parents`,
      );
    },

    async find(query: string) {
      const q = encodeURIComponent(`${query} and trashed=false`);
      const res = await this.request(
        `${API}?q=${q}&orderBy=createdTime&fields=files(id)`,
      );
      return (await res.json()).files[0]?.id as string | undefined;
    },

    async create(metadata: object) {
      const res = await this.request(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      });
      return (await res.json()).id as string;
    },

    async request(
      url: string,
      init: { method?: string; headers?: object; body?: string } = {},
    ) {
      const res = await fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${await getToken(config.clientId)}`,
        },
      });

      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
      }
      if (!res.ok) {
        throw new Error(`[GDrive] ${res.status} ${await res.text()}`);
      }

      return res;
    },
  };
}
