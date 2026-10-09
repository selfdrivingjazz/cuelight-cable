import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { CuelightError, type CuelightCatalog, type CuelightClient } from "./cuelight.ts";
import {
  ConflictError,
  NotFoundError,
  OverlapError,
  ValidationError,
  etag,
  parseBlockInput,
  parseChannelInput,
  parseDeploymentInput,
  parseProgramInput,
  versionFromIfMatch,
  type Deployment,
} from "./domain.ts";
import { buildPresentation } from "./presentation.ts";
import type { Store } from "./store.ts";

export interface AppOptions {
  store: Store;
  cuelight: CuelightClient;
  /** Cached reads used by the presentation builder. */
  catalog: CuelightCatalog;
  /** Origin screens use to reach this server (guide URLs are built from it). */
  publicUrl: string;
  /** Built frontend (vite build output); omitted in API-only tests. */
  distDir?: string;
}

export function guideUrl(publicUrl: string, deploymentId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/guide/?deployment=${encodeURIComponent(deploymentId)}`;
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof ValidationError) return c.json({ error: error.message, field: error.field }, 400);
  if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
  if (error instanceof ConflictError || error instanceof OverlapError) return c.json({ error: error.message }, 409);
  if (error instanceof CuelightError) return c.json({ error: error.message, cuelightStatus: error.status }, 502);
  if (error instanceof SyntaxError) return c.json({ error: "request body must be valid JSON" }, 400);
  console.error(error);
  return c.json({ error: "internal error" }, 500);
}

export function createApp({ store, cuelight, catalog, publicUrl, distDir }: AppOptions): Hono {
  const app = new Hono();
  const withGuide = (deployment: Deployment) => ({ ...deployment, guideUrl: guideUrl(publicUrl, deployment.id) });
  const ifMatch = (c: Context) => versionFromIfMatch(c.req.header("If-Match"));

  app.onError((error, c) => errorResponse(c, error));

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/config", (c) => c.json({ publicUrl, cuelightApi: cuelight.apiBase }));

  // Cuelight library (editor pickers) and connection status.
  app.get("/api/cuelight/status", async (c) => {
    try {
      const scopes = await cuelight.scopes();
      return c.json({ reachable: true, scopes, canWriteMedia: scopes.includes("media_write") });
    } catch (error) {
      return c.json({ reachable: false, scopes: [], canWriteMedia: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/cuelight/media", async (c) => {
    const kind = c.req.query("kind");
    return c.json(await cuelight.listMedia({ cursor: c.req.query("cursor"), search: c.req.query("search"), kind: kind === "file" || kind === "web" ? kind : undefined }));
  });
  app.get("/api/cuelight/media/:id", async (c) => {
    const media = await catalog.media(c.req.param("id"));
    return media ? c.json(media) : c.json({ error: "media not found in Cuelight" }, 404);
  });
  app.get("/api/cuelight/playlists", async (c) => c.json(await cuelight.listPlaylists({ cursor: c.req.query("cursor") })));
  app.get("/api/cuelight/playlists/:id", async (c) => {
    const playlist = await catalog.playlist(c.req.param("id"));
    return playlist ? c.json(playlist) : c.json({ error: "playlist not found in Cuelight" }, 404);
  });

  // Thumbnails for the editor and the guide's preview mode (no app token).
  app.get("/api/media/:id/thumbnail", async (c) => {
    const upstream = await cuelight.thumbnail(c.req.param("id"), c.req.query("v"));
    if (!upstream.ok) return c.body(null, upstream.status === 404 ? 404 : 502);
    const headers = new Headers({ "Cache-Control": upstream.headers.get("Cache-Control") ?? "public, max-age=60" });
    for (const name of ["Content-Type", "Content-Length", "ETag"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: 200, headers });
  });

  // Deployments
  app.get("/api/deployments", (c) => c.json({ items: store.listDeployments().map(withGuide) }));
  app.post("/api/deployments", async (c) => {
    const created = store.createDeployment(parseDeploymentInput(await c.req.json()));
    return c.json(withGuide(created), 201, { ETag: etag(created.version) });
  });
  app.get("/api/deployments/:id", (c) => {
    const deployment = store.deployment(c.req.param("id"));
    return c.json(withGuide(deployment), 200, { ETag: etag(deployment.version) });
  });
  app.patch("/api/deployments/:id", async (c) => {
    const updated = store.updateDeployment(c.req.param("id"), ifMatch(c), parseDeploymentInput(await c.req.json()));
    return c.json(withGuide(updated), 200, { ETag: etag(updated.version) });
  });
  app.delete("/api/deployments/:id", (c) => {
    store.deleteDeployment(c.req.param("id"), ifMatch(c));
    return c.body(null, 204);
  });
  app.get("/api/deployments/:id/presentation", async (c) => {
    const presentation = await buildPresentation(store, catalog, c.req.param("id"));
    return c.json(presentation, 200, { "Cache-Control": "no-store" });
  });
  app.post("/api/deployments/:id/cuelight-media", async (c) => {
    const deployment = store.deployment(c.req.param("id"));
    const url = guideUrl(publicUrl, deployment.id);
    try {
      const media = await cuelight.ensureAppWebMedia(url, `Cable · ${deployment.name}`);
      return c.json({ deployment: withGuide(store.setDeploymentCuelightMedia(deployment.id, media.id)), media });
    } catch (error) {
      if (error instanceof CuelightError && (error.status === 401 || error.status === 403)) {
        return c.json({ error: `Cuelight refused to create the web media item (${error.message}). The token needs media_write; or add ${url} in Cuelight as a web item with "Cuelight app" access.`, guideUrl: url }, 403);
      }
      throw error;
    }
  });

  // Channels
  app.get("/api/deployments/:id/channels", (c) => c.json({ items: store.listChannels(c.req.param("id")) }));
  app.post("/api/deployments/:id/channels", async (c) => {
    const created = store.createChannel(c.req.param("id"), parseChannelInput(await c.req.json()));
    return c.json(created, 201, { ETag: etag(created.version) });
  });
  app.get("/api/channels/:id", (c) => {
    const channel = store.channel(c.req.param("id"));
    return c.json(channel, 200, { ETag: etag(channel.version) });
  });
  app.patch("/api/channels/:id", async (c) => {
    const updated = store.updateChannel(c.req.param("id"), ifMatch(c), parseChannelInput(await c.req.json()));
    return c.json(updated, 200, { ETag: etag(updated.version) });
  });
  app.delete("/api/channels/:id", (c) => {
    store.deleteChannel(c.req.param("id"), ifMatch(c));
    return c.body(null, 204);
  });

  // Blocks
  app.get("/api/channels/:id/blocks", (c) => c.json({ items: store.listBlocks(c.req.param("id")) }));
  app.post("/api/channels/:id/blocks", async (c) => {
    const created = store.createBlock(c.req.param("id"), parseBlockInput(await c.req.json()));
    return c.json(created, 201, { ETag: etag(created.version) });
  });
  app.get("/api/blocks/:id", (c) => {
    const block = store.block(c.req.param("id"));
    return c.json(block, 200, { ETag: etag(block.version) });
  });
  app.patch("/api/blocks/:id", async (c) => {
    const updated = store.updateBlock(c.req.param("id"), ifMatch(c), parseBlockInput(await c.req.json()));
    return c.json(updated, 200, { ETag: etag(updated.version) });
  });
  app.delete("/api/blocks/:id", (c) => {
    store.deleteBlock(c.req.param("id"), ifMatch(c));
    return c.body(null, 204);
  });

  // Program entries
  app.get("/api/channels/:id/programs", (c) => c.json({ items: store.listPrograms(c.req.param("id")) }));
  app.post("/api/channels/:id/programs", async (c) => {
    const created = store.createProgram(c.req.param("id"), parseProgramInput(await c.req.json()));
    return c.json(created, 201, { ETag: etag(created.version) });
  });
  app.get("/api/programs/:id", (c) => {
    const program = store.program(c.req.param("id"));
    return c.json(program, 200, { ETag: etag(program.version) });
  });
  app.patch("/api/programs/:id", async (c) => {
    const updated = store.updateProgram(c.req.param("id"), ifMatch(c), parseProgramInput(await c.req.json()));
    return c.json(updated, 200, { ETag: etag(updated.version) });
  });
  app.delete("/api/programs/:id", (c) => {
    store.deleteProgram(c.req.param("id"), ifMatch(c));
    return c.body(null, 204);
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (distDir) {
    app.get("/guide", (c) => c.redirect(`/guide/${new URL(c.req.url).search}`));
    app.use("/*", serveStatic({ root: distDir }));
  }
  return app;
}
