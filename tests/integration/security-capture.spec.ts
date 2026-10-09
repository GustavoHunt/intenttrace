import { test, expect, chromium } from "@playwright/test";
import { isolatedCapture } from "../../src/server/browser-capture";
import { CAPTURE_BYTES } from "../../src/server/evidence-limits";

test("captures hostile page primitives and oversized UTF-8 HTML in an isolated world", async () => {
  const browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
  });
  try {
    const context = await browser.newContext();
    let requests = 0;
    let hostilePage = true;
    await context.route("**/*", async (route) => {
      requests++;
      expect(route.request().method()).toBe("GET");
      const hostile = `<h1>Normal heading</h1><p>Normal body</p><script>document.title='界'.repeat(50000);String.prototype.slice=function(){return this.toString()};JSON.stringify=()=> 'bad';fetch=()=>{throw Error('bad')};Document.prototype.querySelectorAll=()=>[];</script>`;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: hostilePage
          ? hostile + "界".repeat(100000)
          : `<link rel="canonical" href="https://staging.example.com/"><h1>Normal heading</h1><p>Project summary delivered</p><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"acceptedAnswer":{"text":"Project summary delivered"}}]}</script>` +
            `<a href="https://staging.example.com/">Link</a>`.repeat(161),
      });
    });
    const page = await context.newPage();
    await page.goto("https://example.com/");
    const result = await isolatedCapture(context as any, page as any, true);
    expect(result.title!.length).toBe(512);
    expect(result.headings[0].text).toBe("Normal heading");
    expect(result.serverHtml?.method).toContain("separate bounded HTTP");
    expect(result.serverHtml?.status).toBe(200);
    expect(result.serverHtml?.truncated).toBe(true);
    expect(result.serverHtml?.text).toContain("Normal body");
    expect(
      new TextEncoder().encode(JSON.stringify(result)).length,
    ).toBeLessThan(CAPTURE_BYTES);
    expect(requests).toBe(2);
    hostilePage = false;
    await page.goto("https://staging.example.com/");
    const normal = await isolatedCapture(context as any, page as any, true);
    expect(normal.fieldsTruncated).toBe(true);
    expect(normal.links).toHaveLength(160);
    expect(normal.metadataTruncated).toBe(false);
    expect(normal.structuredDataTruncated).toBe(false);
    expect(normal.serverHtml?.truncated).toBe(false);
    const { evaluationCase } =
      await import("../../src/server/evaluation-cases");
    const { acceptanceResults } = await import("../../src/server/acceptance");
    for (const kind of ["canonical", "faq"] as const) {
      const c = await evaluationCase("visible-delivery");
      c.evidencePlan!.checks[0].kind = kind;
      c.evidencePlan!.checks[0].expected = "";
      c.artifacts[0].content = JSON.stringify({ ...normal, status: 200 });
      expect(acceptanceResults(c)[0].status).toBe("supported");
    }
  } finally {
    await browser.close();
  }
});
