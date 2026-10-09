import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importExport } from "./importer.ts";
import { Store } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function exportDir(tables: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "cable-export-"));
  dirs.push(dir);
  for (const [table, rows] of Object.entries(tables)) writeFileSync(join(dir, `${table}.json`), JSON.stringify(rows));
  return dir;
}

const deployment = { id: "11111111-1111-4111-8111-111111111111", name: "Lineup", timezone: "America/New_York", theme: "nebula", guide_horizon_seconds: 86400, guide_density: "comfortable", placard_defaults: null, fallback_metadata: {}, version: 2, created_by: "x", updated_by: "x", created_at: "2026-08-28T14:26:33.089193+00:00", updated_at: "2026-08-29T14:36:58.999296+00:00" };
const channel = { id: "22222222-2222-4222-8222-222222222222", deployment_id: deployment.id, number: 7, name: "Signal One", callsign: "SIG1", description: "", accent: "#5eead4", artwork_asset_id: null, enabled: true, standby: false, version: 1, created_at: "2026-08-28T14:26:48.43611+00:00", updated_at: "2026-08-28T14:26:48.43611+00:00" };
const blocks = [
  { id: "33333333-3333-4333-8333-333333333333", channel_id: channel.id, playlist_id: "pl-1", asset_id: null, title: "Rotation", starts_at: "2026-08-28T13:00:00+00:00", ends_at: "2026-08-28T14:00:00+00:00", version: 1, created_by: "x", created_at: "2026-08-28T14:26:48.476066+00:00" },
  { id: "44444444-4444-4444-8444-444444444444", channel_id: channel.id, playlist_id: null, asset_id: "asset-1", title: "Direct", starts_at: "2026-08-28T14:00:00+00:00", ends_at: "2026-08-28T15:00:00+00:00", version: 1, created_by: "x", created_at: "2026-08-28T14:26:48.476066+00:00" },
];
const program = { id: "55555555-5555-4555-8555-555555555555", channel_id: channel.id, asset_id: "asset-2", starts_at: "2026-08-28T12:37:00+00:00", ends_at: "2026-08-29T13:37:00+00:00", title: "Smoke", subtitle: "", tag: "", artist: "", description: "", artwork_asset_id: null, fit: "", loop: false, mute: false, volume: 1, placard_policy: "default", availability_policy: "fail", version: 1, created_at: "2026-08-28T13:37:00.813045+00:00", updated_at: "2026-08-28T13:37:00.813045+00:00" };

describe("importExport", () => {
  it("keeps ids, maps assets to their file media, and is idempotent", () => {
    const dir = exportDir({
      cable_deployments: [deployment],
      cable_channels: [channel],
      cable_blocks: blocks,
      cable_program_entries: [program],
      media: [{ id: "media-1", kind: "file", asset_id: "asset-1" }, { id: "web-1", kind: "web", asset_id: null }],
    });
    const store = new Store(":memory:");
    expect(importExport(store, dir)).toEqual({ deployments: 1, channels: 1, blocks: 2, programs: 1 });
    expect(importExport(store, dir)).toEqual({ deployments: 1, channels: 1, blocks: 2, programs: 1 });

    expect(store.listDeployments()).toEqual([expect.objectContaining({ id: deployment.id, version: 2, guideDensity: "half-hour", placardDefaults: {}, createdAt: "2026-08-28T14:26:33.089Z" })]);
    expect(store.listChannels(deployment.id).map((item) => [item.id, item.number, item.callsign])).toEqual([[channel.id, 7, "SIG1"]]);
    expect(store.listBlocks(channel.id).map((item) => [item.id, item.playlistId, item.mediaId, item.startsAt])).toEqual([
      [blocks[0]!.id, "pl-1", undefined, "2026-08-28T13:00:00.000Z"],
      [blocks[1]!.id, undefined, "media-1", "2026-08-28T14:00:00.000Z"],
    ]);
    // Without a media row the asset id is kept: file media created from an asset share its id.
    expect(store.listPrograms(channel.id).map((item) => item.mediaId)).toEqual(["asset-2"]);
  });

  it("requires the deployments and channels tables", () => {
    expect(() => importExport(new Store(":memory:"), exportDir({ cable_deployments: [] }))).toThrow(/cable_channels\.json is missing/);
  });
});
