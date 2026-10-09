import type { BrowserContext, Page } from "@cloudflare/playwright";
import { CAPTURE_BYTES, byteLength } from "./evidence-limits";

// This entire function runs in a CDP isolated world. It has no application
// closures or page-owned JavaScript primitives, including fetch and JSON.
export async function captureDocument(limits: {
  captureBytes: number;
  htmlBytes: number;
  readHtml: boolean;
}) {
  let fieldsTruncated = false;
  const bounded = (s: string | null | undefined, max: number) => {
    if (s && s.length > max) fieldsTruncated = true;
    return s?.slice(0, max) ?? null;
  };
  const select = (selector: string, max: number) => {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length > max) fieldsTruncated = true;
    return Array.from(nodes).slice(0, max);
  };
  const text =
    document.body?.innerText || document.documentElement.textContent || "";
  const metadataNodes = document.querySelectorAll(
    "meta[name],meta[property],link[rel=canonical],link[hreflang]",
  );
  const structuredNodes = document.querySelectorAll(
    'script[type="application/ld+json"]',
  );
  const observation = {
    title: bounded(document.title, 512),
    metadataTruncated:
      metadataNodes.length > 70 ||
      Array.from(metadataNodes)
        .slice(0, 70)
        .some((e) =>
          [
            ["name", 128],
            ["property", 128],
            ["rel", 128],
            ["content", 1000],
            ["href", 2048],
            ["hreflang", 128],
          ].some(
            ([attr, max]) =>
              (e.getAttribute(attr as string)?.length || 0) > Number(max),
          ),
        ),
    structuredDataTruncated:
      structuredNodes.length > 8 ||
      Array.from(structuredNodes).some(
        (e) => (e.textContent?.length || 0) > 5000,
      ),
    metadata: select(
      "meta[name],meta[property],link[rel=canonical],link[hreflang]",
      70,
    ).map((e) => ({
      tag: e.tagName,
      name: bounded(e.getAttribute("name"), 128),
      property: bounded(e.getAttribute("property"), 128),
      rel: bounded(e.getAttribute("rel"), 128),
      content: bounded(e.getAttribute("content"), 1000),
      href: bounded(e.getAttribute("href"), 2048),
      hreflang: bounded(e.getAttribute("hreflang"), 128),
    })),
    headings: select("h1,h2,h3", 80).map((e) => ({
      level: e.tagName,
      text: bounded(e.textContent?.trim(), 512),
    })),
    structuredData: select('script[type="application/ld+json"]', 8).map((e) =>
      bounded(e.textContent, 5000),
    ),
    disclosureContent: select(
      "details,[role=region],[aria-hidden=true]",
      40,
    ).map((e) => bounded(e.outerHTML, 1200)),
    controls: select("button[aria-expanded],summary,[role=tab]", 50).map(
      (e) => ({
        tag: e.tagName,
        label: bounded(e.textContent?.trim(), 180),
        expanded: bounded(e.getAttribute("aria-expanded"), 16),
        controls: bounded(e.getAttribute("aria-controls"), 512),
      }),
    ),
    links: select("a[href]", 160).map((a) => ({
      label: bounded(a.textContent?.trim(), 120),
      url: bounded((a as HTMLAnchorElement).href, 2048) || "",
    })),
    text: text.slice(0, 16000),
    textTruncated: text.length > 16000,
    fieldsTruncated: false,
    serverHtml: undefined as
      | undefined
      | {
          text: string;
          headings: string[];
          truncated: boolean;
          status: number;
          method: string;
        },
    serverHtmlUnavailable: undefined as undefined | string,
  };
  // Do not use Playwright Response.text/body: that transfers the whole response.
  // This is a separate HTTP read, parsed without executing its HTML scripts.
  if (limits.readHtml) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const r = await fetch(location.href, {
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      reader = r.body?.getReader();
      if (!reader || !/html/i.test(r.headers.get("content-type") || ""))
        throw new Error("Not an HTML response");
      let count = 0,
        html = "",
        truncated = false;
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          html += decoder.decode();
          break;
        }
        const remaining = limits.htmlBytes - count;
        html += decoder.decode(value.subarray(0, remaining), { stream: true });
        count += value.byteLength;
        if (count >= limits.htmlBytes) {
          truncated = true;
          break;
        }
      }
      const parsed = new DOMParser().parseFromString(html, "text/html");
      parsed
        .querySelectorAll("script,style,noscript,svg")
        .forEach((e) => e.remove());
      const raw = (parsed.body.textContent || "").replace(/\s+/g, " ").trim();
      const headings = Array.from(parsed.querySelectorAll("h1,h2,h3"))
        .slice(0, 80)
        .map(
          (e) => bounded(e.textContent?.replace(/\s+/g, " ").trim(), 512) || "",
        );
      observation.serverHtml = {
        text: raw.slice(0, 22000),
        headings,
        truncated: truncated || raw.length > 22000,
        status: r.status,
        method: "separate bounded HTTP HTML read; scripts not executed",
      };
    } catch {
      observation.serverHtmlUnavailable =
        "The bounded independent HTTP HTML read was unavailable.";
    } finally {
      await reader?.cancel().catch(() => {});
    }
  }
  // Account for UTF-8, JSON escaping and all fields before CDP serialization.
  const bytes = () =>
    new TextEncoder().encode(JSON.stringify(observation)).length;
  for (const list of [
    observation.links,
    observation.disclosureContent,
    observation.structuredData,
    observation.metadata,
    observation.headings,
    observation.controls,
  ]) {
    while (bytes() > limits.captureBytes && list.length) {
      list.pop();
      fieldsTruncated = true;
      if (list === observation.metadata) observation.metadataTruncated = true;
      if (list === observation.structuredData)
        observation.structuredDataTruncated = true;
    }
  }
  observation.fieldsTruncated = fieldsTruncated;
  if (bytes() > limits.captureBytes)
    throw new Error("Capture exceeds the byte budget");
  return observation;
}

export async function isolatedCapture(
  context: BrowserContext,
  page: Page,
  readHtml: boolean,
) {
  const cdp = await context.newCDPSession(page);
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "intenttrace-evidence",
    });
    const result = await cdp.send("Runtime.callFunctionOn", {
      executionContextId,
      functionDeclaration: captureDocument.toString(),
      arguments: [
        {
          value: {
            captureBytes: CAPTURE_BYTES - 8192,
            htmlBytes: 200000,
            readHtml,
          },
        },
      ],
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails || !result.result.value)
      throw new Error("Bounded capture unavailable");
    // Defence in depth: metadata added by the Worker also needs room.
    if (byteLength(JSON.stringify(result.result.value)) > CAPTURE_BYTES - 8192)
      throw new Error("Capture exceeds the byte budget");
    return result.result.value as Awaited<ReturnType<typeof captureDocument>>;
  } finally {
    await cdp.detach().catch(() => {});
  }
}
