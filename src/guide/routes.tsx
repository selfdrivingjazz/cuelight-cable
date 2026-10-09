import * as React from "react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { loadPresentation, type Occurrence, type Presentation, type PresentationSource } from "./presentation";
import { initialRuntimeState, runtimeReducer, type RuntimeAction, type RuntimeState } from "./state";
import { CableServerSource, GuideLinkError, mediaSources, type CuelightApp, type GuideSession, type RemoteDescriptor, type RemoteEvent } from "./cuelightApp";
import { globalRemoteAction } from "./remoteActions";
import { LegacyGuide } from "./components/LegacyGuide";
import { SplashScreen } from "./components/SplashScreen";
import { useKeyboardRemote, useRemoteInput } from "./components/RemoteInput";

interface RuntimeContextValue {
  state: RuntimeState;
  dispatch: React.Dispatch<RuntimeAction>;
  /** Cuelight app access; absent in preview mode or once the app token was rejected. */
  app?: CuelightApp;
  /** Set when the guide link itself is unusable (no or unknown deployment); retrying cannot help. */
  linkBroken: boolean;
  /** Called when the Cuelight app API rejects the token; the guide falls back to preview mode. */
  appRejected(): void;
  /** The node's phone-remote session, from Cuelight's remote event polls; independent of the lineup. */
  remote?: RemoteDescriptor;
  setRemote(remote: RemoteDescriptor): void;
}

const RuntimeContext = React.createContext<RuntimeContextValue | null>(null);
interface RemoteEventBus {
  handler?: (event: RemoteEvent) => void;
  pending: RemoteEvent[];
  delivering: boolean;
  timer?: number;
  drain(): void;
}
const RemoteEventContext = React.createContext<React.MutableRefObject<RemoteEventBus> | null>(null);

function useRemoteEvents(handler: (event: RemoteEvent) => void) {
  const bus = React.useContext(RemoteEventContext);
  React.useLayoutEffect(() => {
    if (!bus) return;
    bus.current.handler = handler;
    bus.current.drain();
    return () => {
      if (bus.current.handler === handler) bus.current.handler = undefined;
    };
  }, [bus, handler]);
}


export function useRuntime(): RuntimeContextValue {
  const context = React.useContext(RuntimeContext);
  if (!context) throw new Error("Runtime context is unavailable");
  return context;
}

export interface RuntimeProviderProps {
  children: React.ReactNode;
  /** Read from the guide URL; absent with `linkError` when the link is unusable. */
  session?: GuideSession;
  linkError?: string;
  source?: PresentationSource;
}

const refreshInterval = 60_000;

export function RuntimeProvider({ children, session, linkError, source }: RuntimeProviderProps) {
  const activeSource = React.useMemo(() => source ?? (session ? new CableServerSource(session.deploymentId) : undefined), [session, source]);
  const [state, reducerDispatch] = React.useReducer(runtimeReducer, initialRuntimeState);
  const [attempt, setAttempt] = React.useState(0);
  const [linkBroken, setLinkBroken] = React.useState(Boolean(linkError));
  const [appLost, setAppLost] = React.useState(false);
  const [remote, setRemote] = React.useState<RemoteDescriptor>();
  const dispatch = React.useCallback<React.Dispatch<RuntimeAction>>((action) => {
    if (action.type === "RETRY_REVISION") setAttempt((value) => value + 1);
    reducerDispatch(action);
  }, []);
  const fail = React.useCallback((error: unknown) => {
    if (error instanceof GuideLinkError) setLinkBroken(true);
    reducerDispatch({ type: "REVISION_FAILED", message: error instanceof Error ? error.message : "The Cable guide could not be reached." });
  }, []);
  const appRejected = React.useCallback(() => setAppLost(true), []);

  React.useEffect(() => session?.app?.start(appRejected), [session, appRejected]);

  React.useEffect(() => {
    if (linkError) reducerDispatch({ type: "REVISION_FAILED", message: linkError });
  }, [linkError]);

  React.useEffect(() => {
    if (!activeSource) return;
    let cancelled = false;
    reducerDispatch({ type: "START_REVISION_LOAD" });
    void loadPresentation(activeSource).then((value) => {
      if (!cancelled) reducerDispatch({ type: "SYNC_REVISION", presentation: value });
    }, (error: unknown) => {
      if (!cancelled) fail(error);
    });
    const timer = window.setInterval(() => {
      void loadPresentation(activeSource).then((value) => {
        if (!cancelled) reducerDispatch({ type: "REFRESH_REVISION", presentation: value });
      }, (error: unknown) => {
        // Transient refresh failures keep the last lineup on screen; a deleted deployment does not.
        if (!cancelled && error instanceof GuideLinkError) fail(error);
      });
    }, refreshInterval);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSource, attempt, fail]);

  const app = appLost ? undefined : session?.app;
  return <RuntimeContext.Provider value={{ state, dispatch, app, linkBroken, appRejected, remote, setRemote }}>{children}</RuntimeContext.Provider>;
}

function presentationOf(state: RuntimeState): Presentation | undefined {
  return "presentation" in state ? state.presentation : undefined;
}

function formatInstant(value: string, timezone: string, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "medium", timeStyle: "short", ...options }).format(new Date(value));
}


function occurrenceForState(state: RuntimeState): Occurrence | undefined {
  if (state.kind === "warming" || state.kind === "player-opening" || state.kind === "player-ready" || state.kind === "player-failure") return state.occurrence;
  if (state.kind === "ready" || state.kind === "stale-offline") {
    return state.presentation.occurrences.find((occurrence) => occurrence.channelId === state.selectedId) ?? state.presentation.occurrences[0];
  }
  return undefined;
}

function Shell() {
  const { state, dispatch, app, appRejected, setRemote } = useRuntime();
  const navigate = useNavigate();
  const presentation = presentationOf(state);
  const [showSplash, setShowSplash] = React.useState(true);
  const remoteBus = React.useRef<RemoteEventBus>({ pending: [], delivering: false, drain: () => undefined });
  const drainRemoteEvents = React.useCallback(() => {
    const bus = remoteBus.current;
    if (bus.delivering || !bus.handler) return;
    const event = bus.pending.shift();
    if (!event) return;
    bus.delivering = true;
    bus.handler(event);
    bus.timer = window.setTimeout(() => {
      bus.delivering = false;
      bus.drain();
    }, 75);
  }, []);
  remoteBus.current.drain = drainRemoteEvents;
  const relayRemoteEvent = React.useCallback((event: RemoteEvent) => {
    const action = event.type === "key" && presentation ? globalRemoteAction(presentation, state, event.key) : undefined;
    if (action?.type === "guide") {
      dispatch({ type: "BACK_TO_GUIDE" });
      void navigate({ to: "/" });
      return;
    }
    if (action?.type === "tune") {
      dispatch({ type: "TUNE_LIVE", occurrence: action.occurrence });
      void navigate({ to: "/player" });
      return;
    }
    if (action?.type === "off-air") return;
    remoteBus.current.pending.push(event);
    remoteBus.current.drain();
  }, [dispatch, navigate, presentation, state]);
  useRemoteInput(app, relayRemoteEvent, setRemote, appRejected);
  useKeyboardRemote(relayRemoteEvent);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setShowSplash(false), 4_700);
    return () => window.clearTimeout(timer);
  }, []);
  React.useEffect(() => () => {
    if (remoteBus.current.timer) window.clearTimeout(remoteBus.current.timer);
  }, []);
  return <RemoteEventContext.Provider value={remoteBus}><div className={`legacy-root theme-${presentation?.theme ?? "nebula"}`} data-runtime-state={state.kind} data-mode={app ? "screen" : "preview"}><Outlet /><SplashScreen active={showSplash} /></div></RemoteEventContext.Provider>;
}

function SyncState() {
  return (
    <section className="state-panel state-panel-sync" aria-live="polite">
      <h1>Finding your lineup</h1>
      <p>One moment while Cable tunes in.</p>
      <div className="meter" role="progressbar" aria-label="Loading lineup"><span /></div>
    </section>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { state, linkBroken } = useRuntime();
  const message = state.kind === "error" ? state.message : undefined;
  if (linkBroken) {
    return (
      <section className="state-panel state-panel-error" aria-live="assertive">
        <h1>Guide link unavailable</h1>
        <p>{message}</p>
      </section>
    );
  }
  return (
    <section className="state-panel state-panel-error" aria-live="assertive">
      <h1>Unable to load lineup</h1>
      <p>{message ?? "Check the connection and try again."}</p>
      <div className="state-actions"><button className="button" type="button" onClick={onRetry}>Try again</button></div>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="state-panel state-panel-empty" aria-live="polite">
      <h1>Nothing scheduled</h1>
      <p>There are no programmes in the guide right now.</p>
    </section>
  );
}

function GuidePage() {
  const { state, dispatch, app, remote } = useRuntime();
  const navigate = useNavigate();
  const presentation = "presentation" in state ? state.presentation : undefined;
  const selectedId = state.kind === "ready" || state.kind === "stale-offline" ? state.selectedId : null;
  const selectChannel = React.useCallback((channelId: string) => dispatch({ type: "SELECT_CHANNEL", channelId }), [dispatch]);
  const tuneChannel = React.useCallback((channelId: string) => {
    if (!presentation) return;
    dispatch({ type: "SELECT_CHANNEL", channelId });
    const now = Date.now();
    const current = presentation.occurrences.find((occurrence) => occurrence.channelId === channelId && new Date(occurrence.startsAt).getTime() <= now && now < new Date(occurrence.endsAt).getTime());
    if (!current) return;
    dispatch({ type: "TUNE_LIVE", occurrence: current });
    void navigate({ to: "/player" });
  }, [dispatch, navigate, presentation]);
  const remoteEvent = React.useCallback((event: RemoteEvent) => {
    if (!presentation || event.type !== "key") return;
    const channels = presentation.channels.filter((channel) => channel.enabled);
    if (channels.length === 0) return;
    const index = Math.max(0, channels.findIndex((channel) => channel.id === selectedId));
    if (event.key === "ArrowUp") {
      const channel = channels[(index - 1 + channels.length) % channels.length];
      if (channel) selectChannel(channel.id);
    } else if (event.key === "ArrowDown") {
      const channel = channels[(index + 1) % channels.length];
      if (channel) selectChannel(channel.id);
    } else if (event.key === "ChannelUp") {
      const channel = channels[(index + 1) % channels.length];
      if (channel) tuneChannel(channel.id);
    } else if (event.key === "ChannelDown") {
      const channel = channels[(index - 1 + channels.length) % channels.length];
      if (channel) tuneChannel(channel.id);
    } else if (event.key === "Enter") {
      const channel = channels[index];
      if (channel) tuneChannel(channel.id);
    } else if (event.key?.startsWith("ChannelNumber:")) {
      const number = Number(event.key.slice("ChannelNumber:".length));
      const channel = channels.find((candidate) => candidate.number === number);
      if (channel) tuneChannel(channel.id);
    }
  }, [presentation, selectChannel, selectedId, tuneChannel]);
  useRemoteEvents(remoteEvent);
  if (state.kind === "boot" || state.kind === "revision-loading") return <SyncState />;
  if (state.kind === "error") return <ErrorState onRetry={() => dispatch({ type: "RETRY_REVISION" })} />;
  if (state.kind === "empty-lineup") return <EmptyState />;
  if (state.kind === "diagnostics") return <DiagnosticsPage />;
  if (!presentation) return <SyncState />;
  return <LegacyGuide
    presentation={presentation}
    selectedChannelId={selectedId}
    offline={state.kind === "stale-offline" || presentation.revision.stale}
    preview={!app}
    mediaSources={(media) => mediaSources(app, media)}
    remoteURL={remote?.url}
    showQR={remote?.showQr}
    onSelectChannel={(channel) => selectChannel(channel.id)}
    onTune={(occurrence) => {
      dispatch({ type: "TUNE_LIVE", occurrence });
      void navigate({ to: "/player" });
    }}
  />;
}

function PlayerPage() {
  const { state, dispatch } = useRuntime();
  const navigate = useNavigate();
  const tuneAdjacent = React.useCallback((delta: number) => {
    if (state.kind !== "player-opening" && state.kind !== "player-ready") return;
    const channels = state.presentation.channels.filter((channel) => channel.enabled);
    const index = channels.findIndex((channel) => channel.id === state.occurrence.channelId);
    if (index < 0 || channels.length === 0) return;
    const channel = channels[(index + delta + channels.length) % channels.length];
    if (!channel) return;
    const now = Date.now();
    const occurrence = state.presentation.occurrences.find((candidate) => candidate.channelId === channel.id && new Date(candidate.startsAt).getTime() <= now && now < new Date(candidate.endsAt).getTime());
    if (occurrence) dispatch({ type: "TUNE_LIVE", occurrence });
  }, [dispatch, state]);
  React.useEffect(() => {
    if (state.kind !== "warming") return;
    const timer = window.setTimeout(() => dispatch({ type: "ARTIFACT_READY" }), 320);
    return () => window.clearTimeout(timer);
  }, [dispatch, state.kind]);
  React.useEffect(() => {
    if (state.kind !== "player-opening" && state.kind !== "player-ready") return;
    const endsAt = new Date(state.occurrence.endsAt).getTime();
    const advance = () => {
      const at = Date.now() + 50;
      const next = state.presentation.occurrences.find((occurrence) => occurrence.channelId === state.occurrence.channelId && occurrence.id !== state.occurrence.id && new Date(occurrence.startsAt).getTime() <= at && at < new Date(occurrence.endsAt).getTime());
      if (next) {
        dispatch({ type: "TUNE_LIVE", occurrence: next });
        return;
      }
      dispatch({ type: "BACK_TO_GUIDE" });
      void navigate({ to: "/" });
    };
    if (endsAt <= Date.now()) {
      advance();
      return;
    }
    const timer = window.setTimeout(advance, endsAt - Date.now());
    return () => window.clearTimeout(timer);
  }, [dispatch, navigate, state]);
  if (state.kind === "boot" || state.kind === "revision-loading") return <SyncState />;
  if (state.kind === "error") return <ErrorState onRetry={() => dispatch({ type: "RETRY_REVISION" })} />;
  if (state.kind === "warming") return <PlayerState title="Tuning channel" detail="Please wait while the programme begins." busy />;
  if (state.kind === "player-opening") return <PlayerSurface occurrence={state.occurrence} onReady={() => dispatch({ type: "PLAYER_READY" })} onFailure={() => dispatch({ type: "PLAYER_FAILED", message: "The programme could not be played." })} onBack={() => { dispatch({ type: "BACK_TO_GUIDE" }); void navigate({ to: "/" }); }} onChannel={tuneAdjacent} />;
  if (state.kind === "player-failure") return <PlayerState title="Playback unavailable" detail={state.message}><button className="button" type="button" onClick={() => dispatch({ type: "RETRY_PLAYER" })}>Try again</button><button className="button secondary" type="button" onClick={() => { dispatch({ type: "BACK_TO_GUIDE" }); void navigate({ to: "/" }); }}>Guide</button></PlayerState>;
  if (state.kind !== "player-ready") return <PlayerState title="No programme selected" detail="Return to the guide to choose a channel."><Link className="button" to="/">Guide</Link></PlayerState>;
  return <PlayerSurface occurrence={state.occurrence} onFailure={() => dispatch({ type: "PLAYER_FAILED", message: "The programme stopped unexpectedly." })} onBack={() => { dispatch({ type: "BACK_TO_GUIDE" }); void navigate({ to: "/" }); }} onChannel={tuneAdjacent} />;
}

function PlayerState({ title, detail, busy = false, children }: { title: string; detail: string; busy?: boolean; children?: React.ReactNode }) {
  return <section className="player-surface player-state" aria-live="polite"><div className="player-state-content"><h1>{title}</h1><p>{detail}</p>{busy && <div className="meter" role="progressbar" aria-label="Tuning channel"><span /></div>}<div className="state-actions">{children}</div></div></section>;
}

function PlayerSurface({ occurrence, onReady, onFailure, onBack, onChannel }: { occurrence: Occurrence; onReady?: () => void; onFailure: () => void; onBack: () => void; onChannel: (delta: number) => void }) {
  const [volume, setVolume] = React.useState(() => Math.round(occurrence.volume ?? 100));
  const [muted, setMuted] = React.useState(occurrence.muted ?? false);
  const video = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    if (!video.current) return;
    video.current.volume = volume / 100;
    video.current.muted = muted;
  }, [muted, volume]);
  const { app } = useRuntime();
  const sources = mediaSources(app, occurrence.media);
  const handleRemote = React.useCallback((event: RemoteEvent) => {
    if (event.type !== "key") return;
    if (event.key === "Escape" || event.key === "Backspace" || event.key === "Guide") onBack();
    else if (event.key === "VolumeUp") { setMuted(false); setVolume((value) => Math.min(100, value + 5)); }
    else if (event.key === "VolumeDown") { setMuted(false); setVolume((value) => Math.max(0, value - 5)); }
    else if (event.key === "Mute") setMuted((value) => !value);
    else if (event.key === "ChannelUp") onChannel(1);
    else if (event.key === "ChannelDown") onChannel(-1);
    else if (event.key === "Enter" && video.current) {
      if (video.current.paused) void video.current.play();
      else video.current.pause();
    }
  }, [onBack, onChannel]);
  useRemoteEvents(handleRemote);
  // Preview mode (no Cuelight app token) can only show a file programme's poster.
  const media = occurrence.media.kind === "web"
    ? <WebProgram url={occurrence.media.url} title={occurrence.title} onReady={onReady} />
    : !sources.src
      ? <img className="player-content-media" src={sources.poster} alt={occurrence.title} onLoad={onReady} onError={onFailure} />
      : occurrence.media.kind === "video"
        ? <video ref={video} className="player-content-media" src={sources.src} poster={sources.poster} autoPlay playsInline loop={occurrence.loop ?? false} muted={muted} onCanPlay={onReady} onError={onFailure} />
        : <img className="player-content-media" src={sources.src} alt={occurrence.title} onLoad={onReady} onError={onFailure} />;
  return <section className="player-surface" aria-label="Cable player">
    <div className="player-viewport" data-fit={occurrence.fit ?? "fit"}>{media}</div>
    {!sources.src && <p className="player-preview-note">Preview — assign this guide to a Cuelight screen to play programmes.</p>}
  </section>;
}

/**
 * A web programme framed full-bleed.
 *
 * The sandbox keeps what typical pages need (scripts, their own origin's
 * storage and cookies, forms, pointer lock) and withholds top-level
 * navigation, popups and modal dialogs: a page must not be able to navigate
 * the guide away or block a screen with a dialog nobody can dismiss.
 *
 * A focused cross-origin frame swallows keystrokes (the keyboard remote), so
 * whenever the page takes focus the guide takes it back. Cuelight remote
 * events arrive by long poll and do not depend on focus.
 */
function WebProgram({ url, title, onReady }: { url: string; title: string; onReady?: () => void }) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  React.useEffect(() => {
    let timer: number | undefined;
    const reclaim = () => {
      window.clearTimeout(timer);
      // The frame is the parent's activeElement only once focus has moved into it.
      timer = window.setTimeout(() => {
        if (!frame.current || document.activeElement !== frame.current) return;
        frame.current.blur();
        window.focus();
      }, 0);
    };
    window.addEventListener("blur", reclaim);
    return () => {
      window.removeEventListener("blur", reclaim);
      window.clearTimeout(timer);
    };
  }, []);
  return <iframe ref={frame} className="player-content-media player-web" src={url} title={title} tabIndex={-1} allow="autoplay; fullscreen" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" onLoad={onReady} />;
}

function PlacardPage() {
  const { state, dispatch } = useRuntime();
  const navigate = useNavigate();
  if (state.kind === "error") return <ErrorState onRetry={() => dispatch({ type: "RETRY_REVISION" })} />;
  if (!("presentation" in state)) return <SyncState />;
  const occurrence = occurrenceForState(state);
  const isOffline = state.kind === "stale-offline" || state.presentation.revision.stale;
  const tune = () => {
    if (!occurrence) return;
    dispatch({ type: "SELECT_PROGRAM", occurrence });
    void navigate({ to: "/player" });
  };
  return <section className="placard-page"><div className="placard-orbit" aria-hidden="true" />{isOffline && <div className="state-banner state-banner-warning" role="status">Schedule may be out of date</div>}{occurrence ? <><p className="placard-channel">{state.presentation.channels.find((channel) => channel.id === occurrence.channelId)?.callsign ?? "CABLE"}</p><h1>{occurrence.title}</h1><p className="placard-subtitle">{occurrence.subtitle ?? "Now showing"}</p><div className="placard-meta"><span>{formatInstant(occurrence.startsAt, state.presentation.revision.timezone)}</span><span>Until {formatInstant(occurrence.endsAt, state.presentation.revision.timezone, { dateStyle: undefined, timeStyle: "short" })}</span></div></> : <><h1>Off air</h1><p className="placard-subtitle">There is no programme scheduled right now.</p></>}<div className="state-actions"><button className="button" type="button" disabled={!occurrence} onClick={tune}>Tune programme</button><button className="button secondary" type="button" onClick={() => { dispatch({ type: "BACK_TO_GUIDE" }); void navigate({ to: "/" }); }}>Guide</button></div></section>;
}
function DiagnosticsPage() {
  const { state, dispatch } = useRuntime();
  const navigate = useNavigate();
  if (state.kind === "error") return <ErrorState onRetry={() => dispatch({ type: "RETRY_REVISION" })} />;
  if (!("presentation" in state)) return <SyncState />;
  const { presentation } = state;
  const returnToGuide = () => {
    dispatch({ type: "BACK_TO_GUIDE" });
    void navigate({ to: "/" });
  };
  return <section className="diagnostics"><p className="eyebrow">DIAGNOSTICS / READ-ONLY</p><h1>Signal details</h1><p className="diagnostics-deck">The Cable server computes this live presentation from the authored schedule.</p><dl><div><dt>Runtime</dt><dd>{state.kind}</dd></div><div><dt>Revision</dt><dd>{presentation.revision.id}</dd></div><div><dt>Digest</dt><dd>{presentation.revision.digest}</dd></div><div><dt>Generated</dt><dd>{formatInstant(presentation.revision.generatedAt, presentation.revision.timezone)}</dd></div><div><dt>Bridge</dt><dd>{presentation.bridge.state}</dd></div><div><dt>Protocol</dt><dd>{presentation.bridge.protocolVersion}</dd></div><div><dt>Occurrences</dt><dd>{presentation.occurrences.length}</dd></div></dl><button className="button" type="button" onClick={returnToGuide}>Return to guide</button></section>;
}

const rootRoute = createRootRoute({ component: Shell });
const guideRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: GuidePage });
const playerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/player", component: PlayerPage });
const placardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/placard", component: PlacardPage });
const diagnosticsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/diagnostics", component: DiagnosticsPage });
const routeTree = rootRoute.addChildren([guideRoute, playerRoute, placardRoute, diagnosticsRoute]);
// Memory history keeps the address bar on the hosted `/guide/?deployment=…` URL.
export const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
