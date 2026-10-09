import { describe, expect, it } from "vitest";
import type { CuelightCatalog, CuelightMedia, CuelightPlaylist } from "./cuelight.ts";
import { buildPresentation } from "./presentation.ts";
import { Store } from "./store.ts";

const minute = 60_000;

function fileMedia(id: string, mediaType: string, state = "ready"): CuelightMedia {
  return { id, kind: "file", title: id, tags: [], appAccess: false, assetId: id, artifact: { digest: "0".repeat(64), size: 1, mediaType, state: state as "ready" }, version: 1, createdBy: "a", updatedBy: "a", createdAt: "", updatedAt: "" };
}

function catalog(media: CuelightMedia[], playlists: CuelightPlaylist[]): CuelightCatalog {
  return {
    async media(id) {
      return media.find((item) => item.id === id);
    },
    async playlist(id) {
      return playlists.find((item) => item.id === id);
    },
  };
}

describe("buildPresentation", () => {
  it("reflects live authored state with playable Cuelight media only", async () => {
    const now = new Date("2026-10-04T12:10:00Z");
    const store = new Store(":memory:");
    const deployment = store.createDeployment({ name: "Dep", timezone: "America/New_York", theme: "gallery", guideDensity: "hour", guideHorizonSeconds: 3 * 3600, placardDefaults: {}, fallbackMetadata: {} });
    const two = store.createChannel(deployment.id, { number: 2, name: "Two", callsign: "", description: "", accent: "", enabled: true, standby: false });
    const one = store.createChannel(deployment.id, { number: 1, name: "One", callsign: "ONE", description: "", accent: "", enabled: true, standby: true });
    const at = (offsetMinutes: number) => new Date(now.getTime() + offsetMinutes * minute).toISOString();
    store.createBlock(one.id, { mediaId: "clip", title: "Long gone", startsAt: at(-300), endsAt: at(-240) });
    const loop = store.createBlock(one.id, { playlistId: "pl", title: "Loop", startsAt: at(-10), endsAt: at(20) });
    store.createBlock(two.id, { playlistId: "missing-playlist", title: "Gone", startsAt: at(-10), endsAt: at(20) });
    const source = catalog(
      [fileMedia("clip", "video/mp4"), fileMedia("still", "image/png"), fileMedia("song", "audio/mpeg"), fileMedia("broken", "video/mp4", "missing")],
      [{ id: "pl", name: "pl", description: "", version: 1, createdBy: "a", createdAt: "", updatedAt: "", items: [
        { id: "b", playlistId: "pl", mediaId: "still", assetId: "still", position: 2, durationSeconds: 600, title: "Still", subtitle: "" },
        { id: "a", playlistId: "pl", mediaId: "clip", assetId: "clip", position: 1, durationSeconds: 600, title: "Clip", subtitle: "Sub" },
        { id: "web", playlistId: "pl", mediaId: "page", position: 3, durationSeconds: 600, title: "Web", subtitle: "" },
        { id: "audio", playlistId: "pl", mediaId: "song", assetId: "song", position: 4, durationSeconds: 600, title: "Song", subtitle: "" },
      ] }],
    );

    const first = await buildPresentation(store, source, deployment.id, now);
    expect([first.theme, first.revision.timezone, first.revision.guideDensity, first.bridge.state]).toEqual(["gallery", "America/New_York", "hour", "online"]);
    expect(first.channels.map((channel) => [channel.id, channel.standbyMessage])).toEqual([[one.id, "Standby"], [two.id, undefined]]);
    // Blocks outside the window are dropped; a block whose playlist vanished stays on the grid with nothing to play.
    expect(first.blocks.map((block) => [block.title, block.source])).toEqual([["Loop", "playlist"], ["Gone", "playlist"]]);
    // The 30-minute block plays clip then still then (unplayable) audio; the web item does not rotate.
    expect(first.occurrences).toHaveLength(2);
    const [clip, still] = first.occurrences;
    expect(clip).toMatchObject({ id: `${loop.id}:1`, blockId: loop.id, itemId: "a", itemPosition: 1, title: "Clip", subtitle: "Sub", media: { kind: "video", mediaId: "clip", mime: "video/mp4" }, startsAt: at(-10), endsAt: at(0) });
    expect(still).toMatchObject({ itemId: "b", media: { kind: "image", mediaId: "still", mime: "image/png" }, startsAt: at(0), endsAt: at(10) });
    expect(still).not.toHaveProperty("subtitle");

    // Authored edits show up on the next build with a new revision digest.
    store.updateChannel(two.id, two.version, { number: 2, name: "Renamed", callsign: "", description: "", accent: "", enabled: true, standby: false });
    const second = await buildPresentation(store, source, deployment.id, now);
    expect(second.channels[1]?.name).toBe("Renamed");
    expect(second.revision.digest).not.toBe(first.revision.digest);
    const third = await buildPresentation(store, source, deployment.id, new Date(now.getTime() + 1000));
    expect(third.revision.digest).toBe(second.revision.digest);
  });

  it("plays a media block for its whole window and skips media the guide cannot play", async () => {
    const now = new Date("2026-10-04T12:00:00Z");
    const store = new Store(":memory:");
    const deployment = store.createDeployment({ name: "Dep", timezone: "UTC", theme: "noir", guideDensity: "half-hour", guideHorizonSeconds: 86400, placardDefaults: {}, fallbackMetadata: {} });
    const channel = store.createChannel(deployment.id, { number: 3, name: "Three", callsign: "", description: "", accent: "", enabled: true, standby: false });
    const block = store.createBlock(channel.id, { mediaId: "clip", title: "Feature", startsAt: "2026-10-04T11:30:00Z", endsAt: "2026-10-04T13:00:00Z" });
    store.createBlock(channel.id, { mediaId: "broken", title: "Broken", startsAt: "2026-10-04T13:00:00Z", endsAt: "2026-10-04T14:00:00Z" });
    const source = catalog([fileMedia("clip", "video/mp4"), fileMedia("broken", "video/mp4", "quarantined")], []);
    const presentation = await buildPresentation(store, source, deployment.id, now);
    expect(presentation.occurrences).toEqual([expect.objectContaining({ id: block.id, blockId: block.id, title: "Feature", startsAt: "2026-10-04T11:30:00.000Z", endsAt: "2026-10-04T13:00:00.000Z", media: { kind: "video", mediaId: "clip", mime: "video/mp4" } })]);
    expect(presentation.blocks.map((item) => item.source)).toEqual(["media", "media"]);
  });
});
