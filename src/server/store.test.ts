import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, OverlapError, ValidationError, parseBlockInput, parseDeploymentInput } from "./domain.ts";
import { Store } from "./store.ts";

function seeded() {
  const store = new Store(":memory:");
  const deployment = store.createDeployment(parseDeploymentInput({ name: "Dep", timezone: "UTC" }));
  const channel = store.createChannel(deployment.id, { number: 7, name: "Seven", callsign: "", description: "", accent: "", enabled: true, standby: false });
  return { store, deployment, channel };
}

describe("Store", () => {
  it("rejects overlapping blocks on a channel but allows back-to-back and other channels", () => {
    const { store, deployment, channel } = seeded();
    const first = store.createBlock(channel.id, { mediaId: "m", title: "A", startsAt: "2026-10-08T10:00:00.000Z", endsAt: "2026-10-08T11:00:00.000Z" });
    expect(() => store.createBlock(channel.id, { mediaId: "m", title: "B", startsAt: "2026-10-08T10:30:00.000Z", endsAt: "2026-10-08T11:30:00.000Z" })).toThrow(OverlapError);
    store.createBlock(channel.id, { mediaId: "m", title: "C", startsAt: "2026-10-08T11:00:00.000Z", endsAt: "2026-10-08T12:00:00.000Z" });
    const other = store.createChannel(deployment.id, { number: 8, name: "Eight", callsign: "", description: "", accent: "", enabled: true, standby: false });
    store.createBlock(other.id, { playlistId: "p", title: "D", startsAt: "2026-10-08T10:30:00.000Z", endsAt: "2026-10-08T11:30:00.000Z" });
    // A block may move within its own slot without clashing with itself.
    const moved = store.updateBlock(first.id, first.version, { mediaId: "m", title: "A", startsAt: "2026-10-08T09:30:00.000Z", endsAt: "2026-10-08T10:30:00.000Z" });
    expect([moved.version, moved.startsAt]).toEqual([2, "2026-10-08T09:30:00.000Z"]);
    expect(store.listBlocks(channel.id).map((block) => block.title)).toEqual(["A", "C"]);
  });

  it("guards updates and deletes with the expected version", () => {
    const { store, deployment } = seeded();
    const input = parseDeploymentInput({ name: "Renamed", timezone: "Europe/London", theme: "noir" });
    const updated = store.updateDeployment(deployment.id, deployment.version, input);
    expect([updated.name, updated.version]).toEqual(["Renamed", 2]);
    expect(() => store.updateDeployment(deployment.id, deployment.version, input)).toThrow(ConflictError);
    expect(() => store.deleteDeployment(deployment.id, 1)).toThrow(ConflictError);
    expect(() => store.deleteDeployment("missing", 1)).toThrow(NotFoundError);
  });

  it("keeps channel numbers unique per deployment and cascades deletes", () => {
    const { store, deployment, channel } = seeded();
    expect(() => store.createChannel(deployment.id, { number: 7, name: "Dup", callsign: "", description: "", accent: "", enabled: true, standby: false })).toThrow(ConflictError);
    store.createBlock(channel.id, { mediaId: "m", title: "A", startsAt: "2026-10-08T10:00:00.000Z", endsAt: "2026-10-08T11:00:00.000Z" });
    store.deleteDeployment(deployment.id, deployment.version);
    expect(() => store.channel(channel.id)).toThrow(NotFoundError);
    expect(store.db.prepare("SELECT count(*) AS n FROM blocks").get()).toEqual({ n: 0 });
  });
});

describe("input validation", () => {
  it("requires exactly one block source and a positive window", () => {
    expect(() => parseBlockInput({ playlistId: "p", mediaId: "m", startsAt: "2026-10-08T10:00:00Z", endsAt: "2026-10-08T11:00:00Z" })).toThrow(ValidationError);
    expect(() => parseBlockInput({ startsAt: "2026-10-08T10:00:00Z", endsAt: "2026-10-08T11:00:00Z" })).toThrow(/exactly one/);
    expect(() => parseBlockInput({ mediaId: "m", startsAt: "2026-10-08T11:00:00Z", endsAt: "2026-10-08T11:00:00Z" })).toThrow(/after/);
    expect(parseBlockInput({ mediaId: "m", startsAt: "2026-10-08T12:00:00+02:00", endsAt: "2026-10-08T11:00:00Z" })).toMatchObject({ startsAt: "2026-10-08T10:00:00.000Z", playlistId: undefined });
  });

  it("normalizes deployment settings", () => {
    expect(parseDeploymentInput({ name: " Dep ", timezone: "utc", theme: "Gallery" })).toMatchObject({ name: "Dep", timezone: "UTC", theme: "gallery", guideDensity: "half-hour", guideHorizonSeconds: 86400 });
    expect(() => parseDeploymentInput({ name: "Dep", timezone: "Nowhere/Invalid" })).toThrow(/IANA/);
    expect(() => parseDeploymentInput({ name: "Dep", timezone: "UTC", guideHorizonSeconds: 60 })).toThrow(/between one hour/);
  });
});
