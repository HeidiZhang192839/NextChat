import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createInterface } from "readline";
import { NextRequest, NextResponse } from "next/server";
import md5 from "spark-md5";
import { getServerSideConfig } from "@/app/config/server";
import { ACCESS_CODE_PREFIX } from "@/app/constant";

// runs the code execution tool's code with real python on this server, for
// what the browser can't do (shell commands, process pools, packages pyodide
// doesn't have). each chat session gets its own python process (runner.py),
// so variables carry over between runs like they do in the browser
const RUNNER = path.join(process.cwd(), "app/api/code-exec/runner.py");
const ROOT = path.join(os.tmpdir(), "nextchat-code");
// installing packages like torch takes minutes, so it has its own timeout
const INSTALL_TIMEOUT_MS = 600_000;
// the browser's, in app/store/plugin.ts
const RUN_TIMEOUT_MS = 120_000;
const KEEPALIVE_MS = 15_000;
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 8;
// the rest of this server's environment, with its API keys, isn't passed on
const ENV_NAMES = [
  "PATH",
  "SYSTEMROOT",
  // the proxy that PROXY_URL sets up in the docker image
  "LD_PRELOAD",
  "PROXYCHAINS_CONF_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];
// when this server runs as root (the docker image), code runs as nobody, so it
// can't read the server's environment through /proc either
const SANDBOX_ID = 65534;

type Output = Record<string, unknown>;
type Session = {
  proc: ChildProcess;
  dir: string;
  lines: AsyncIterator<string>;
  lastUsed: number;
  queue: Promise<unknown>;
};

const sessions = new Map<string, Session>();

function start(python: string): Session {
  const home = path.join(ROOT, "home");
  fs.mkdirSync(home, { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, "session-"));
  const sandbox = process.getuid?.() === 0;
  if (sandbox) {
    fs.chownSync(home, SANDBOX_ID, SANDBOX_ID);
    fs.chownSync(dir, SANDBOX_ID, SANDBOX_ID);
  } else if (process.platform !== "win32") {
    console.warn(
      "[Code Exec] not running as root, so code runs as this server's user and can read its environment",
    );
  }
  const env: Record<string, string> = {
    // shared by sessions, so pip's and matplotlib's caches are too
    HOME: home,
    MPLBACKEND: "Agg",
    PYTHONIOENCODING: "utf-8",
    LANG: "C.UTF-8",
  };
  ENV_NAMES.forEach((name) => {
    if (process.env[name]) env[name] = process.env[name]!;
  });
  const proc = spawn(python, ["-u", RUNNER], {
    cwd: dir,
    env: env as NodeJS.ProcessEnv,
    // its own process group, so its subprocesses are killed with it
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "inherit"],
    ...(sandbox && { uid: SANDBOX_ID, gid: SANDBOX_ID }),
  });
  proc.on("error", (e) => console.error("[Code Exec]", e));
  return {
    proc,
    dir,
    lines: createInterface({ input: proc.stdout! })[Symbol.asyncIterator](),
    lastUsed: Date.now(),
    queue: Promise.resolve(),
  };
}

function close(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  const { pid } = session.proc;
  if (pid) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", `${pid}`, "/t", "/f"]);
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  }
  fs.rm(session.dir, { recursive: true, force: true }, () => {});
}

// sessions idle too long, and the least recently used beyond MAX_SESSIONS,
// leaving room for the one asked for
function sweep(keep: string) {
  const byAge = [...sessions]
    .filter(([id]) => id !== keep)
    .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
  byAge.forEach(([id, session], i) => {
    if (
      Date.now() - session.lastUsed > IDLE_MS ||
      byAge.length - i >= MAX_SESSIONS
    ) {
      close(id);
    }
  });
}

async function execute(id: string, session: Session, code: string) {
  session.proc.stdin!.write(JSON.stringify({ code }) + "\n");
  let timeout = INSTALL_TIMEOUT_MS;
  for (;;) {
    const timedOut = new AbortController();
    const line = await Promise.race([
      session.lines.next(),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, timeout);
        timedOut.signal.onabort = () => clearTimeout(timer);
      }),
    ]);
    timedOut.abort();
    if (!line || line.done) {
      // python can't be interrupted from here, so drop it and its state
      close(id);
      return {
        error: line
          ? "The Python process exited, the Python session was reset"
          : `Timed out after ${timeout / 1000}s, the Python session was reset`,
      };
    }
    const message = JSON.parse(line.value) as Output;
    if (!message.running) return message;
    // packages are installed, now the code itself runs
    timeout = RUN_TIMEOUT_MS;
  }
}

export async function POST(req: NextRequest) {
  const serverConfig = getServerSideConfig();
  // 503 and 401 make the tool run the code in the browser instead
  if (!serverConfig.codeServerPython) {
    return NextResponse.json(
      { error: "running code on the server is off (CODE_SERVER_PYTHON)" },
      { status: 503 },
    );
  }
  // unlike the model routes, an API key of the user's own isn't enough here
  if (!serverConfig.needCode) {
    return NextResponse.json(
      { error: "running code on the server needs an access code (CODE)" },
      { status: 503 },
    );
  }
  const token = (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/, "")
    .trim();
  if (
    !token.startsWith(ACCESS_CODE_PREFIX) ||
    !serverConfig.codes.has(
      md5.hash(token.slice(ACCESS_CODE_PREFIX.length)).trim(),
    )
  ) {
    return NextResponse.json(
      { error: "running code on the server needs the access code" },
      { status: 401 },
    );
  }

  const { session: id, code, fresh } = await req.json();
  if (typeof id !== "string" || typeof code !== "string") {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  sweep(id);
  let session = sessions.get(id);
  let note: string | undefined;
  if (!session) {
    if (!fresh) {
      note =
        "The server's Python session had ended (idle or reset), so this run started a fresh one";
    }
    session = start(serverConfig.codeServerPython);
    sessions.set(id, session);
  }
  const current = session;
  current.lastUsed = Date.now();
  // one run at a time per session
  const run = current.queue.then(() => execute(id, current, code));
  current.queue = run.catch(() => {});
  const body = run.then(
    (output) => {
      current.lastUsed = Date.now();
      return { ...output, ...(note && { note }) };
    },
    (e) => {
      close(id);
      return { error: `${e}` };
    },
  );

  // runs can take minutes, longer than proxies wait for a response (nginx's
  // proxy_read_timeout is 60s by default), so spaces keep the connection busy
  // until the json comes, which they don't change
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      keepAlive = setInterval(
        () => controller.enqueue(encoder.encode(" ")),
        KEEPALIVE_MS,
      );
      body.then((output) => {
        clearInterval(keepAlive);
        try {
          controller.enqueue(encoder.encode(JSON.stringify(output)));
          controller.close();
        } catch {} // the client is gone
      });
    },
    cancel() {
      clearInterval(keepAlive);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/json",
      // so neither compression nor nginx holds the spaces back
      "Cache-Control": "no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
