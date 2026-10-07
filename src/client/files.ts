import type { ImportedDocument } from "../shared/intake";

export async function readArtifact(file: File): Promise<ImportedDocument> {
  if (file.size > 5 * 1024 * 1024)
    throw new Error("Artifacts must be smaller than 5 MiB.");
  const bytes = await file.arrayBuffer();
  const originalSha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  let content: string;
  if (/\.pdf$/i.test(file.name)) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    const pdf = await loading.promise;
    try {
      if (pdf.numPages > 80)
        throw new Error(
          "PDFs are limited to 80 pages. Extract a smaller relevant section.",
        );
      const pages: string[] = [];
      for (let page = 1; page <= pdf.numPages; page++) {
        const text = await (await pdf.getPage(page)).getTextContent();
        pages.push(
          `[Page ${page}]\n` +
            text.items.map((i) => ("str" in i ? i.str : "")).join(" "),
        );
        if (pages.join("\n").length > 300000)
          throw new Error("Extracted text exceeds 300,000 characters.");
      }
      content = pages.join("\n\n");
    } finally {
      await loading.destroy();
    }
  } else if (/\.docx$/i.test(file.name)) {
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(new Uint8Array(bytes), {
      filter: (entry) =>
        entry.name === "word/document.xml" && entry.originalSize <= 1048576,
    });
    if (!files["word/document.xml"])
      throw new Error("DOCX document text is missing or too large.");
    const doc = new DOMParser().parseFromString(
      strFromU8(files["word/document.xml"]),
      "application/xml",
    );
    if (doc.querySelector("parsererror"))
      throw new Error("Invalid DOCX document XML.");
    content = Array.from(doc.getElementsByTagNameNS("*", "p"))
      .map((p) =>
        Array.from(p.getElementsByTagNameNS("*", "t"))
          .map((t) => t.textContent)
          .join(""),
      )
      .join("\n");
  } else {
    if (
      !/\.(txt|md|csv|json|jsonl|html?|xml|yaml|yml|js|jsx|ts|tsx|py|css|sql|log)$/i.test(
        file.name,
      ) &&
      !file.type.startsWith("text/")
    )
      throw new Error(
        "Use text, code, CSV, JSON, Markdown, PDF or DOCX. Images and executable files are not assessed.",
      );
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (!content.trim())
    throw new Error(
      "No readable text found. Scanned PDFs need OCR before import.",
    );
  if (content.length > 300000)
    throw new Error("Extracted text exceeds 300,000 characters.");
  return {
    name: file.name.slice(0, 150),
    content,
    mediaType: file.type || "text/plain",
    originalSha256,
  };
}
