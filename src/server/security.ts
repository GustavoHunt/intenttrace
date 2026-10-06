import { z } from "zod";
export class HttpError extends Error {
  constructor(
    public status: number,
    public publicMessage: string,
  ) {
    super(`INTENTTRACE:${status}:${publicMessage}`);
  }
}
export const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export function sameOrigin(req: Request) {
  const u = new URL(req.url);
  const origin = req.headers.get("Origin");
  if (origin !== u.origin)
    throw new HttpError(403, "Same-origin request required");
}
export async function readJson(req: Request, max = 1048576) {
  if (!req.headers.get("content-type")?.includes("application/json"))
    throw new HttpError(415, "Send application/json");
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "Missing JSON body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, "JSON exceeds the upload limit");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let i = 0;
  for (const c of chunks) {
    all.set(c, i);
    i += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
const enc = new TextEncoder();
async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function unb64(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export async function signSession(
  id: string,
  expiresAt: number,
  secret: string,
) {
  const payload = b64(enc.encode(JSON.stringify({ id, expiresAt })));
  return (
    payload +
    "." +
    b64(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await key(secret),
          enc.encode(payload),
        ),
      ),
    )
  );
}
export async function verifySession(token: string, secret: string) {
  try {
    const [payload, sig, extra] = token.split(".");
    if (
      extra ||
      !payload ||
      !sig ||
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        unb64(sig),
        enc.encode(payload),
      ))
    )
      return null;
    const data = z
      .object({ id: z.uuid(), expiresAt: z.number() })
      .parse(JSON.parse(new TextDecoder().decode(unb64(payload))));
    return data.expiresAt > Date.now() ? data : null;
  } catch {
    return null;
  }
}
export function cookie(req: Request) {
  return (
    req.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("intenttrace="))
      ?.slice(12) || ""
  );
}
