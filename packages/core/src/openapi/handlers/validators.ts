import type http from "node:http";

import { HttpError, readBody, sendJson } from "../http-utils.js";

/** Read the JSON request body, answering the request itself (415/413/400) when it is unusable. */
export async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<unknown> {
  try {
    const body = await readBody(req);
    if (typeof body !== "object" || body === null) {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return undefined;
    }
    return body;
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      // Stop reading an oversized upload once the rejection has been delivered.
      if (error.status === 413) res.once("finish", () => req.destroy());
    } else {
      sendJson(res, 400, { error: "Invalid JSON body" });
    }
    return undefined;
  }
}
