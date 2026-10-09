import { PresentationError, type OccurrenceMedia, type PresentationSource } from "./presentation";

export class GuideLinkError extends PresentationError {
  constructor(message: string) {
    super(message);
    this.name = "GuideLinkError";
  }
}

/** The Cuelight app API rejected the app token (expired, or the screen was reassigned). */
export class AppAuthError extends Error {
  constructor() {
    super("This screen's Cuelight access has expired.");
    this.name = "AppAuthError";
  }
}

export interface GuideSession {
  deploymentId: string;
  /** Present when a Cuelight node opened the page with an app token; absent in preview mode. */
  app?: CuelightApp;
}

interface LocationLike { pathname: string; search: string; hash: string }
interface HistoryLike { state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void }
type Fetcher = typeof fetch;

/**
 * Reads `?deployment=<id>#cuelight-token=<t>&cuelight-api=<url>` and strips
 * the fragment so the token does not linger in the address bar or history.
 * Without both fragment values the guide runs in preview mode.
 */
export function readGuideSession(location: LocationLike, history: HistoryLike, fetcher?: Fetcher): GuideSession {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = fragment.get("cuelight-token")?.trim() ?? "";
  const api = fragment.get("cuelight-api")?.trim() ?? "";
  if (location.hash) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  const deploymentId = new URLSearchParams(location.search).get("deployment")?.trim() ?? "";
  if (!deploymentId) throw new GuideLinkError("This guide link is missing its deployment.");
  return { deploymentId, app: token && api ? new CuelightApp(token, api, fetcher) : undefined };
}

const renewMargin = 10 * 60_000;
const renewFallback = 60 * 60_000;

/** Cuelight app API (`{api}/app/*`) authenticated with the screen's app token, renewed before it expires. */
export class CuelightApp {
  readonly api: string;
  private current: string;
  private expiresAt: number | undefined;
  private readonly fetcher: Fetcher;
  private failed: AppAuthError | undefined;

  constructor(token: string, api: string, fetcher: Fetcher = (input, init) => fetch(input, init)) {
    this.current = token;
    this.api = api.replace(/\/+$/, "");
    this.fetcher = fetcher;
  }

  get token(): string {
    return this.current;
  }

  /** Set once the app API has rejected the token. */
  get error(): AppAuthError | undefined {
    return this.failed;
  }

  reject(): AppAuthError {
    this.failed ??= new AppAuthError();
    return this.failed;
  }

  headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.current}`, Accept: "application/json" };
  }

  /** Delay until the next renewal: 10 minutes before expiry, or hourly while expiry is unknown. */
  renewDelay(now = Date.now()): number {
    if (this.expiresAt === undefined) return renewFallback;
    return Math.max(0, this.expiresAt - renewMargin - now);
  }

  /** Swaps the token for its successor (`POST {api}/app/token:renew`). */
  async renew(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.api}/app/token:renew`, { method: "POST", cache: "no-store", credentials: "omit", headers: this.headers() });
    } catch {
      this.expireIfPast();
      throw new Error("The app token could not be renewed.");
    }
    if (response.status === 401 || response.status === 403) throw this.reject();
    if (!response.ok) {
      this.expireIfPast();
      throw new Error(`App token renewal returned HTTP ${response.status}.`);
    }
    const body = await response.json() as { token?: string; expiresAt?: string };
    if (!body.token) throw new Error("App token renewal returned no token.");
    this.current = body.token;
    const expiresAt = body.expiresAt ? Date.parse(body.expiresAt) : NaN;
    this.expiresAt = Number.isNaN(expiresAt) ? undefined : expiresAt;
  }

  private expireIfPast() {
    if (this.expiresAt !== undefined && this.expiresAt <= Date.now()) this.reject();
  }

  /** Renews on schedule until stopped; retries failed renewals after a minute. */
  start(onError: (error: AppAuthError) => void): () => void {
    let timer: number | undefined;
    let stopped = false;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        void this.renew().then(() => { if (!stopped) schedule(this.renewDelay()); }, (error: unknown) => {
          if (stopped) return;
          if (error instanceof AppAuthError) onError(error);
          else schedule(60_000);
        });
      }, delay);
    };
    schedule(this.renewDelay());
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }

  /** URL for <video>/<img>, which cannot send headers; the token rides as access_token. */
  mediaUrl(mediaId: string, part: "content" | "thumbnail"): string {
    return `${this.api}/app/media/${encodeURIComponent(mediaId)}/${part}?access_token=${encodeURIComponent(this.token)}`;
  }

  /** One long-poll of the screen's remote events. */
  async remoteEvents(after: number, waitSeconds: number, signal: AbortSignal): Promise<RemoteEventPage> {
    const response = await this.fetcher(`${this.api}/app/remote/events?after=${after}&waitSeconds=${waitSeconds}`, { cache: "no-store", credentials: "omit", headers: this.headers(), signal });
    if (response.status === 401 || response.status === 403) throw this.reject();
    if (!response.ok) throw new Error(`Remote events returned HTTP ${response.status}.`);
    const page = await response.json() as Partial<{ events: RemoteEvent[]; nextSequence: number; remote: RemoteDescriptor }>;
    return { events: page.events ?? [], next: page.nextSequence ?? after, remote: page.remote };
  }
}

export interface RemoteEvent {
  sequence: number;
  type: "key" | "text" | "pointer" | "wheel";
  key?: string;
  text?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  button?: string;
  state?: string;
}

export interface RemoteEventPage {
  events: RemoteEvent[];
  next: number;
  remote?: RemoteDescriptor;
}

/** The node's active phone-remote session; the guide renders the QR for `url` when `showQr` is set. */
export interface RemoteDescriptor {
  url: string;
  showQr: boolean;
  expiresAt: string;
}

export interface MediaSources {
  /** Playable bytes; absent in preview mode (no app token). */
  src?: string;
  poster: string;
}

/** Where the guide loads a programme's media from: Cuelight with an app token, else the Cable thumbnail proxy. */
export function mediaSources(app: CuelightApp | undefined, media: OccurrenceMedia): MediaSources {
  if (app && !app.error) return { src: app.mediaUrl(media.mediaId, "content"), poster: app.mediaUrl(media.mediaId, "thumbnail") };
  return { poster: `/api/media/${encodeURIComponent(media.mediaId)}/thumbnail` };
}

/** Reads the live presentation the Cable server computes for a deployment. */
export class CableServerSource implements PresentationSource {
  private readonly deploymentId: string;
  private readonly fetcher: Fetcher;

  constructor(deploymentId: string, fetcher: Fetcher = (input, init) => fetch(input, init)) {
    this.deploymentId = deploymentId;
    this.fetcher = fetcher;
  }

  async read(): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`/api/deployments/${encodeURIComponent(this.deploymentId)}/presentation`, { cache: "no-store", headers: { Accept: "application/json" } });
    } catch {
      throw new PresentationError("The Cable guide could not be reached.");
    }
    if (response.status === 404) throw new GuideLinkError("This guide's deployment no longer exists.");
    if (!response.ok) throw new PresentationError(`The Cable guide returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new PresentationError("The Cable guide returned invalid JSON.");
    }
  }
}
