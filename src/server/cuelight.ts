import { readFileSync } from "node:fs";
import createClient from "openapi-fetch";
import { Agent, type Dispatcher } from "undici";
import type { components, paths } from "../cuelight-api.d.ts";

export type CuelightMedia = components["schemas"]["Media"];
export type CuelightMediaPage = components["schemas"]["MediaPage"];
export type CuelightPlaylist = components["schemas"]["Playlist"];
export type CuelightPlaylistPage = components["schemas"]["PlaylistPage"];

export interface CuelightConfig {
  /** Cuelight origin, e.g. https://cuelight.example:8454 */
  url: string;
  /** Operator token with media_read (and media_write to create the guide's web media item). */
  token: string;
  /** Extra CA certificates (PEM) trusted for the Cuelight origin. */
  caFile?: string;
}

/** Cuelight answered with an error; `status` is its HTTP status (502 when unreachable). */
export class CuelightError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CuelightError";
    this.status = status;
  }
}

/** The Cuelight reads the presentation builder needs; `undefined` means the id does not exist. */
export interface CuelightCatalog {
  media(id: string): Promise<CuelightMedia | undefined>;
  playlist(id: string): Promise<CuelightPlaylist | undefined>;
}

function problemMessage(error: unknown, status: number): string {
  if (error && typeof error === "object") {
    const problem = error as { detail?: unknown; title?: unknown };
    if (typeof problem.detail === "string" && problem.detail) return problem.detail;
    if (typeof problem.title === "string" && problem.title) return problem.title;
  }
  return `Cuelight returned HTTP ${status}`;
}

/** Unwraps an openapi-fetch result; 404 becomes undefined when `allowMissing`. */
function unwrap<T>(result: { data?: T; error?: unknown; response: Response }, allowMissing: true): T | undefined;
function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T;
function unwrap<T>(result: { data?: T; error?: unknown; response: Response }, allowMissing = false): T | undefined {
  if (result.response.ok && result.data !== undefined) return result.data;
  if (allowMissing && result.response.status === 404) return undefined;
  throw new CuelightError(result.response.status, problemMessage(result.error, result.response.status));
}

export class CuelightClient implements CuelightCatalog {
  readonly apiBase: string;
  private readonly token: string;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly api;

  constructor(config: CuelightConfig) {
    this.apiBase = `${config.url.replace(/\/+$/, "")}/api/v1`;
    this.token = config.token;
    this.dispatcher = config.caFile ? new Agent({ connect: { ca: readFileSync(config.caFile, "utf8") } }) : undefined;
    this.api = createClient<paths>({
      baseUrl: this.apiBase,
      headers: { Authorization: `Bearer ${config.token}` },
      requestInitExt: this.dispatcher ? { dispatcher: this.dispatcher } : undefined,
      fetch: (request) => this.send(request),
    });
  }

  private async send(request: Request): Promise<Response> {
    try {
      return await fetch(request, this.dispatcher ? { dispatcher: this.dispatcher } : undefined);
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
      throw new CuelightError(502, `Cuelight at ${this.apiBase} is unreachable${cause}`);
    }
  }

  async scopes(): Promise<string[]> {
    return unwrap(await this.api.GET("/operator/me")).scopes;
  }

  async media(id: string): Promise<CuelightMedia | undefined> {
    return unwrap(await this.api.GET("/media/{mediaId}", { params: { path: { mediaId: id } } }), true);
  }

  async listMedia(query: { cursor?: string; search?: string; kind?: "file" | "web"; limit?: number }): Promise<CuelightMediaPage> {
    return unwrap(await this.api.GET("/media", { params: { query: { cursor: query.cursor || undefined, search: query.search || undefined, kind: query.kind, limit: query.limit ?? 50 } } }));
  }

  async playlist(id: string): Promise<CuelightPlaylist | undefined> {
    return unwrap(await this.api.GET("/playlists/{playlistId}", { params: { path: { playlistId: id } } }), true);
  }

  async listPlaylists(query: { cursor?: string; limit?: number }): Promise<CuelightPlaylistPage> {
    return unwrap(await this.api.GET("/playlists", { params: { query: { cursor: query.cursor || undefined, limit: query.limit ?? 100 } } }));
  }

  /**
   * Creates (or finds, when the URL is already in the library) the web media
   * item for a guide URL and makes sure it has Cuelight app access.
   */
  async ensureAppWebMedia(url: string, title: string): Promise<CuelightMedia> {
    const created = await this.api.POST("/media", { body: { kind: "web", url, title, appAccess: true } });
    const media = unwrap(created);
    if (media.appAccess) return media;
    const etag = created.response.headers.get("ETag") ?? `"v${media.version}"`;
    return unwrap(await this.api.PATCH("/media/{mediaId}", {
      params: { path: { mediaId: media.id }, header: { "If-Match": etag, "Idempotency-Key": crypto.randomUUID() } },
      body: { appAccess: true },
    }));
  }

  /** Streams a media thumbnail; the response is passed through as-is. */
  async thumbnail(id: string, version?: string): Promise<Response> {
    const url = new URL(`${this.apiBase}/media/${encodeURIComponent(id)}/thumbnail`);
    if (version) url.searchParams.set("v", version);
    return this.send(new Request(url, { headers: { Authorization: `Bearer ${this.token}` } }));
  }
}

interface Entry<T> {
  expiresAt: number;
  value: Promise<T>;
}

/**
 * Briefly caches media and playlist reads so every guide refresh does not
 * fan out to Cuelight. Failures are not cached.
 */
export class CachedCatalog implements CuelightCatalog {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly source: CuelightCatalog;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(source: CuelightCatalog, ttlMs = 30_000, now: () => number = Date.now) {
    this.source = source;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { expiresAt: now + this.ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    if (this.entries.size > 2_000) {
      for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(entryKey);
    }
    return value;
  }

  media(id: string) {
    return this.cached(`media:${id}`, () => this.source.media(id));
  }

  playlist(id: string) {
    return this.cached(`playlist:${id}`, () => this.source.playlist(id));
  }
}
