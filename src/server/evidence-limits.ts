import type { Artifact } from "../shared/domain";
import { HttpError } from "./security";

export const CAPTURE_BYTES = 262144;
export const COLLECTION_BYTES = 8388608;
// Preserve the incoming 900,000-character artifact contract for UTF-8 text.
export const ARTIFACT_BYTES = 3600000;
export const CASE_BODY_BYTES = 16777216;
export const SNAPSHOT_BYTES = 20971520;
export const byteLength = (text: string) =>
  new TextEncoder().encode(text).length;

export function assertArtifactBody(a: Artifact) {
  const size = byteLength(a.content);
  if (size > (a.observation ? CAPTURE_BYTES : ARTIFACT_BYTES))
    throw new HttpError(
      413,
      "Evidence body exceeds the size limit. Recollect a smaller capture or supply a smaller artifact.",
    );
  return size;
}
export function assertCaseBodies(artifacts: Artifact[]) {
  let total = 0;
  for (const a of artifacts) total += assertArtifactBody(a);
  if (total > CASE_BODY_BYTES)
    throw new HttpError(
      413,
      "Case evidence bodies exceed the size limit. Create a smaller case.",
    );
}
export function assertSnapshot(text: string) {
  if (byteLength(text) > SNAPSHOT_BYTES)
    throw new HttpError(
      413,
      "Assessment snapshot exceeds the evidence size limit.",
    );
}

// Check metadata before reading, then count actual bytes before decoding them.
// The streamed gate also handles old or incorrectly labelled stored objects.
export async function boundedStoredText(
  stored: { size: number; body: ReadableStream<Uint8Array> },
  limit: number,
) {
  const reader = stored.body.getReader();
  try {
    if (stored.size > limit)
      throw new HttpError(
        413,
        "Stored evidence exceeds the size limit. Recollect a smaller capture.",
      );
    let count = 0,
      text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      count += value.byteLength;
      if (count > limit)
        throw new HttpError(
          413,
          "Stored evidence exceeds the size limit. Recollect a smaller capture.",
        );
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function deleteCaseEvidence(bucket: R2Bucket, agentName: string) {
  // Re-list the first batch after deletion: no cursor can skip a shifted page.
  while (true) {
    const batch = await bucket.list({ prefix: `${agentName}/`, limit: 1000 });
    if (!batch.objects.length) return;
    await bucket.delete(batch.objects.map((item) => item.key));
  }
}
