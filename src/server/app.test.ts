import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { CachedCatalog, CuelightClient } from "./cuelight.ts";
import { Store } from "./store.ts";
import { createFakeCuelight, type FakeCuelightOptions } from "./testing/fakeCuelight.ts";

const servers: ServerType[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function harness(options: FakeCuelightOptions = {}) {
  const fake = createFakeCuelight({
    media: [{ id: "clip", kind: "file", title: "Clip", mediaType: "video/mp4" }, { id: "page", kind: "web", title: "Page", url: "https://example.com/" }],
    playlists: [{ id: "pl", name: "Rotation", items: [{ id: "i1", mediaId: "clip", assetId: "clip", position: 1, durationSeconds: 600, title: "Clip", subtitle: "" }] }],
    ...options,
  });
  const { promise, resolve } = Promise.withResolvers<AddressInfo>();
  servers.push(serve({ fetch: fake.app.fetch, hostname: "127.0.0.1", port: 0 }, resolve));
  const address = await promise;
  const cuelight = new CuelightClient({ url: `http://127.0.0.1:${address.port}`, token: fake.operatorToken });
  const store = new Store(":memory:");
  const app = createApp({ store, cuelight, catalog: new CachedCatalog(cuelight), publicUrl: "http://cable.lan:4190" });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("ETag"), body: text ? JSON.parse(text) : undefined, contentType: response.headers.get("Content-Type") };
  };
  return { fake, store, app, call };
}

describe("Cable server", () => {
  it("authors a deployment and serves its live presentation from Cuelight media", async () => {
    const { call } = await harness();
    const deployment = await call("POST", "/api/deployments", { name: "Lineup", timezone: "UTC" });
    expect(deployment.status).toBe(201);
    expect(deployment.body.guideUrl).toBe(`http://cable.lan:4190/guide/?deployment=${deployment.body.id}`);
    const channel = await call("POST", `/api/deployments/${deployment.body.id}/channels`, { number: 4, name: "Four" });
    const now = Date.now();
    const block = await call("POST", `/api/channels/${channel.body.id}/blocks`, { playlistId: "pl", title: "Rotation", startsAt: new Date(now - 5 * 60_000).toISOString(), endsAt: new Date(now + 25 * 60_000).toISOString() });
    expect(block.status).toBe(201);
    const clash = await call("POST", `/api/channels/${channel.body.id}/blocks`, { mediaId: "clip", startsAt: new Date(now).toISOString(), endsAt: new Date(now + 60_000).toISOString() });
    expect([clash.status, clash.body.error]).toEqual([409, 'overlaps block "Rotation" on this channel']);

    const presentation = await call("GET", `/api/deployments/${deployment.body.id}/presentation`);
    expect(presentation.status).toBe(200);
    expect(presentation.body.channels).toEqual([expect.objectContaining({ id: channel.body.id, number: 4 })]);
    expect(presentation.body.occurrences.map((item: { media: { mediaId: string }; startsAt: string }) => [item.media.mediaId, item.startsAt])).toEqual([
      ["clip", new Date(now - 5 * 60_000).toISOString()],
      ["clip", new Date(now + 5 * 60_000).toISOString()],
      ["clip", new Date(now + 15 * 60_000).toISOString()],
    ]);
  });

  it("requires the current ETag to edit", async () => {
    const { call } = await harness();
    const deployment = await call("POST", "/api/deployments", { name: "Lineup", timezone: "UTC" });
    const missing = await call("PATCH", `/api/deployments/${deployment.body.id}`, { name: "X", timezone: "UTC" });
    expect(missing.status).toBe(409);
    const updated = await call("PATCH", `/api/deployments/${deployment.body.id}`, { name: "X", timezone: "UTC" }, { "If-Match": deployment.etag! });
    expect([updated.status, updated.body.version, updated.etag]).toEqual([200, 2, '"v2"']);
    const stale = await call("DELETE", `/api/deployments/${deployment.body.id}`, undefined, { "If-Match": deployment.etag! });
    expect(stale.status).toBe(409);
    const invalid = await call("POST", "/api/deployments", { name: "Bad", timezone: "UTC", theme: "pastel" });
    expect([invalid.status, invalid.body.field]).toEqual([400, "theme"]);
  });

  it("adds the guide to Cuelight as an app-access web media item", async () => {
    const { call, fake } = await harness();
    const deployment = await call("POST", "/api/deployments", { name: "Lineup", timezone: "UTC" });
    const added = await call("POST", `/api/deployments/${deployment.body.id}/cuelight-media`);
    expect(added.status).toBe(200);
    expect(added.body.media).toMatchObject({ kind: "web", url: deployment.body.guideUrl, appAccess: true, title: "Cable · Lineup" });
    expect(added.body.deployment.cuelightMediaId).toBe(added.body.media.id);

    // Re-adding a URL Cuelight already knows enables app access on that item instead of duplicating it.
    fake.media.get(added.body.media.id)!.appAccess = false;
    const again = await call("POST", `/api/deployments/${deployment.body.id}/cuelight-media`);
    expect([again.body.media.id, again.body.media.appAccess]).toEqual([added.body.media.id, true]);
  });

  it("hands back the guide URL when the token cannot write media", async () => {
    const { call } = await harness({ scopes: ["media_read"] });
    const status = await call("GET", "/api/cuelight/status");
    expect(status.body).toMatchObject({ reachable: true, canWriteMedia: false });
    const deployment = await call("POST", "/api/deployments", { name: "Lineup", timezone: "UTC" });
    const refused = await call("POST", `/api/deployments/${deployment.body.id}/cuelight-media`);
    expect([refused.status, refused.body.guideUrl]).toEqual([403, deployment.body.guideUrl]);
  });

  it("lists the Cuelight library for pickers and proxies thumbnails", async () => {
    const { call, app } = await harness();
    const media = await call("GET", "/api/cuelight/media?kind=file");
    expect(media.body.items.map((item: { id: string }) => item.id)).toEqual(["clip"]);
    const playlists = await call("GET", "/api/cuelight/playlists");
    expect(playlists.body.items.map((item: { name: string }) => item.name)).toEqual(["Rotation"]);
    const thumbnail = await app.request("/api/media/clip/thumbnail");
    expect([thumbnail.status, thumbnail.headers.get("Content-Type")]).toEqual([200, "image/svg+xml"]);
    expect((await app.request("/api/media/nope/thumbnail")).status).toBe(404);
  });

  it("reports an unreachable Cuelight as a bad gateway", async () => {
    const store = new Store(":memory:");
    const cuelight = new CuelightClient({ url: "http://127.0.0.1:9", token: "t" });
    const app = createApp({ store, cuelight, catalog: new CachedCatalog(cuelight), publicUrl: "http://cable.lan" });
    const response = await app.request("/api/cuelight/playlists");
    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toMatch(/unreachable/);
  });
});
