// Authored Cable schedule: deployments → channels → blocks (and program
// entries). Blocks reference Cuelight playlists or media by id; Cable stores
// only the references.

export class NotFoundError extends Error {
  constructor(what = "Cable resource") {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** Stale If-Match version or a uniqueness clash (e.g. duplicate channel number). */
export class ConflictError extends Error {
  constructor(message = "Cable resource version conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

export class OverlapError extends Error {
  constructor(message = "scheduled blocks overlap") {
    super(message);
    this.name = "OverlapError";
  }
}

export class ValidationError extends Error {
  readonly field: string;
  readonly reason: string;
  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.name = "ValidationError";
    this.field = field;
    this.reason = reason;
  }
}

export const etag = (version: number) => `"v${version}"`;

/** Parses an If-Match ETag (`"v3"`, `W/"v3"` or a bare `3`) into a version. */
export function versionFromIfMatch(value: string | undefined): number {
  const match = value?.trim().match(/^(?:W\/)?"?v?(\d+)"?$/);
  if (!match) throw new ConflictError("If-Match with the current ETag is required");
  return Number(match[1]);
}

export type Theme = "nebula" | "gallery" | "noir";
export type GuideDensity = "quarter-hour" | "half-hour" | "hour";

export interface Deployment {
  id: string;
  name: string;
  timezone: string;
  theme: Theme;
  guideHorizonSeconds: number;
  guideDensity: GuideDensity;
  placardDefaults: Record<string, string>;
  fallbackMetadata: Record<string, string>;
  /** Web media item created in Cuelight for this deployment's guide, when added. */
  cuelightMediaId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Channel {
  id: string;
  deploymentId: string;
  number: number;
  name: string;
  callsign: string;
  description: string;
  accent: string;
  artworkMediaId?: string;
  enabled: boolean;
  standby: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Block {
  id: string;
  channelId: string;
  /** Cuelight playlist id; exactly one of playlistId and mediaId is set. */
  playlistId?: string;
  /** Cuelight media id. */
  mediaId?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type PlacardPolicy = "default" | "always" | "start" | "never";
export type AvailabilityPolicy = "fail" | "skip" | "fallback" | "hold";

export interface ProgramEntry {
  id: string;
  channelId: string;
  mediaId: string;
  startsAt: string;
  endsAt: string;
  title: string;
  subtitle: string;
  tag: string;
  artist: string;
  description: string;
  artworkMediaId?: string;
  placardPolicy: PlacardPolicy;
  fit: string;
  availabilityPolicy: AvailabilityPolicy;
  loop: boolean;
  mute: boolean;
  volume: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentInput {
  name: string;
  timezone: string;
  theme: Theme;
  guideHorizonSeconds: number;
  guideDensity: GuideDensity;
  placardDefaults: Record<string, string>;
  fallbackMetadata: Record<string, string>;
}

export interface ChannelInput {
  number: number;
  name: string;
  callsign: string;
  description: string;
  accent: string;
  artworkMediaId?: string;
  enabled: boolean;
  standby: boolean;
}

export interface BlockInput {
  playlistId?: string;
  mediaId?: string;
  title: string;
  startsAt: string;
  endsAt: string;
}

export interface ProgramInput {
  mediaId: string;
  startsAt: string;
  endsAt: string;
  title: string;
  subtitle: string;
  tag: string;
  artist: string;
  description: string;
  artworkMediaId?: string;
  placardPolicy: PlacardPolicy;
  fit: string;
  availabilityPolicy: AvailabilityPolicy;
  loop: boolean;
  mute: boolean;
  volume: number;
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("body", "must be a JSON object");
  return value as Raw;
}

function text(body: Raw, field: string, fallback = ""): string {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new ValidationError(field, "must be a string");
  return value.trim();
}

function optionalId(body: Raw, field: string): string | undefined {
  return text(body, field) || undefined;
}

function bool(body: Raw, field: string, fallback: boolean): boolean {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new ValidationError(field, "must be a boolean");
  return value;
}

function integer(body: Raw, field: string, fallback?: number): number {
  const value = body[field] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ValidationError(field, "must be an integer");
  return value;
}

function stringMap(body: Raw, field: string): Record<string, string> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry !== "string") throw new ValidationError(field, "values must be strings");
    out[key] = entry;
  }
  return out;
}

/** Parses an RFC 3339 instant into canonical UTC (`toISOString`). */
export function instant(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(field, "is required");
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ValidationError(field, "must be an RFC 3339 timestamp");
  return new Date(ms).toISOString();
}

export function normalizeTheme(value: string): Theme {
  const theme = value.trim().toLowerCase();
  if (theme === "nebula" || theme === "gallery" || theme === "noir") return theme;
  throw new ValidationError("theme", "must be one of nebula, gallery, or noir");
}

export function normalizeGuideDensity(value: string): GuideDensity {
  const density = value.trim().toLowerCase();
  if (density === "") return "half-hour";
  if (density === "quarter-hour" || density === "half-hour" || density === "hour") return density;
  throw new ValidationError("guideDensity", "must be one of quarter-hour, half-hour, or hour");
}

export function normalizeTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone) throw new ValidationError("timezone", "is required");
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new ValidationError("timezone", "must be an IANA timezone");
  }
}

export function normalizePlacardPolicy(value: string): PlacardPolicy {
  const policy = value.trim().toLowerCase() || "default";
  if (policy === "default" || policy === "always" || policy === "start" || policy === "never") return policy;
  throw new ValidationError("placardPolicy", "must be one of default, always, start, or never");
}

export function normalizeAvailabilityPolicy(value: string): AvailabilityPolicy {
  const policy = value.trim().toLowerCase() || "fail";
  if (policy === "fail" || policy === "skip" || policy === "fallback" || policy === "hold") return policy;
  throw new ValidationError("availabilityPolicy", "must be one of fail, skip, fallback, or hold");
}

const hour = 60 * 60;

export function parseDeploymentInput(value: unknown): DeploymentInput {
  const body = record(value);
  const name = text(body, "name");
  if (!name) throw new ValidationError("name", "is required");
  const guideHorizonSeconds = integer(body, "guideHorizonSeconds", 24 * hour);
  if (guideHorizonSeconds < hour || guideHorizonSeconds > 31 * 24 * hour) throw new ValidationError("guideHorizonSeconds", "must be between one hour and 31 days");
  return {
    name,
    timezone: normalizeTimezone(text(body, "timezone")),
    theme: normalizeTheme(text(body, "theme", "nebula")),
    guideHorizonSeconds,
    guideDensity: normalizeGuideDensity(text(body, "guideDensity")),
    placardDefaults: stringMap(body, "placardDefaults"),
    fallbackMetadata: stringMap(body, "fallbackMetadata"),
  };
}

export function parseChannelInput(value: unknown): ChannelInput {
  const body = record(value);
  const number = integer(body, "number");
  if (number <= 0) throw new ValidationError("number", "must be positive");
  const name = text(body, "name");
  if (!name) throw new ValidationError("name", "is required");
  return {
    number,
    name,
    callsign: text(body, "callsign"),
    description: text(body, "description"),
    accent: text(body, "accent"),
    artworkMediaId: optionalId(body, "artworkMediaId"),
    enabled: bool(body, "enabled", true),
    standby: bool(body, "standby", false),
  };
}

export function parseBlockInput(value: unknown): BlockInput {
  const body = record(value);
  const playlistId = optionalId(body, "playlistId");
  const mediaId = optionalId(body, "mediaId");
  if (Boolean(playlistId) === Boolean(mediaId)) throw new ValidationError("source", "must contain exactly one playlist or media item");
  const startsAt = instant(body.startsAt, "startsAt");
  const endsAt = instant(body.endsAt, "endsAt");
  if (endsAt <= startsAt) throw new ValidationError("time", "endsAt must be after startsAt");
  return { playlistId, mediaId, title: text(body, "title"), startsAt, endsAt };
}

export function parseProgramInput(value: unknown): ProgramInput {
  const body = record(value);
  const mediaId = text(body, "mediaId");
  if (!mediaId) throw new ValidationError("mediaId", "is required");
  const startsAt = instant(body.startsAt, "startsAt");
  const endsAt = instant(body.endsAt, "endsAt");
  if (endsAt <= startsAt) throw new ValidationError("time", "endsAt must be after startsAt");
  const volume = body.volume ?? 1;
  if (typeof volume !== "number" || volume < 0 || volume > 1) throw new ValidationError("volume", "must be between 0 and 1");
  const fit = text(body, "fit");
  if (fit !== "" && fit !== "fit" && fit !== "fill") throw new ValidationError("fit", "must be fit or fill");
  return {
    mediaId,
    startsAt,
    endsAt,
    title: text(body, "title"),
    subtitle: text(body, "subtitle"),
    tag: text(body, "tag"),
    artist: text(body, "artist"),
    description: text(body, "description"),
    artworkMediaId: optionalId(body, "artworkMediaId"),
    placardPolicy: normalizePlacardPolicy(text(body, "placardPolicy")),
    fit,
    availabilityPolicy: normalizeAvailabilityPolicy(text(body, "availabilityPolicy")),
    loop: bool(body, "loop", false),
    mute: bool(body, "mute", false),
    volume,
  };
}
