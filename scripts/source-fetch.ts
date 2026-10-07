import https from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import type { Plugin } from "vite";
import { parseHTML } from "linkedom";
import { shareProvider } from "../src/shared/intake.ts";
import { parseSharedHtml } from "../src/shared/share-html.ts";

export function publicAddress(address: string) {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function sourceUrl(raw: string, kind: string) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    u.hostname.length > 253
  )
    throw new Error(
      "Use a public HTTPS URL without credentials or a custom port.",
    );
  if (kind === "conversation") shareProvider(raw);
  return u;
}
// Pin the validated DNS answer into the connection, including every redirect.
export async function fetchPublic(
  raw: string,
  kind: string,
  redirects = 0,
): Promise<{ text: string; mediaType: string }> {
  const u = sourceUrl(raw, kind);
  const addresses = await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("Private and local network addresses are blocked.");
  const target = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.get(
      u,
      {
        headers: {
          Accept: "text/html, application/json, text/plain",
          "User-Agent": "IntentTrace/0.1 public-evidence-import",
        },
        lookup: ((_host: any, options: any, cb: any) =>
          options.all
            ? cb(null, [target])
            : cb(null, target.address, target.family)) as any,
      },
      (response) => {
        const status = response.statusCode || 500;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (redirects >= 3 || !response.headers.location)
            return reject(new Error("Too many redirects."));
          void fetchPublic(
            new URL(response.headers.location, u).href,
            kind,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(
            new Error(
              `The source returned HTTP ${status}. Import a conversation export or paste the original prompt instead.`,
            ),
          );
          return;
        }
        const type = String(
          response.headers["content-type"] || "text/plain",
        ).split(";")[0];
        if (
          !/^(text\/|application\/(json|xml|javascript|x-javascript))/.test(
            type,
          )
        ) {
          response.resume();
          reject(
            new Error(
              "This URL is a binary artifact. Download it and use Add artifact instead.",
            ),
          );
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1048576) {
            response.destroy();
            reject(new Error("Source exceeds the 1 MiB import limit."));
          } else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            text: Buffer.concat(chunks).toString("utf8"),
            mediaType: type,
          }),
        );
        response.on("error", reject);
      },
    );
    request.setTimeout(15000, () =>
      request.destroy(
        new Error(
          "Source timed out. Use an export or paste the original prompt.",
        ),
      ),
    );
    request.on("error", reject);
  });
}
export function sourceImport(): Plugin {
  return {
    name: "intenttrace-local-source",
    configureServer(server) {
      server.middlewares.use("/local/source", async (req, res) => {
        const respond = (status: number, value: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(value));
        };
        try {
          const origin = new URL(
            req.headers.origin || "https://invalid.invalid",
          );
          if (
            req.method !== "POST" ||
            !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
            origin.host !== req.headers.host ||
            req.headers["content-type"] !== "application/json"
          )
            throw new Error(
              "Only same-origin local JSON requests are allowed.",
            );
          let raw = "";
          for await (const chunk of req) {
            raw += chunk.toString();
            if (Buffer.byteLength(raw) > 5000)
              throw new Error("Request exceeds the import limit.");
          }
          const body = JSON.parse(raw);
          if (
            !["conversation", "artifact"].includes(body.kind) ||
            typeof body.url !== "string" ||
            body.url.length > 2048
          )
            throw new Error("Choose a conversation or artifact URL.");
          const result = await fetchPublic(body.url, body.kind);
          if (body.kind === "conversation")
            return respond(200, {
              ...parseSharedHtml(result.text, shareProvider(body.url)),
              provider: shareProvider(body.url),
              sourceUrl: body.url,
              warnings: [
                "Shared conversations are snapshots. Attachments may be absent; add the delivered artifact separately.",
              ],
            });
          let content = result.text;
          if (result.mediaType === "text/html") {
            const { document } = parseHTML(content);
            document
              .querySelectorAll("script,style,noscript,nav")
              .forEach((n) => n.remove());
            content = (
              document.body?.textContent ||
              document.documentElement.textContent ||
              ""
            ).trim();
          }
          if (!content || content.length > 300000)
            throw new Error(
              "No readable artifact text, or extracted text exceeds 300,000 characters.",
            );
          respond(200, {
            name: decodeURIComponent(
              new URL(body.url).pathname.split("/").pop() || "linked-artifact",
            ).slice(0, 150),
            content,
            mediaType: "text/plain",
          });
        } catch (error) {
          respond(400, {
            error:
              error instanceof Error
                ? error.message
                : "Import failed. Use the manual fallback.",
          });
        }
      });
    },
  };
}
