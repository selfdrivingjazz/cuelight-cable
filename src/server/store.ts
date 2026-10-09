import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  ConflictError,
  NotFoundError,
  OverlapError,
  type Block,
  type BlockInput,
  type Channel,
  type ChannelInput,
  type Deployment,
  type DeploymentInput,
  type GuideDensity,
  type ProgramEntry,
  type ProgramInput,
  type Theme,
  type AvailabilityPolicy,
  type PlacardPolicy,
} from "./domain.ts";

// Ported from the control plane's cable migrations (0003 deployments/channels/
// program entries, 0004 blocks, 0005 media blocks + no-overlap rule). Shell
// builds, revisions, profiles and guide tokens are gone: the guide is served
// live and authenticates against Cuelight with an app token. Overlap is
// enforced in the store because SQLite has no exclusion constraints.
const migrations = [
  `CREATE TABLE deployments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    theme TEXT NOT NULL CHECK (theme IN ('nebula','gallery','noir')),
    guide_horizon_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (guide_horizon_seconds > 0),
    guide_density TEXT NOT NULL DEFAULT 'half-hour',
    placard_defaults TEXT NOT NULL DEFAULT '{}',
    fallback_metadata TEXT NOT NULL DEFAULT '{}',
    cuelight_media_id TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    number INTEGER NOT NULL CHECK (number > 0),
    name TEXT NOT NULL,
    callsign TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    accent TEXT NOT NULL DEFAULT '',
    artwork_media_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    standby INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (deployment_id, number)
  );
  CREATE TABLE blocks (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    playlist_id TEXT,
    media_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((playlist_id IS NULL) <> (media_id IS NULL)),
    CHECK (ends_at > starts_at)
  );
  CREATE INDEX blocks_channel_time_idx ON blocks (channel_id, starts_at, id);
  CREATE TABLE program_entries (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    subtitle TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    artwork_media_id TEXT,
    fit TEXT NOT NULL DEFAULT '',
    loop INTEGER NOT NULL DEFAULT 0,
    mute INTEGER NOT NULL DEFAULT 0,
    volume REAL NOT NULL DEFAULT 1 CHECK (volume >= 0 AND volume <= 1),
    placard_policy TEXT NOT NULL DEFAULT 'default',
    availability_policy TEXT NOT NULL DEFAULT 'fail',
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (ends_at > starts_at)
  );
  CREATE INDEX program_entries_channel_time_idx ON program_entries (channel_id, starts_at, id);`,
];

type Row = Record<string, SQLInputValue>;

const nullable = (value: SQLInputValue | undefined): string | undefined => (value === null || value === undefined ? undefined : String(value));

function deploymentRow(row: Row): Deployment {
  return {
    id: String(row.id),
    name: String(row.name),
    timezone: String(row.timezone),
    theme: String(row.theme) as Theme,
    guideHorizonSeconds: Number(row.guide_horizon_seconds),
    guideDensity: String(row.guide_density) as GuideDensity,
    placardDefaults: JSON.parse(String(row.placard_defaults)) as Record<string, string>,
    fallbackMetadata: JSON.parse(String(row.fallback_metadata)) as Record<string, string>,
    cuelightMediaId: nullable(row.cuelight_media_id),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function channelRow(row: Row): Channel {
  return {
    id: String(row.id),
    deploymentId: String(row.deployment_id),
    number: Number(row.number),
    name: String(row.name),
    callsign: String(row.callsign),
    description: String(row.description),
    accent: String(row.accent),
    artworkMediaId: nullable(row.artwork_media_id),
    enabled: Boolean(row.enabled),
    standby: Boolean(row.standby),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function blockRow(row: Row): Block {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    playlistId: nullable(row.playlist_id),
    mediaId: nullable(row.media_id),
    title: String(row.title),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function programRow(row: Row): ProgramEntry {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    mediaId: String(row.media_id),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    title: String(row.title),
    subtitle: String(row.subtitle),
    tag: String(row.tag),
    artist: String(row.artist),
    description: String(row.description),
    artworkMediaId: nullable(row.artwork_media_id),
    placardPolicy: String(row.placard_policy) as PlacardPolicy,
    fit: String(row.fit),
    availabilityPolicy: String(row.availability_policy) as AvailabilityPolicy,
    loop: Boolean(row.loop),
    mute: Boolean(row.mute),
    volume: Number(row.volume),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

export class Store {
  readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let index = current; index < migrations.length; index++) {
      this.transaction(() => {
        this.db.exec(migrations[index]!);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /** Runs a versioned UPDATE/DELETE and maps "no row" to not-found or a stale version. */
  private versioned(table: string, id: string, expectedVersion: number, run: () => { changes: number | bigint }) {
    const result = run();
    if (Number(result.changes) === 1) return;
    const exists = this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
    if (!exists) throw new NotFoundError();
    throw new ConflictError(`version ${expectedVersion} is stale`);
  }

  // Deployments

  listDeployments(): Deployment[] {
    return (this.db.prepare("SELECT * FROM deployments ORDER BY name, id").all() as Row[]).map(deploymentRow);
  }

  deployment(id: string): Deployment {
    const row = this.db.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("deployment");
    return deploymentRow(row);
  }

  createDeployment(input: DeploymentInput): Deployment {
    const id = randomUUID();
    const at = this.stamp();
    this.db.prepare(`INSERT INTO deployments (id, name, timezone, theme, guide_horizon_seconds, guide_density, placard_defaults, fallback_metadata, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, input.name, input.timezone, input.theme, input.guideHorizonSeconds, input.guideDensity, JSON.stringify(input.placardDefaults), JSON.stringify(input.fallbackMetadata), at, at);
    return this.deployment(id);
  }

  updateDeployment(id: string, expectedVersion: number, input: DeploymentInput): Deployment {
    this.versioned("deployments", id, expectedVersion, () => this.db.prepare(`UPDATE deployments SET name = ?, timezone = ?, theme = ?, guide_horizon_seconds = ?, guide_density = ?, placard_defaults = ?, fallback_metadata = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?`).run(input.name, input.timezone, input.theme, input.guideHorizonSeconds, input.guideDensity, JSON.stringify(input.placardDefaults), JSON.stringify(input.fallbackMetadata), this.stamp(), id, expectedVersion));
    return this.deployment(id);
  }

  /** Records the Cuelight web media item that shows this deployment's guide. */
  setDeploymentCuelightMedia(id: string, mediaId: string): Deployment {
    const result = this.db.prepare("UPDATE deployments SET cuelight_media_id = ? WHERE id = ?").run(mediaId, id);
    if (Number(result.changes) !== 1) throw new NotFoundError("deployment");
    return this.deployment(id);
  }

  deleteDeployment(id: string, expectedVersion: number) {
    this.versioned("deployments", id, expectedVersion, () => this.db.prepare("DELETE FROM deployments WHERE id = ? AND version = ?").run(id, expectedVersion));
  }

  // Channels

  listChannels(deploymentId: string): Channel[] {
    this.deployment(deploymentId);
    return (this.db.prepare("SELECT * FROM channels WHERE deployment_id = ? ORDER BY number, id").all(deploymentId) as Row[]).map(channelRow);
  }

  channel(id: string): Channel {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("channel");
    return channelRow(row);
  }

  createChannel(deploymentId: string, input: ChannelInput): Channel {
    this.deployment(deploymentId);
    const id = randomUUID();
    const at = this.stamp();
    try {
      this.db.prepare(`INSERT INTO channels (id, deployment_id, number, name, callsign, description, accent, artwork_media_id, enabled, standby, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, deploymentId, input.number, input.name, input.callsign, input.description, input.accent, input.artworkMediaId ?? null, input.enabled ? 1 : 0, input.standby ? 1 : 0, at, at);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(`channel ${input.number} already exists`);
      throw error;
    }
    return this.channel(id);
  }

  updateChannel(id: string, expectedVersion: number, input: ChannelInput): Channel {
    try {
      this.versioned("channels", id, expectedVersion, () => this.db.prepare(`UPDATE channels SET number = ?, name = ?, callsign = ?, description = ?, accent = ?, artwork_media_id = ?, enabled = ?, standby = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`).run(input.number, input.name, input.callsign, input.description, input.accent, input.artworkMediaId ?? null, input.enabled ? 1 : 0, input.standby ? 1 : 0, this.stamp(), id, expectedVersion));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(`channel ${input.number} already exists`);
      throw error;
    }
    return this.channel(id);
  }

  deleteChannel(id: string, expectedVersion: number) {
    this.versioned("channels", id, expectedVersion, () => this.db.prepare("DELETE FROM channels WHERE id = ? AND version = ?").run(id, expectedVersion));
  }

  // Blocks

  listBlocks(channelId: string): Block[] {
    this.channel(channelId);
    return (this.db.prepare("SELECT * FROM blocks WHERE channel_id = ? ORDER BY starts_at, id").all(channelId) as Row[]).map(blockRow);
  }

  block(id: string): Block {
    const row = this.db.prepare("SELECT * FROM blocks WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("block");
    return blockRow(row);
  }

  private assertNoBlockOverlap(channelId: string, input: BlockInput, exceptId = "") {
    const clash = this.db.prepare("SELECT title FROM blocks WHERE channel_id = ? AND id <> ? AND starts_at < ? AND ends_at > ? LIMIT 1").get(channelId, exceptId, input.endsAt, input.startsAt) as Row | undefined;
    if (clash) throw new OverlapError(`overlaps block "${String(clash.title)}" on this channel`);
  }

  createBlock(channelId: string, input: BlockInput): Block {
    return this.transaction(() => {
      this.channel(channelId);
      this.assertNoBlockOverlap(channelId, input);
      const id = randomUUID();
      const at = this.stamp();
      this.db.prepare(`INSERT INTO blocks (id, channel_id, playlist_id, media_id, title, starts_at, ends_at, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, channelId, input.playlistId ?? null, input.mediaId ?? null, input.title, input.startsAt, input.endsAt, at, at);
      return this.block(id);
    });
  }

  updateBlock(id: string, expectedVersion: number, input: BlockInput): Block {
    return this.transaction(() => {
      const current = this.block(id);
      this.assertNoBlockOverlap(current.channelId, input, id);
      this.versioned("blocks", id, expectedVersion, () => this.db.prepare(`UPDATE blocks SET playlist_id = ?, media_id = ?, title = ?, starts_at = ?, ends_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`).run(input.playlistId ?? null, input.mediaId ?? null, input.title, input.startsAt, input.endsAt, this.stamp(), id, expectedVersion));
      return this.block(id);
    });
  }

  deleteBlock(id: string, expectedVersion: number) {
    this.versioned("blocks", id, expectedVersion, () => this.db.prepare("DELETE FROM blocks WHERE id = ? AND version = ?").run(id, expectedVersion));
  }

  // Program entries

  listPrograms(channelId: string): ProgramEntry[] {
    this.channel(channelId);
    return (this.db.prepare("SELECT * FROM program_entries WHERE channel_id = ? ORDER BY starts_at, id").all(channelId) as Row[]).map(programRow);
  }

  program(id: string): ProgramEntry {
    const row = this.db.prepare("SELECT * FROM program_entries WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("program");
    return programRow(row);
  }

  private assertNoProgramOverlap(channelId: string, input: ProgramInput, exceptId = "") {
    const clash = this.db.prepare("SELECT 1 FROM program_entries WHERE channel_id = ? AND id <> ? AND starts_at < ? AND ends_at > ? LIMIT 1").get(channelId, exceptId, input.endsAt, input.startsAt);
    if (clash) throw new OverlapError("overlaps another program on this channel");
  }

  private programValues(input: ProgramInput): SQLInputValue[] {
    return [input.mediaId, input.startsAt, input.endsAt, input.title, input.subtitle, input.tag, input.artist, input.description, input.artworkMediaId ?? null, input.fit, input.loop ? 1 : 0, input.mute ? 1 : 0, input.volume, input.placardPolicy, input.availabilityPolicy];
  }

  createProgram(channelId: string, input: ProgramInput): ProgramEntry {
    return this.transaction(() => {
      this.channel(channelId);
      this.assertNoProgramOverlap(channelId, input);
      const id = randomUUID();
      const at = this.stamp();
      this.db.prepare(`INSERT INTO program_entries (id, channel_id, media_id, starts_at, ends_at, title, subtitle, tag, artist, description, artwork_media_id, fit, loop, mute, volume, placard_policy, availability_policy, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, channelId, ...this.programValues(input), at, at);
      return this.program(id);
    });
  }

  updateProgram(id: string, expectedVersion: number, input: ProgramInput): ProgramEntry {
    return this.transaction(() => {
      const current = this.program(id);
      this.assertNoProgramOverlap(current.channelId, input, id);
      this.versioned("program_entries", id, expectedVersion, () => this.db.prepare(`UPDATE program_entries SET media_id = ?, starts_at = ?, ends_at = ?, title = ?, subtitle = ?, tag = ?, artist = ?, description = ?, artwork_media_id = ?, fit = ?, loop = ?, mute = ?, volume = ?, placard_policy = ?, availability_policy = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`).run(...this.programValues(input), this.stamp(), id, expectedVersion));
      return this.program(id);
    });
  }

  deleteProgram(id: string, expectedVersion: number) {
    this.versioned("program_entries", id, expectedVersion, () => this.db.prepare("DELETE FROM program_entries WHERE id = ? AND version = ?").run(id, expectedVersion));
  }
}
