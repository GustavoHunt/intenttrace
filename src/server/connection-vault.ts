import type { EvidenceConnection } from "../shared/investigation";

async function key(seed: string) {
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function sealConnections(
  seed: string,
  records: EvidenceConnection[],
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(seed),
    new TextEncoder().encode(JSON.stringify(records)),
  );
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(data)) };
}
export async function openConnections(
  seed: string,
  sealed?: { iv: number[]; data: number[] },
): Promise<EvidenceConnection[]> {
  if (!sealed) return [];
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(sealed.iv) },
    await key(seed),
    new Uint8Array(sealed.data),
  );
  return JSON.parse(new TextDecoder().decode(raw));
}
