export class ApiPageError extends Error {
  constructor(
    public site: string | undefined,
    public browserRequest: boolean,
    public challenge: boolean,
  ) {
    super(
      challenge
        ? "The provider requires a browser security check."
        : "The API returned a web page instead of API data.",
    );
  }
}

export function checkApiResponse(
  response: Response,
  path: string,
  headers?: HeadersInit,
) {
  const challenge = response.headers.get("cf-mitigated") === "challenge";
  const type = response.headers
    .get("content-type")
    ?.split(";")[0]
    .toLowerCase();
  if (!challenge && type !== "text/html" && type !== "application/xhtml+xml") {
    return;
  }

  const endpoint = path.startsWith("/api/proxy/")
    ? new Headers(headers).get("x-base-url") ?? ""
    : path;
  throw new ApiPageError(
    apiOrigin(endpoint),
    endpoint === path && !window.__TAURI__,
    challenge,
  );
}

// Use the configured origin, not an address from the returned page or redirects.
function apiOrigin(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol === "https:" || url.protocol === "http:")
      return url.origin;
  } catch {
    // Relative API routes don't identify an upstream site.
  }
}
