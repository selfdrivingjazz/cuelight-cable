import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

// A tiny in-memory Cuelight implementing the slice of the public API Cable
// uses: operator media/playlist reads, web media creation with appAccess,
// thumbnails, and the app API (/app/*) the guide calls with an app token.
// Used by tests and the local smoke run; not a faithful Cuelight.

export interface FakeMedia {
  id: string;
  kind: "file" | "web";
  title: string;
  assetId?: string;
  url?: string;
  appAccess?: boolean;
  mediaType?: string;
}

export interface FakePlaylistItem {
  id: string;
  mediaId: string;
  assetId?: string;
  position: number;
  durationSeconds: number;
  title: string;
  subtitle: string;
}

export interface FakePlaylist {
  id: string;
  name: string;
  description?: string;
  items: FakePlaylistItem[];
}

export interface FakeCuelightOptions {
  media?: FakeMedia[];
  playlists?: FakePlaylist[];
  operatorToken?: string;
  appToken?: string;
  /** Operator scopes reported by /operator/me and enforced for writes. */
  scopes?: string[];
}

interface RemoteEvent {
  sequence: number;
  type: "key";
  key: string;
}

const created = "2026-10-01T00:00:00.000Z";
const actor = "00000000-0000-4000-8000-000000000001";

function mediaJson(media: FakeMedia, version: number) {
  return {
    id: media.id,
    kind: media.kind,
    title: media.title,
    tags: [],
    version,
    createdBy: actor,
    updatedBy: actor,
    createdAt: created,
    updatedAt: created,
    ...(media.kind === "file"
      ? { assetId: media.assetId ?? media.id, artifact: { digest: "0".repeat(64), size: 1024, mediaType: media.mediaType ?? "video/mp4", state: "ready" }, playback: { fit: "fit", loop: true, muted: false, volume: 100, orientation: 0 } }
      : { url: media.url, appAccess: media.appAccess ?? false }),
  };
}

function playlistJson(playlist: FakePlaylist) {
  return { id: playlist.id, name: playlist.name, description: playlist.description ?? "", items: playlist.items.map((item) => ({ ...item, playlistId: playlist.id })), version: 1, createdBy: actor, createdAt: created, updatedAt: created };
}

/** Deterministic SVG poster per media id so thumbnails differ visibly. */
function thumbnailSvg(media: FakeMedia): string {
  let hash = 0;
  for (const char of media.id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  const title = media.title.replace(/[<>&"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hash},70%,45%)"/><stop offset="1" stop-color="hsl(${(hash + 140) % 360},70%,20%)"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><text x="32" y="320" font-family="sans-serif" font-size="34" fill="white">${title}</text></svg>`;
}

const page = <T>(items: T[]) => ({ items, page: { nextCursor: null, previousCursor: null, hasMore: false } });

export function createFakeCuelight(options: FakeCuelightOptions = {}) {
  const operatorToken = options.operatorToken ?? "operator-token";
  const appToken = options.appToken ?? "app-token";
  const scopes = options.scopes ?? ["media_read", "media_write"];
  const media = new Map((options.media ?? []).map((item) => [item.id, { ...item }]));
  const versions = new Map<string, number>();
  const playlists = new Map((options.playlists ?? []).map((item) => [item.id, item]));
  const events: RemoteEvent[] = [];
  const waiters = new Set<() => void>();
  const requests: string[] = [];

  const versionOf = (id: string) => versions.get(id) ?? 1;
  const problem = (c: Context, status: 401 | 403 | 404 | 409 | 400, title: string) => c.json({ type: "about:blank", title, status }, status);
  const bearer = (c: Context) => c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("access_token") ?? "";

  const app = new Hono().basePath("/api/v1");
  app.use("*", async (c, next) => {
    requests.push(`${c.req.method} ${new URL(c.req.url).pathname}`);
    await next();
  });

  // Operator API
  const operator = new Hono();
  operator.use("*", async (c, next) => {
    if (bearer(c) !== operatorToken) return problem(c, 401, "operator token required");
    await next();
  });
  operator.get("/operator/me", (c) => c.json({ id: actor, scopes, capabilities: {} }));
  operator.get("/media", (c) => {
    const kind = c.req.query("kind");
    const search = c.req.query("search")?.toLowerCase();
    const items = [...media.values()].filter((item) => (!kind || item.kind === kind) && (!search || item.title.toLowerCase().includes(search)));
    return c.json(page(items.map((item) => mediaJson(item, versionOf(item.id)))));
  });
  operator.post("/media", async (c) => {
    if (!scopes.includes("media_write")) return problem(c, 403, "media_write scope required");
    const body = await c.req.json<{ kind?: string; url?: string; title?: string; appAccess?: boolean }>();
    if (body.kind !== "web" || !body.url) return problem(c, 400, "web media need a url");
    const existing = [...media.values()].find((item) => item.url === body.url);
    if (existing) return c.json(mediaJson(existing, versionOf(existing.id)), 200, { ETag: `"v${versionOf(existing.id)}"` });
    const item: FakeMedia = { id: randomUUID(), kind: "web", url: body.url, title: body.title ?? body.url, appAccess: body.appAccess ?? false };
    media.set(item.id, item);
    return c.json(mediaJson(item, 1), 201, { ETag: '"v1"' });
  });
  operator.get("/media/:id", (c) => {
    const item = media.get(c.req.param("id"));
    return item ? c.json(mediaJson(item, versionOf(item.id))) : problem(c, 404, "media not found");
  });
  operator.patch("/media/:id", async (c) => {
    if (!scopes.includes("media_write")) return problem(c, 403, "media_write scope required");
    const item = media.get(c.req.param("id"));
    if (!item) return problem(c, 404, "media not found");
    if (c.req.header("If-Match") !== `"v${versionOf(item.id)}"`) return problem(c, 409, "version conflict");
    const body = await c.req.json<{ appAccess?: boolean; title?: string }>();
    if (body.appAccess !== undefined) item.appAccess = body.appAccess;
    if (body.title !== undefined) item.title = body.title;
    versions.set(item.id, versionOf(item.id) + 1);
    return c.json(mediaJson(item, versionOf(item.id)), 200, { ETag: `"v${versionOf(item.id)}"` });
  });
  operator.get("/media/:id/thumbnail", (c) => {
    const item = media.get(c.req.param("id"));
    return item ? c.body(thumbnailSvg(item), 200, { "Content-Type": "image/svg+xml" }) : problem(c, 404, "media not found");
  });
  operator.get("/playlists", (c) => c.json(page([...playlists.values()].map(playlistJson))));
  operator.get("/playlists/:id", (c) => {
    const playlist = playlists.get(c.req.param("id"));
    return playlist ? c.json(playlistJson(playlist)) : problem(c, 404, "playlist not found");
  });

  // App API (bearer = app token; CORS open, no cookies)
  const appApi = new Hono();
  appApi.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Range"], exposeHeaders: ["Content-Range", "Accept-Ranges"] }));
  appApi.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    if (bearer(c) !== appToken) return problem(c, 401, "app token required");
    await next();
  });
  appApi.get("/context", (c) => c.json({ nodeId: "node-1", nodeName: "Fake screen", mediaId: "guide-media" }));
  appApi.get("/media", (c) => c.json(page([...media.values()].map((item) => mediaJson(item, versionOf(item.id))))));
  appApi.get("/media/:id", (c) => {
    const item = media.get(c.req.param("id"));
    return item ? c.json(mediaJson(item, versionOf(item.id))) : problem(c, 404, "media not found");
  });
  appApi.get("/media/:id/content", (c) => {
    const item = media.get(c.req.param("id"));
    if (!item || item.kind !== "file") return problem(c, 404, "media not found");
    // SVG stands in for real bytes; only image/* media render in a browser.
    return c.body(thumbnailSvg(item), 200, { "Content-Type": item.mediaType?.startsWith("image/") ? "image/svg+xml" : "application/octet-stream", "Accept-Ranges": "bytes" });
  });
  appApi.get("/media/:id/thumbnail", (c) => {
    const item = media.get(c.req.param("id"));
    return item ? c.body(thumbnailSvg(item), 200, { "Content-Type": "image/svg+xml" }) : problem(c, 404, "media not found");
  });
  appApi.get("/playlists", (c) => c.json(page([...playlists.values()].map(playlistJson))));
  appApi.get("/playlists/:id", (c) => {
    const playlist = playlists.get(c.req.param("id"));
    return playlist ? c.json(playlistJson(playlist)) : problem(c, 404, "playlist not found");
  });
  appApi.get("/remote/events", async (c) => {
    const after = Number(c.req.query("after") ?? 0);
    const waitSeconds = Math.min(25, Math.max(0, Number(c.req.query("waitSeconds") ?? 0)));
    const pending = () => events.filter((event) => event.sequence > after);
    if (pending().length === 0 && waitSeconds > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          waiters.delete(done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, waitSeconds * 1000);
        waiters.add(done);
        c.req.raw.signal.addEventListener("abort", done);
      });
    }
    return c.json({ events: pending(), nextSequence: events.at(-1)?.sequence ?? 0 });
  });

  app.route("/app", appApi);
  app.route("/", operator);

  return {
    app,
    operatorToken,
    appToken,
    media,
    requests,
    /** Queues a remote key press for the app remote-events long poll. */
    pressKey(key: string) {
      events.push({ sequence: (events.at(-1)?.sequence ?? 0) + 1, type: "key", key });
      for (const wake of [...waiters]) wake();
    },
  };
}
