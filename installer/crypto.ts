import { base64, bytes, random } from "./core";
const encoder = new TextEncoder();
async function key(secret: string) {
  if (secret.length < 32) throw new Error("Installer encryption secret is not configured");
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(secret)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(value: unknown, secret: string, session: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(session) }, await key(secret), encoder.encode(JSON.stringify(value)));
  return `${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}
export async function unseal<T>(value: string, secret: string, session: string): Promise<T> {
  const [iv, data] = value.split(".");
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: encoder.encode(session) }, await key(secret), bytes(data))));
}
export async function pkce() {
  const verifier = random();
  const challenge = base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}
