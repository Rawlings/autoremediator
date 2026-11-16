import request from "request";

/** Cookies a session keeps for one site, as the `Cookie` header would carry them. */
export function sessionCookieHeader(): string {
  const jar = request.jar();
  const cookie = request.cookie("session=abc123; Path=/");
  if (cookie === undefined) throw new Error("cookie did not parse");
  jar.setCookie(cookie, "https://example.com");
  return jar.getCookieString("https://example.com");
}

/** A client preconfigured for one API; no request is sent. */
export function apiClient(): typeof request {
  return request.defaults({ baseUrl: "https://api.example.com", headers: { accept: "application/json" } });
}
