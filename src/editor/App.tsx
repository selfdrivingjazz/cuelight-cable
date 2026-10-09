import * as React from "react";
import { api, ApiError, thumbnailUrl, type Block, type Channel, type CuelightMedia, type CuelightPlaylist, type CuelightStatus, type DeploymentView, type ProgramEntry } from "./api";

// Deployments → channels → blocks/programs. Blocks point at Cuelight
// playlists or media; the pickers list the Cuelight library through the Cable
// server, which holds the operator token.

type Route = { page: "deployments" } | { page: "deployment"; id: string } | { page: "channel"; id: string };

function parseRoute(hash: string): Route {
  const [, kind, id] = hash.replace(/^#/, "").split("/");
  if (kind === "deployments" && id) return { page: "deployment", id };
  if (kind === "channels" && id) return { page: "channel", id };
  return { page: "deployments" };
}

function useRoute(): Route {
  const [route, setRoute] = React.useState(() => parseRoute(window.location.hash));
  React.useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function useLoad<T>(load: () => Promise<T>, deps: React.DependencyList): { data?: T; error?: Error; reload: () => void } {
  const [state, setState] = React.useState<{ data?: T; error?: Error }>({});
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    load().then((data) => { if (active) setState({ data }); }, (error: unknown) => { if (active) setState({ error: error instanceof Error ? error : new Error(String(error)) }); });
    return () => { active = false; };
  }, [...deps, attempt]);
  return { ...state, reload: () => setAttempt((value) => value + 1) };
}

/** Runs a mutation, tracking pending state and the last error for the form. */
function useAction() {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}

const toLocalInput = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (value: string) => new Date(value).toISOString();
const formatWhen = (iso: string, timezone: string) => new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

function ErrorText({ message }: { message?: string }) {
  return message ? <p className="error" role="alert">{message}</p> : null;
}

function Loading({ error }: { error?: Error }) {
  return error ? <ErrorText message={error.message} /> : <p className="muted">Loading…</p>;
}

export function App() {
  const route = useRoute();
  const status = useLoad(() => api<CuelightStatus>("GET", "/api/cuelight/status"), []);
  return <div className="app">
    <header className="topbar"><a href="#/" className="brand">Cuelight Cable</a><CuelightBadge status={status.data} /></header>
    <main>
      {route.page === "deployments" && <DeploymentsPage />}
      {route.page === "deployment" && <DeploymentPage id={route.id} status={status.data} />}
      {route.page === "channel" && <ChannelPage id={route.id} />}
    </main>
  </div>;
}

function CuelightBadge({ status }: { status?: CuelightStatus }) {
  if (!status) return <span className="badge">Cuelight…</span>;
  if (!status.reachable) return <span className="badge bad" title={status.error}>Cuelight unreachable</span>;
  return <span className="badge ok" title={status.scopes.join(", ")}>Cuelight connected{status.canWriteMedia ? "" : " (read-only)"}</span>;
}

// Deployments

const emptyDeployment = { name: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, theme: "nebula", guideDensity: "half-hour", guideHorizonSeconds: 86400 };

function DeploymentsPage() {
  const list = useLoad(() => api<{ items: DeploymentView[] }>("GET", "/api/deployments"), []);
  const action = useAction();
  return <section>
    <h1>Deployments</h1>
    <p className="muted">A deployment is one cable lineup: its channels, schedule and guide.</p>
    {!list.data ? <Loading error={list.error} /> : list.data.items.length === 0 ? <p className="muted">No deployments yet.</p> : <table>
      <thead><tr><th>Name</th><th>Timezone</th><th>Theme</th><th>Guide</th></tr></thead>
      <tbody>{list.data.items.map((item) => <tr key={item.id}><td><a href={`#/deployments/${item.id}`}>{item.name}</a></td><td>{item.timezone}</td><td>{item.theme}</td><td><a href={item.guideUrl} target="_blank" rel="noreferrer">Open guide</a></td></tr>)}</tbody>
    </table>}
    <h2>New deployment</h2>
    <DeploymentForm initial={emptyDeployment} submitLabel="Create deployment" pending={action.pending} error={action.error} onSubmit={(input) => void action.run(async () => {
      const created = await api<DeploymentView>("POST", "/api/deployments", input);
      window.location.hash = `#/deployments/${created.id}`;
    })} />
  </section>;
}

type DeploymentFields = typeof emptyDeployment;

function DeploymentForm({ initial, submitLabel, pending, error, onSubmit }: { initial: DeploymentFields; submitLabel: string; pending: boolean; error?: string; onSubmit: (input: DeploymentFields) => void }) {
  const [fields, setFields] = React.useState(initial);
  const set = (patch: Partial<DeploymentFields>) => setFields((current) => ({ ...current, ...patch }));
  return <form className="form grid" onSubmit={(event) => { event.preventDefault(); onSubmit(fields); }}>
    <label>Name<input required value={fields.name} onChange={(event) => set({ name: event.currentTarget.value })} /></label>
    <label>Timezone<input required value={fields.timezone} onChange={(event) => set({ timezone: event.currentTarget.value })} /></label>
    <label>Theme<select value={fields.theme} onChange={(event) => set({ theme: event.currentTarget.value })}><option value="nebula">Nebula</option><option value="gallery">Gallery</option><option value="noir">Noir</option></select></label>
    <label>Guide time slots<select value={fields.guideDensity} onChange={(event) => set({ guideDensity: event.currentTarget.value })}><option value="quarter-hour">15 minutes</option><option value="half-hour">30 minutes</option><option value="hour">60 minutes</option></select></label>
    <label>Guide horizon (hours)<input type="number" min={1} max={744} value={fields.guideHorizonSeconds / 3600} onChange={(event) => set({ guideHorizonSeconds: Math.round(Number(event.currentTarget.value) * 3600) })} /></label>
    <div className="actions"><button type="submit" disabled={pending}>{pending ? "Saving…" : submitLabel}</button><ErrorText message={error} /></div>
  </form>;
}

function DeploymentPage({ id, status }: { id: string; status?: CuelightStatus }) {
  const deployment = useLoad(() => api<DeploymentView>("GET", `/api/deployments/${id}`), [id]);
  const save = useAction();
  const remove = useAction();
  if (!deployment.data) return <Loading error={deployment.error} />;
  const value = deployment.data;
  return <section>
    <p className="crumbs"><a href="#/">Deployments</a> /</p>
    <h1>{value.name}</h1>
    <GuidePanel deployment={value} status={status} onChange={deployment.reload} />
    <ChannelsPanel deployment={value} />
    <h2>Settings</h2>
    <DeploymentForm key={value.version} initial={{ name: value.name, timezone: value.timezone, theme: value.theme, guideDensity: value.guideDensity, guideHorizonSeconds: value.guideHorizonSeconds }} submitLabel="Save deployment" pending={save.pending} error={save.error} onSubmit={(input) => void save.run(async () => {
      await api("PATCH", `/api/deployments/${id}`, { ...input, placardDefaults: value.placardDefaults, fallbackMetadata: value.fallbackMetadata }, value.version);
      deployment.reload();
    })} />
    <div className="danger"><button className="secondary" disabled={remove.pending} onClick={() => {
      if (!window.confirm(`Delete ${value.name} with all its channels and blocks?`)) return;
      void remove.run(async () => {
        await api("DELETE", `/api/deployments/${id}`, undefined, value.version);
        window.location.hash = "#/";
      });
    }}>Delete deployment</button><ErrorText message={remove.error} /></div>
  </section>;
}

function GuidePanel({ deployment, status, onChange }: { deployment: DeploymentView; status?: CuelightStatus; onChange: () => void }) {
  const add = useAction();
  const [manual, setManual] = React.useState(false);
  const canWrite = status?.canWriteMedia ?? false;
  return <div className="card">
    <h2>Guide</h2>
    <p>Guide URL <code className="url">{deployment.guideUrl}</code> <button className="link" onClick={() => void navigator.clipboard?.writeText(deployment.guideUrl)}>Copy</button> · <a href={deployment.guideUrl} target="_blank" rel="noreferrer">Preview</a></p>
    {deployment.cuelightMediaId
      ? <p className="ok-text">In Cuelight as web media <code>{deployment.cuelightMediaId}</code> with Cuelight app access. Assign it to a screen in Cuelight to show the guide.</p>
      : <p className="muted">Put the guide on a screen by adding it to Cuelight as a web media item with app access, then assigning that item to a screen.</p>}
    <div className="actions">
      <button disabled={add.pending || !canWrite} title={canWrite ? undefined : "The Cuelight token lacks media_write"} onClick={() => void add.run(async () => {
        try {
          await api("POST", `/api/deployments/${deployment.id}/cuelight-media`);
          onChange();
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) setManual(true);
          throw error;
        }
      })}>{add.pending ? "Adding…" : deployment.cuelightMediaId ? "Re-add to Cuelight" : "Add to Cuelight"}</button>
      <ErrorText message={add.error} />
    </div>
    {(manual || (status && !canWrite)) && <p className="hint">This server's Cuelight token cannot create media. In Cuelight, add a web item with URL <code>{deployment.guideUrl}</code> and turn on “Cuelight app — give this page access to the screen's remote and the media library”.</p>}
  </div>;
}

// Channels

const emptyChannel = { number: "", name: "", callsign: "", accent: "#5eead4", description: "", enabled: true, standby: false };
type ChannelFields = typeof emptyChannel;

function ChannelForm({ initial, submitLabel, pending, error, onSubmit }: { initial: ChannelFields; submitLabel: string; pending: boolean; error?: string; onSubmit: (input: ChannelFields) => void }) {
  const [fields, setFields] = React.useState(initial);
  const set = (patch: Partial<ChannelFields>) => setFields((current) => ({ ...current, ...patch }));
  return <form className="form grid" onSubmit={(event) => { event.preventDefault(); onSubmit(fields); }}>
    <label>Number<input required type="number" min={1} value={fields.number} onChange={(event) => set({ number: event.currentTarget.value })} /></label>
    <label>Name<input required value={fields.name} onChange={(event) => set({ name: event.currentTarget.value })} /></label>
    <label>Callsign<input value={fields.callsign} onChange={(event) => set({ callsign: event.currentTarget.value })} /></label>
    <label>Accent<input type="color" value={fields.accent || "#5eead4"} onChange={(event) => set({ accent: event.currentTarget.value })} /></label>
    <label className="wide">Description<input value={fields.description} onChange={(event) => set({ description: event.currentTarget.value })} /></label>
    <label className="check"><input type="checkbox" checked={fields.enabled} onChange={(event) => set({ enabled: event.currentTarget.checked })} />Enabled</label>
    <label className="check"><input type="checkbox" checked={fields.standby} onChange={(event) => set({ standby: event.currentTarget.checked })} />Standby</label>
    <div className="actions"><button type="submit" disabled={pending}>{pending ? "Saving…" : submitLabel}</button><ErrorText message={error} /></div>
  </form>;
}

const channelBody = (fields: ChannelFields) => ({ ...fields, number: Number(fields.number) });

function ChannelsPanel({ deployment }: { deployment: DeploymentView }) {
  const list = useLoad(() => api<{ items: Channel[] }>("GET", `/api/deployments/${deployment.id}/channels`), [deployment.id]);
  const create = useAction();
  const [formKey, setFormKey] = React.useState(0);
  return <>
    <h2>Channels</h2>
    {!list.data ? <Loading error={list.error} /> : list.data.items.length === 0 ? <p className="muted">No channels yet.</p> : <table>
      <thead><tr><th>#</th><th>Name</th><th>Callsign</th><th>Status</th></tr></thead>
      <tbody>{list.data.items.map((channel) => <tr key={channel.id}><td><span className="swatch" style={{ background: channel.accent || "transparent" }} />{channel.number}</td><td><a href={`#/channels/${channel.id}`}>{channel.name}</a></td><td>{channel.callsign}</td><td>{!channel.enabled ? "Disabled" : channel.standby ? "Standby" : "On air"}</td></tr>)}</tbody>
    </table>}
    <details><summary>Add channel</summary>
      <ChannelForm key={formKey} initial={emptyChannel} submitLabel="Create channel" pending={create.pending} error={create.error} onSubmit={(fields) => void create.run(async () => {
        await api("POST", `/api/deployments/${deployment.id}/channels`, channelBody(fields));
        setFormKey((value) => value + 1);
        list.reload();
      })} />
    </details>
  </>;
}

function ChannelPage({ id }: { id: string }) {
  const channel = useLoad(() => api<Channel>("GET", `/api/channels/${id}`), [id]);
  const deployment = useLoad(async () => channel.data ? api<DeploymentView>("GET", `/api/deployments/${channel.data.deploymentId}`) : undefined, [channel.data?.deploymentId]);
  const save = useAction();
  const remove = useAction();
  if (!channel.data) return <Loading error={channel.error} />;
  const value = channel.data;
  const timezone = deployment.data?.timezone ?? "UTC";
  return <section>
    <p className="crumbs"><a href="#/">Deployments</a> / {deployment.data ? <a href={`#/deployments/${deployment.data.id}`}>{deployment.data.name}</a> : "…"} /</p>
    <h1>{value.number} · {value.name}</h1>
    <BlocksPanel channel={value} timezone={timezone} />
    <ProgramsPanel channel={value} timezone={timezone} />
    <h2>Channel settings</h2>
    <ChannelForm key={value.version} initial={{ number: String(value.number), name: value.name, callsign: value.callsign, accent: value.accent, description: value.description, enabled: value.enabled, standby: value.standby }} submitLabel="Save channel" pending={save.pending} error={save.error} onSubmit={(fields) => void save.run(async () => {
      await api("PATCH", `/api/channels/${id}`, { ...channelBody(fields), artworkMediaId: value.artworkMediaId }, value.version);
      channel.reload();
    })} />
    <div className="danger"><button className="secondary" disabled={remove.pending} onClick={() => {
      if (!window.confirm(`Delete channel ${value.number} and its schedule?`)) return;
      void remove.run(async () => {
        await api("DELETE", `/api/channels/${id}`, undefined, value.version);
        window.location.hash = `#/deployments/${value.deploymentId}`;
      });
    }}>Delete channel</button><ErrorText message={remove.error} /></div>
  </section>;
}

// Cuelight pickers

function MediaPicker({ value, onChange }: { value: string; onChange: (mediaId: string, media?: CuelightMedia) => void }) {
  const [search, setSearch] = React.useState("");
  const results = useLoad(() => api<{ items: CuelightMedia[] }>("GET", `/api/cuelight/media?search=${encodeURIComponent(search)}`), [search]);
  return <div className="picker">
    <input type="search" placeholder="Search Cuelight media" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
    {!results.data ? <Loading error={results.error} /> : <ul className="media-grid">{results.data.items.map((media) => <li key={media.id}>
      <button type="button" className={media.id === value ? "tile selected" : "tile"} onClick={() => onChange(media.id, media)}>
        <img src={thumbnailUrl(media.id)} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
        <span>{media.title}</span>
        <small>{media.kind === "web" ? "web page" : media.artifact?.mediaType ?? media.kind}</small>
      </button>
    </li>)}</ul>}
  </div>;
}

function PlaylistName({ playlists, id }: { playlists?: CuelightPlaylist[]; id: string }) {
  const playlist = playlists?.find((item) => item.id === id);
  return playlist ? <>{playlist.name}</> : <span className="muted" title={id}>Playlist {id.slice(0, 8)} (not in Cuelight)</span>;
}

/** A Cuelight media reference with its thumbnail and title (or a not-found note). */
function MediaRef({ id }: { id: string }) {
  const media = useLoad(() => api<CuelightMedia>("GET", `/api/cuelight/media/${encodeURIComponent(id)}`), [id]);
  return <span className="media-ref" title={id}><img src={thumbnailUrl(id)} alt="" />{media.data ? media.data.title : media.error ? <span className="muted">Media {id.slice(0, 8)} ({media.error instanceof ApiError && media.error.status === 404 ? "not in Cuelight" : "unavailable"})</span> : id.slice(0, 8)}</span>;
}

// Blocks

interface BlockFields { source: "playlist" | "media"; playlistId: string; mediaId: string; title: string; startsAt: string; endsAt: string }

function blockFields(block?: Block): BlockFields {
  if (!block) {
    const start = new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000);
    return { source: "playlist", playlistId: "", mediaId: "", title: "", startsAt: toLocalInput(start.toISOString()), endsAt: toLocalInput(new Date(start.getTime() + 3_600_000).toISOString()) };
  }
  return { source: block.mediaId ? "media" : "playlist", playlistId: block.playlistId ?? "", mediaId: block.mediaId ?? "", title: block.title, startsAt: toLocalInput(block.startsAt), endsAt: toLocalInput(block.endsAt) };
}

function BlockForm({ initial, playlists, submitLabel, pending, error, onSubmit, onCancel }: { initial: BlockFields; playlists?: CuelightPlaylist[]; submitLabel: string; pending: boolean; error?: string; onSubmit: (body: Record<string, string | undefined>) => void; onCancel?: () => void }) {
  const [fields, setFields] = React.useState(initial);
  const set = (patch: Partial<BlockFields>) => setFields((current) => ({ ...current, ...patch }));
  return <form className="form grid" onSubmit={(event) => {
    event.preventDefault();
    const source = fields.source === "playlist" ? { playlistId: fields.playlistId } : { mediaId: fields.mediaId };
    onSubmit({ ...source, title: fields.title, startsAt: fromLocalInput(fields.startsAt), endsAt: fromLocalInput(fields.endsAt) });
  }}>
    <label>Source<select value={fields.source} onChange={(event) => set({ source: event.currentTarget.value as BlockFields["source"] })}><option value="playlist">Cuelight playlist</option><option value="media">Cuelight media</option></select></label>
    <label>Title<input value={fields.title} placeholder="Shown in the guide" onChange={(event) => set({ title: event.currentTarget.value })} /></label>
    <label>Starts<input required type="datetime-local" value={fields.startsAt} onChange={(event) => set({ startsAt: event.currentTarget.value })} /></label>
    <label>Ends<input required type="datetime-local" value={fields.endsAt} onChange={(event) => set({ endsAt: event.currentTarget.value })} /></label>
    {fields.source === "playlist"
      ? <label className="wide">Playlist<select required value={fields.playlistId} onChange={(event) => {
        const playlistId = event.currentTarget.value;
        set({ playlistId, title: fields.title || (playlists?.find((item) => item.id === playlistId)?.name ?? "") });
      }}><option value="">Choose a playlist…</option>{fields.playlistId && !playlists?.some((item) => item.id === fields.playlistId) && <option value={fields.playlistId}>{fields.playlistId} (not in Cuelight)</option>}{playlists?.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name} · {playlist.items.length} items</option>)}</select></label>
      : <div className="wide"><span className="label">Media{fields.mediaId && <code> {fields.mediaId}</code>}</span><MediaPicker value={fields.mediaId} onChange={(mediaId, media) => set({ mediaId, title: fields.title || (media?.title ?? "") })} /></div>}
    <div className="actions"><button type="submit" disabled={pending || (fields.source === "media" && !fields.mediaId)}>{pending ? "Saving…" : submitLabel}</button>{onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}<ErrorText message={error} /></div>
  </form>;
}

function BlocksPanel({ channel, timezone }: { channel: Channel; timezone: string }) {
  const list = useLoad(() => api<{ items: Block[] }>("GET", `/api/channels/${channel.id}/blocks`), [channel.id]);
  const playlists = useLoad(() => api<{ items: CuelightPlaylist[] }>("GET", "/api/cuelight/playlists"), []);
  const create = useAction();
  const edit = useAction();
  const remove = useAction();
  const [editing, setEditing] = React.useState<string>();
  const [formKey, setFormKey] = React.useState(0);
  const now = Date.now();
  return <>
    <h2>Blocks</h2>
    <p className="muted">Times in {timezone}. A playlist block rotates through the playlist's file items; a media block plays one item for the whole block.</p>
    <ErrorText message={playlists.error && `Cuelight playlists unavailable: ${playlists.error.message}`} />
    {!list.data ? <Loading error={list.error} /> : list.data.items.length === 0 ? <p className="muted">Nothing scheduled.</p> : <table>
      <thead><tr><th>When</th><th>Title</th><th>Source</th><th /></tr></thead>
      <tbody>{list.data.items.map((block) => editing === block.id
        ? <tr key={block.id}><td colSpan={4}><BlockForm initial={blockFields(block)} playlists={playlists.data?.items} submitLabel="Save block" pending={edit.pending} error={edit.error} onCancel={() => setEditing(undefined)} onSubmit={(body) => void edit.run(async () => {
          await api("PATCH", `/api/blocks/${block.id}`, body, block.version);
          setEditing(undefined);
          list.reload();
        })} /></td></tr>
        : <tr key={block.id} className={Date.parse(block.endsAt) < now ? "past" : Date.parse(block.startsAt) <= now ? "live" : undefined}>
          <td>{formatWhen(block.startsAt, timezone)} – {formatWhen(block.endsAt, timezone)}</td>
          <td>{block.title || <span className="muted">Untitled</span>}</td>
          <td>{block.playlistId ? <PlaylistName playlists={playlists.data?.items} id={block.playlistId} /> : <MediaRef id={block.mediaId!} />}</td>
          <td className="row-actions"><button className="link" onClick={() => setEditing(block.id)}>Edit</button><button className="link" disabled={remove.pending} onClick={() => void remove.run(async () => {
            await api("DELETE", `/api/blocks/${block.id}`, undefined, block.version);
            list.reload();
          })}>Delete</button></td>
        </tr>)}</tbody>
    </table>}
    <ErrorText message={remove.error} />
    <details><summary>Add block</summary>
      <BlockForm key={formKey} initial={blockFields()} playlists={playlists.data?.items} submitLabel="Create block" pending={create.pending} error={create.error} onSubmit={(body) => void create.run(async () => {
        await api("POST", `/api/channels/${channel.id}/blocks`, body);
        setFormKey((value) => value + 1);
        list.reload();
      })} />
    </details>
  </>;
}

// Program entries

function ProgramsPanel({ channel, timezone }: { channel: Channel; timezone: string }) {
  const list = useLoad(() => api<{ items: ProgramEntry[] }>("GET", `/api/channels/${channel.id}/programs`), [channel.id]);
  const create = useAction();
  const remove = useAction();
  const [mediaId, setMediaId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [startsAt, setStartsAt] = React.useState("");
  const [endsAt, setEndsAt] = React.useState("");
  return <>
    <h2>Programs</h2>
    <p className="muted">Individual programme entries with their own metadata. The guide plays blocks; programs are kept for authoring.</p>
    {!list.data ? <Loading error={list.error} /> : list.data.items.length === 0 ? <p className="muted">No programs.</p> : <table>
      <thead><tr><th>When</th><th>Title</th><th>Media</th><th /></tr></thead>
      <tbody>{list.data.items.map((program) => <tr key={program.id}>
        <td>{formatWhen(program.startsAt, timezone)} – {formatWhen(program.endsAt, timezone)}</td>
        <td>{program.title || <span className="muted">Untitled</span>}</td>
        <td><MediaRef id={program.mediaId} /></td>
        <td className="row-actions"><button className="link" disabled={remove.pending} onClick={() => void remove.run(async () => {
          await api("DELETE", `/api/programs/${program.id}`, undefined, program.version);
          list.reload();
        })}>Delete</button></td>
      </tr>)}</tbody>
    </table>}
    <ErrorText message={remove.error} />
    <details><summary>Add program</summary>
      <form className="form grid" onSubmit={(event) => {
        event.preventDefault();
        void create.run(async () => {
          await api("POST", `/api/channels/${channel.id}/programs`, { mediaId, title, startsAt: fromLocalInput(startsAt), endsAt: fromLocalInput(endsAt) });
          setMediaId("");
          setTitle("");
          list.reload();
        });
      }}>
        <label>Title<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
        <label>Starts<input required type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.currentTarget.value)} /></label>
        <label>Ends<input required type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.currentTarget.value)} /></label>
        <div className="wide"><span className="label">Media{mediaId && <code> {mediaId}</code>}</span><MediaPicker value={mediaId} onChange={(id, media) => { setMediaId(id); setTitle((current) => current || (media?.title ?? "")); }} /></div>
        <div className="actions"><button type="submit" disabled={create.pending || !mediaId}>{create.pending ? "Saving…" : "Create program"}</button><ErrorText message={create.error} /></div>
      </form>
    </details>
  </>;
}
