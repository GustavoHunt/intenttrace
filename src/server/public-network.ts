import ipaddr from "ipaddr.js";
// Fetch candidates are a closed list. Neither page instructions nor model output
// can expand browsing to arbitrary hosts, credentials, ports or action endpoints.
export function publicPage(value: string): URL {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    ipaddr.isValid(u.hostname.replace(/[\[\]]/g, "")) ||
    !u.hostname.includes(".") ||
    /\.(localhost|local|internal|test|invalid)$/i.test(u.hostname) ||
    /(?:^|[/?&=_-])(logout|signout|delete|remove|unsubscribe|checkout|purchase|admin)(?:$|[/?&=_-])/i.test(
      u.pathname + u.search,
    )
  )
    throw new Error(
      "Only public HTTPS pages without credentials or action URLs can be inspected.",
    );
  u.hash = "";
  return u;
}
export async function publicDns(hostname: string) {
  const results = await Promise.all(
    ["A", "AAAA"].map(async (type) => {
      const r = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!r.ok) throw new Error("Public DNS verification unavailable.");
      return await r.json<{ Answer?: { type: number; data: string }[] }>();
    }),
  );
  const addresses = results
    .flatMap((r) => r.Answer || [])
    .filter((a) => a.type === 1 || a.type === 28);
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        !ipaddr.isValid(a.data) || ipaddr.process(a.data).range() !== "unicast",
    )
  )
    throw new Error(
      "The host did not resolve exclusively to public network addresses.",
    );
}
