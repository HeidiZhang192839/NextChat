// runs python for the code execution tool (runPython in app/store/plugin.ts)
// with pyodide; the python side is python-runtime.py
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";

let ready, runtime;
// { url, headers } of the app's /api/code-proxy, sent with each run
let proxy;

async function load() {
  importScripts(PYODIDE_URL);
  const pyodide = await loadPyodide();
  await pyodide.loadPackage(["micropip", "pyodide-http"]);
  const source = await (await fetch("/python-runtime.py")).text();
  runtime = pyodide.globals.get("dict")();
  pyodide.runPython(source, { globals: runtime });
  return pyodide;
}

// sites without CORS headers can't be read from the browser, so their requests
// go through the app's server: GETs only after failing directly (most sites and
// package indexes allow CORS), others straight away, since a failed CORS POST may
// still have reached the site and must not be sent twice
function proxyUrl(url) {
  let target;
  try {
    target = new URL(url, self.location.href);
  } catch {
    return null;
  }
  if (!proxy || !/^https?:$/.test(target.protocol)) return null;
  if (target.origin === self.location.origin) return null;
  return `${proxy.url}?url=${encodeURIComponent(target.href)}`;
}

function isRetryable(method) {
  return ["GET", "HEAD"].includes((method ?? "GET").toUpperCase());
}

const nativeFetch = self.fetch.bind(self);
self.fetch = async (input, init = {}) => {
  const via =
    (typeof input === "string" || input instanceof URL) &&
    proxyUrl(String(input));
  const viaProxy = () =>
    nativeFetch(via, {
      ...init,
      headers: {
        ...proxy.headers,
        "X-Proxy-Headers": JSON.stringify(
          Object.fromEntries(new Headers(init.headers)),
        ),
      },
    });
  if (via && !isRetryable(init.method)) return viaProxy();
  try {
    return await nativeFetch(input, init);
  } catch (e) {
    if (!via) throw e;
    return viaProxy();
  }
};

// pyodide-http (urllib, requests) uses synchronous XMLHttpRequest
const xhr = XMLHttpRequest.prototype;
const { open, send, setRequestHeader } = xhr;
xhr.open = function (method, url, ...rest) {
  this._request = { method, url: String(url), rest, headers: {} };
  return open.call(this, method, url, ...rest);
};
xhr.setRequestHeader = function (name, value) {
  if (this._request) this._request.headers[name] = value;
  return setRequestHeader.call(this, name, value);
};
xhr.send = function (body) {
  const request = this._request;
  const via = request && proxyUrl(request.url);
  const viaProxy = () => {
    open.call(this, request.method, via, ...request.rest);
    for (const [name, value] of Object.entries(proxy.headers)) {
      setRequestHeader.call(this, name, value);
    }
    setRequestHeader.call(
      this,
      "X-Proxy-Headers",
      JSON.stringify(request.headers),
    );
    return send.call(this, body);
  };
  if (via && !isRetryable(request.method)) return viaProxy();
  try {
    return send.call(this, body);
  } catch (e) {
    if (!via) throw e;
    return viaProxy();
  }
};

self.onmessage = async (e) => {
  proxy = e.data.proxy;
  let pyodide;
  try {
    ready = ready || load();
    pyodide = await ready;
  } catch (ex) {
    ready = undefined;
    self.postMessage({ error: "Failed to load the Python runtime: " + ex });
    return;
  }
  const stdout = [],
    stderr = [];
  pyodide.setStdout({ batched: (s) => stdout.push(s) });
  pyodide.setStderr({ batched: (s) => stderr.push(s) });
  let output;
  try {
    const result = await runtime.get("run")(e.data.code);
    output = result.toJs({ dict_converter: Object.fromEntries });
    result.destroy();
  } catch (ex) {
    output = { error: String(ex) };
  }
  self.postMessage({
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    ...output,
  });
};
