import { createHash } from "node:crypto";
import type { CuelightCatalog } from "./cuelight.ts";
import { normalizeGuideDensity, normalizeTheme, normalizeTimezone, type Block, type GuideDensity, type Theme } from "./domain.ts";
import type { Store } from "./store.ts";

/** Guide protocol version reported to the guide. */
export const guideBridgeProtocol = "2";

/** Keeps the programme currently on air (and its predecessor) in the window. */
const guideLookbackMs = 60 * 60_000;

export interface PresentationChannel {
  id: string;
  number: number;
  name: string;
  callsign: string;
  accent: string;
  enabled: boolean;
  standbyMessage?: string;
}

export interface PresentationBlock {
  id: string;
  channelId: string;
  startsAt: string;
  endsAt: string;
  title: string;
  source: "playlist" | "media";
}

/**
 * Playable Cuelight media. The guide fetches files from
 * `{api}/app/media/{mediaId}/content` and frames web pages at `url`.
 */
export type PresentationMedia =
  | { kind: "video"; mediaId: string; mime: "video/mp4" }
  | { kind: "image"; mediaId: string; mime: "image/jpeg" | "image/png" | "image/webp" }
  | { kind: "web"; mediaId: string; url: string };

export interface PresentationProgram {
  id: string;
  blockId: string;
  itemId?: string;
  itemPosition?: number;
  occurrence?: number;
  channelId: string;
  startsAt: string;
  endsAt: string;
  title: string;
  subtitle?: string;
  media: PresentationMedia;
  placard: "always" | "start" | "never";
  fit: "fit" | "fill";
  loop: boolean;
  muted: boolean;
  volume: number;
}

/** The document the guide parses (presentationSchema in src/guide/presentation.ts). */
export interface Presentation {
  revision: { id: string; digest: string; generatedAt: string; timezone: string; stale: boolean; guideDensity: GuideDensity };
  channels: PresentationChannel[];
  blocks: PresentationBlock[];
  occurrences: PresentationProgram[];
  bridge: { protocolVersion: string; state: "online" };
  theme: Theme;
}

function orElse<T>(normalize: () => T, fallback: T): T {
  try {
    return normalize();
  } catch {
    return fallback;
  }
}

/** Maps a Cuelight media item to a guide-playable descriptor; undefined when the guide cannot play it. */
export function playableMedia(media: { id: string; kind: string; url?: string; artifact?: { mediaType: string; state?: string } }): PresentationMedia | undefined {
  if (media.kind === "web") return media.url && /^https?:\/\//i.test(media.url) ? { kind: "web", mediaId: media.id, url: media.url } : undefined;
  if (media.kind !== "file" || !media.artifact) return undefined;
  if (media.artifact.state !== undefined && media.artifact.state !== "ready") return undefined;
  const mime = media.artifact.mediaType.trim().toLowerCase();
  if (mime === "video/mp4") return { kind: "video", mediaId: media.id, mime };
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") return { kind: "image", mediaId: media.id, mime };
  return undefined;
}

/**
 * Computes the live guide document for a deployment over now-1h through the
 * guide horizon. Programmes whose media is missing or not playable by the
 * guide are omitted rather than failing the whole guide.
 */
export async function buildPresentation(store: Store, catalog: CuelightCatalog, deploymentId: string, now = new Date()): Promise<Presentation> {
  const deployment = store.deployment(deploymentId);
  const theme = orElse(() => normalizeTheme(deployment.theme), "nebula");
  const timezone = orElse(() => normalizeTimezone(deployment.timezone), "UTC");
  const guideDensity = orElse(() => normalizeGuideDensity(deployment.guideDensity), "half-hour");
  const horizonMs = deployment.guideHorizonSeconds > 0 ? deployment.guideHorizonSeconds * 1000 : 24 * 60 * 60_000;
  const windowStart = now.getTime() - guideLookbackMs;
  const windowEnd = now.getTime() + horizonMs;
  const mediaCache = new Map<string, Promise<PresentationMedia | undefined>>();
  const resolveMedia = (mediaId: string) => {
    let resolved = mediaCache.get(mediaId);
    if (!resolved) {
      resolved = catalog.media(mediaId).then((media) => (media ? playableMedia(media) : undefined));
      mediaCache.set(mediaId, resolved);
    }
    return resolved;
  };

  const channels: PresentationChannel[] = [];
  const blocks: PresentationBlock[] = [];
  const occurrences: PresentationProgram[] = [];
  for (const channel of store.listChannels(deploymentId)) {
    channels.push({ id: channel.id, number: channel.number, name: channel.name, callsign: channel.callsign, accent: channel.accent, enabled: channel.enabled, ...(channel.standby ? { standbyMessage: "Standby" } : {}) });
    for (const block of store.listBlocks(channel.id)) {
      const startsAt = Date.parse(block.startsAt);
      const endsAt = Date.parse(block.endsAt);
      if (endsAt <= windowStart || startsAt >= windowEnd || endsAt <= startsAt) continue;
      occurrences.push(...await blockPrograms(catalog, resolveMedia, block, startsAt, endsAt, windowStart, windowEnd));
      blocks.push({ id: block.id, channelId: channel.id, startsAt: block.startsAt, endsAt: block.endsAt, title: block.title, source: block.mediaId ? "media" : "playlist" });
    }
  }

  // The revision digest identifies the authored content, not the request
  // time, so the guide can tell when the schedule actually changed.
  const content = JSON.stringify({ deploymentId: deployment.id, version: deployment.version, theme, timezone, guideDensity, channels, blocks, occurrences });
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    revision: { id: digest, digest: `sha256:${digest}`, generatedAt: now.toISOString(), timezone, stale: false, guideDensity },
    channels,
    blocks,
    occurrences,
    bridge: { protocolVersion: guideBridgeProtocol, state: "online" },
    theme,
  };
}

async function blockPrograms(catalog: CuelightCatalog, resolveMedia: (mediaId: string) => Promise<PresentationMedia | undefined>, block: Block, blockStart: number, blockEnd: number, windowStart: number, windowEnd: number): Promise<PresentationProgram[]> {
  const program = (media: PresentationMedia, fields: Pick<PresentationProgram, "id" | "title"> & Partial<PresentationProgram>, startsAt: number, endsAt: number): PresentationProgram => ({
    blockId: block.id,
    channelId: block.channelId,
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    media,
    placard: "start",
    fit: "fill",
    loop: true,
    muted: false,
    volume: 100,
    ...fields,
  });

  if (block.mediaId) {
    const media = await resolveMedia(block.mediaId);
    return media ? [program(media, { id: block.id, title: block.title }, blockStart, blockEnd)] : [];
  }
  if (!block.playlistId) return [];
  const playlist = await catalog.playlist(block.playlistId);
  if (!playlist) return [];
  // Items rotate in position order, each for its Cuelight duration (file or
  // web alike); an item the guide cannot play keeps its slot but is omitted.
  const items = playlist.items
    .filter((item) => item.mediaId && item.durationSeconds > 0)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  if (items.length === 0) return [];

  const out: PresentationProgram[] = [];
  let cursor = blockStart;
  let occurrence = 1;
  // Long blocks (months) skip whole rotations that ended before the window.
  const cycleMs = items.reduce((total, item) => total + item.durationSeconds * 1000, 0);
  const skippedCycles = Math.max(0, Math.floor((windowStart - blockStart) / cycleMs));
  cursor += skippedCycles * cycleMs;
  occurrence += skippedCycles * items.length;
  for (; cursor < blockEnd && cursor < windowEnd; occurrence++) {
    const item = items[(occurrence - 1) % items.length]!;
    const itemEnd = Math.min(cursor + item.durationSeconds * 1000, blockEnd);
    if (itemEnd > windowStart) {
      const media = await resolveMedia(item.mediaId!);
      if (media) {
        out.push(program(media, { id: `${block.id}:${occurrence}`, itemId: item.id, itemPosition: item.position, occurrence, title: item.title, ...(item.subtitle ? { subtitle: item.subtitle } : {}) }, cursor, itemEnd));
      }
    }
    cursor = itemEnd;
  }
  return out;
}
