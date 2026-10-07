import { it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ default: { get: mocks.get } }));
import { fetchPublic } from "../scripts/source-fetch";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
});
function reply(status: number, headers: Record<string, string>, body: string) {
  mocks.get.mockImplementation((_url, options, callback) => {
    options.lookup("example.test", { all: true }, (_err: any, addresses: any) =>
      expect(addresses).toEqual([{ address: "1.1.1.1", family: 4 }]),
    );
    const response = Object.assign(new EventEmitter(), {
      statusCode: status,
      headers,
      resume: vi.fn(),
      destroy: vi.fn(),
    });
    queueMicrotask(() => {
      callback(response);
      response.emit("data", Buffer.from(body));
      response.emit("end");
    });
    return { setTimeout: vi.fn(), on: vi.fn(), destroy: vi.fn() };
  });
}
it("pins the validated address with the Node all-addresses lookup contract", async () => {
  reply(200, { "content-type": "text/plain" }, "Synthetic artifact");
  expect(
    (await fetchPublic("https://example.test/artifact", "artifact")).text,
  ).toBe("Synthetic artifact");
  const options = mocks.get.mock.calls[0][1];
  expect(options.headers.Cookie).toBeUndefined();
  expect(options.headers.Authorization).toBeUndefined();
});
it("revalidates a redirect and rejects a private destination before connecting", async () => {
  mocks.lookup
    .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }])
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  reply(302, { location: "https://private.test/secret" }, "");
  await expect(
    fetchPublic("https://example.test/artifact", "artifact"),
  ).rejects.toThrow("Private and local");
  expect(mocks.get).toHaveBeenCalledTimes(1);
});
it("rejects oversized responses", async () => {
  reply(200, { "content-type": "text/plain" }, "x".repeat(1048577));
  await expect(
    fetchPublic("https://example.test/artifact", "artifact"),
  ).rejects.toThrow("1 MiB");
});
it("requires file intake for binary artifacts", async () => {
  reply(200, { "content-type": "application/pdf" }, "binary");
  await expect(
    fetchPublic("https://example.test/file.pdf", "artifact"),
  ).rejects.toThrow("binary artifact");
});
