import type { components } from "../cuelight-api.d.ts";
import type { Block, Channel, Deployment, ProgramEntry } from "../server/domain.ts";

export type { Block, Channel, ProgramEntry };
export type DeploymentView = Deployment & { guideUrl: string };
export type CuelightMedia = components["schemas"]["Media"];
export type CuelightPlaylist = components["schemas"]["Playlist"];
export interface CuelightStatus { reachable: boolean; scopes: string[]; canWriteMedia: boolean; error?: string }

export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Calls the Cable server API; versioned resources send their ETag as If-Match. */
export async function api<T>(method: string, path: string, body?: unknown, version?: number): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (version !== undefined) headers["If-Match"] = `"v${version}"`;
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as unknown : undefined;
  if (!response.ok) throw new ApiError(response.status, (parsed ?? {}) as Record<string, unknown>);
  return parsed as T;
}

export const thumbnailUrl = (mediaId: string) => `/api/media/${encodeURIComponent(mediaId)}/thumbnail`;
