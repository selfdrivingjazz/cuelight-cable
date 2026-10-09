import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeGuideDensity, normalizeTheme } from "./domain.ts";
import type { Store } from "./store.ts";

// Imports the control plane's pre-split Cable tables, exported as json_agg
// rows (one JSON array per table). Ids are kept, so playlist and media ids
// keep pointing at the same Cuelight objects. Assets are referenced through
// their file media item (`media.json`, when present maps asset → media id;
// file media created from an asset share its id otherwise).

type ExportRow = Record<string, unknown>;

export interface ImportCounts {
  deployments: number;
  channels: number;
  blocks: number;
  programs: number;
}

function readRows(dir: string, table: string, required: boolean): ExportRow[] {
  const path = join(dir, `${table}.json`);
  if (!existsSync(path)) {
    if (required) throw new Error(`${path} is missing`);
    return [];
  }
  const rows = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (rows === null) return [];
  if (!Array.isArray(rows)) throw new Error(`${path} must hold a JSON array of rows`);
  return rows as ExportRow[];
}

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const ts = (value: unknown): string => new Date(String(value)).toISOString();
const json = (value: unknown): string => JSON.stringify(value && typeof value === "object" ? value : {});
const flag = (value: unknown): number => (value ? 1 : 0);

export function importExport(store: Store, dir: string): ImportCounts {
  const deployments = readRows(dir, "cable_deployments", true);
  const channels = readRows(dir, "cable_channels", true);
  const blocks = readRows(dir, "cable_blocks", false);
  const programs = readRows(dir, "cable_program_entries", false);
  const mediaByAsset = new Map<string, string>();
  for (const media of readRows(dir, "media", false)) {
    if (media.kind === "file" && media.asset_id) mediaByAsset.set(String(media.asset_id), String(media.id));
  }
  const mediaFor = (assetId: unknown) => {
    const id = str(assetId);
    return id === null ? null : mediaByAsset.get(id) ?? id;
  };

  const db = store.db;
  store.transaction(() => {
    const deployment = db.prepare(`INSERT INTO deployments (id, name, timezone, theme, guide_horizon_seconds, guide_density, placard_defaults, fallback_metadata, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, timezone = excluded.timezone, theme = excluded.theme, guide_horizon_seconds = excluded.guide_horizon_seconds,
        guide_density = excluded.guide_density, placard_defaults = excluded.placard_defaults, fallback_metadata = excluded.fallback_metadata,
        version = excluded.version, created_at = excluded.created_at, updated_at = excluded.updated_at`);
    for (const row of deployments) {
      let density: string;
      try {
        density = normalizeGuideDensity(String(row.guide_density ?? ""));
      } catch {
        density = "half-hour";
      }
      deployment.run(String(row.id), String(row.name), String(row.timezone), normalizeTheme(String(row.theme)), Number(row.guide_horizon_seconds ?? 86400), density, json(row.placard_defaults), json(row.fallback_metadata), Number(row.version ?? 1), ts(row.created_at), ts(row.updated_at));
    }

    const channel = db.prepare(`INSERT INTO channels (id, deployment_id, number, name, callsign, description, accent, artwork_media_id, enabled, standby, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET deployment_id = excluded.deployment_id, number = excluded.number, name = excluded.name, callsign = excluded.callsign,
        description = excluded.description, accent = excluded.accent, artwork_media_id = excluded.artwork_media_id, enabled = excluded.enabled,
        standby = excluded.standby, version = excluded.version, created_at = excluded.created_at, updated_at = excluded.updated_at`);
    for (const row of channels) {
      channel.run(String(row.id), String(row.deployment_id), Number(row.number), String(row.name), String(row.callsign ?? ""), String(row.description ?? ""), String(row.accent ?? ""), mediaFor(row.artwork_asset_id), flag(row.enabled), flag(row.standby), Number(row.version ?? 1), ts(row.created_at), ts(row.updated_at));
    }

    const block = db.prepare(`INSERT INTO blocks (id, channel_id, playlist_id, media_id, title, starts_at, ends_at, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET channel_id = excluded.channel_id, playlist_id = excluded.playlist_id, media_id = excluded.media_id, title = excluded.title,
        starts_at = excluded.starts_at, ends_at = excluded.ends_at, version = excluded.version, created_at = excluded.created_at, updated_at = excluded.updated_at`);
    for (const row of blocks) {
      const createdAt = ts(row.created_at);
      block.run(String(row.id), String(row.channel_id), str(row.playlist_id), mediaFor(row.asset_id), String(row.title ?? ""), ts(row.starts_at), ts(row.ends_at), Number(row.version ?? 1), createdAt, row.updated_at ? ts(row.updated_at) : createdAt);
    }

    const program = db.prepare(`INSERT INTO program_entries (id, channel_id, media_id, starts_at, ends_at, title, subtitle, tag, artist, description, artwork_media_id, fit, loop, mute, volume, placard_policy, availability_policy, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET channel_id = excluded.channel_id, media_id = excluded.media_id, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        title = excluded.title, subtitle = excluded.subtitle, tag = excluded.tag, artist = excluded.artist, description = excluded.description,
        artwork_media_id = excluded.artwork_media_id, fit = excluded.fit, loop = excluded.loop, mute = excluded.mute, volume = excluded.volume,
        placard_policy = excluded.placard_policy, availability_policy = excluded.availability_policy, version = excluded.version,
        created_at = excluded.created_at, updated_at = excluded.updated_at`);
    for (const row of programs) {
      program.run(String(row.id), String(row.channel_id), mediaFor(row.asset_id), ts(row.starts_at), ts(row.ends_at), String(row.title ?? ""), String(row.subtitle ?? ""), String(row.tag ?? ""), String(row.artist ?? ""), String(row.description ?? ""), mediaFor(row.artwork_asset_id), String(row.fit ?? ""), flag(row.loop), flag(row.mute), Number(row.volume ?? 1), String(row.placard_policy ?? "default"), String(row.availability_policy ?? "fail"), Number(row.version ?? 1), ts(row.created_at), ts(row.updated_at));
    }
  });
  return { deployments: deployments.length, channels: channels.length, blocks: blocks.length, programs: programs.length };
}
