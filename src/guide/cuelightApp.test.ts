import { describe, expect, it } from "vitest";
import { AppAuthError, CableServerSource, CuelightApp, GuideLinkError, mediaSources, readGuideSession } from "./cuelightApp";
import { loadPresentation, presentationFixture } from "./presentation";
import { globalRemoteAction } from "./remoteActions";
import { runtimeReducer, initialRuntimeState } from "./state";

function fakeHistory() {
  const calls: string[] = [];
  return { calls, state: { key: "x" }, replaceState(_data: unknown, _unused: string, url?: string | URL | null) { calls.push(String(url)); } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("guide session", () => {
  it("reads the deployment and Cuelight app access, then strips the fragment", () => {
    const history = fakeHistory();
    const session = readGuideSession({ pathname: "/guide/", search: "?deployment=dep-1", hash: "#cuelight-token=abc%2Bdef&cuelight-api=https%3A%2F%2Fcue.example%3A8454%2Fapi%2Fv1" }, history);
    expect(session.deploymentId).toBe("dep-1");
    expect([session.app?.token, session.app?.api]).toEqual(["abc+def", "https://cue.example:8454/api/v1"]);
    expect(history.calls).toEqual(["/guide/?deployment=dep-1"]);
  });

  it("falls back to preview mode without both fragment values and still strips the fragment", () => {
    const history = fakeHistory();
    expect(readGuideSession({ pathname: "/guide/", search: "?deployment=dep-1", hash: "#cuelight-token=abc" }, history).app).toBeUndefined();
    expect(history.calls).toEqual(["/guide/?deployment=dep-1"]);
    expect(readGuideSession({ pathname: "/guide/", search: "?deployment=dep-1", hash: "" }, fakeHistory()).app).toBeUndefined();
  });

  it("rejects links without a deployment", () => {
    expect(() => readGuideSession({ pathname: "/guide/", search: "", hash: "#cuelight-token=abc&cuelight-api=x" }, fakeHistory())).toThrow(GuideLinkError);
  });
});

describe("app token renewal", () => {
  it("renews with the current token and adopts the successor", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const app = new CuelightApp("old", "https://cue.example/api/v1", async (input, init) => {
      requests.push({ url: String(input), init });
      return json({ token: "new", expiresAt, apiUrl: "https://cue.example/api/v1" });
    });
    expect(app.renewDelay()).toBe(60 * 60_000);
    await app.renew();
    expect(requests[0]?.url).toBe("https://cue.example/api/v1/app/token:renew");
    expect(requests[0]?.init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer old" } });
    expect(app.token).toBe("new");
    expect(app.mediaUrl("m", "content")).toContain("access_token=new");
    expect(app.renewDelay(Date.parse(expiresAt) - 60 * 60_000)).toBe(50 * 60_000);
    expect(app.renewDelay(Date.parse(expiresAt))).toBe(0);
  });

  it("treats a rejected renewal as lost access but keeps the token after a transient failure", async () => {
    const rejected = new CuelightApp("old", "https://cue.example/api/v1", async () => new Response(null, { status: 401 }));
    await expect(rejected.renew()).rejects.toBeInstanceOf(AppAuthError);
    expect(rejected.error).toBeInstanceOf(AppAuthError);
    const flaky = new CuelightApp("old", "https://cue.example/api/v1", async () => new Response(null, { status: 503 }));
    await expect(flaky.renew()).rejects.not.toBeInstanceOf(AppAuthError);
    expect([flaky.error, flaky.token]).toEqual([undefined, "old"]);
  });
});

describe("media sources", () => {
  const media = presentationFixture.occurrences[0]!.media;

  it("plays from the Cuelight app API with the token as access_token", () => {
    const app = new CuelightApp("tok en", "https://cue.example/api/v1/");
    expect(mediaSources(app, media)).toEqual({
      src: "https://cue.example/api/v1/app/media/media-signal-sea/content?access_token=tok%20en",
      poster: "https://cue.example/api/v1/app/media/media-signal-sea/thumbnail?access_token=tok%20en",
    });
  });

  it("shows only the Cable server thumbnail in preview mode or after the token was rejected", () => {
    expect(mediaSources(undefined, media)).toEqual({ poster: "/api/media/media-signal-sea/thumbnail" });
    const app = new CuelightApp("expired", "https://cue.example/api/v1");
    app.reject();
    expect(mediaSources(app, media).src).toBeUndefined();
  });

  it("frames web pages at their own URL with or without an app token", () => {
    const web = { kind: "web" as const, mediaId: "turf", url: "https://turf.example:8465/?seed=3" };
    expect(mediaSources(undefined, web)).toEqual({ src: web.url, poster: "/api/media/turf/thumbnail" });
    expect(mediaSources(new CuelightApp("tok", "https://cue.example/api/v1"), web)).toEqual({ src: web.url, poster: "https://cue.example/api/v1/app/media/turf/thumbnail?access_token=tok" });
  });

  it("rejects web media that is not an http(s) page", async () => {
    const occurrence = presentationFixture.occurrences[0]!;
    const withMedia = (url: string) => ({ ...presentationFixture, occurrences: [{ ...occurrence, media: { kind: "web", mediaId: "page", url } }] });
    await expect(loadPresentation({ read: async () => withMedia("https://turf.example/") })).resolves.toBeDefined();
    await expect(loadPresentation({ read: async () => withMedia("javascript:alert(1)") })).rejects.toThrow("invalid presentation");
  });
});

describe("Cable server presentation source", () => {
  it("reads the deployment's live presentation", async () => {
    let url = "";
    const source = new CableServerSource("dep 1", async (input) => {
      url = String(input);
      return json(presentationFixture);
    });
    const presentation = await loadPresentation(source);
    expect(url).toBe("/api/deployments/dep%201/presentation");
    expect(presentation.occurrences[0]?.media.mediaId).toBe("media-signal-sea");
  });

  it("reports a deleted deployment as a broken link and other failures as retryable", async () => {
    await expect(loadPresentation(new CableServerSource("gone", async () => json({ error: "not found" }, 404)))).rejects.toBeInstanceOf(GuideLinkError);
    const transient = loadPresentation(new CableServerSource("dep", async () => json({ error: "bad gateway" }, 502)));
    await expect(transient).rejects.toThrow("HTTP 502");
    await expect(transient).rejects.not.toBeInstanceOf(GuideLinkError);
  });
});

describe("remote events", () => {
  it("long-polls the Cuelight app API and maps the page", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const app = new CuelightApp("tok", "https://cue.example/api/v1", async (input, requestInit) => {
      url = String(input);
      init = requestInit;
      return json({ events: [{ sequence: 5, type: "key", key: "Guide" }], nextSequence: 5, remote: { url: "https://cue.example/r/2", showQr: true, expiresAt: new Date().toISOString() } });
    });
    const page = await app.remoteEvents(4, 25, new AbortController().signal);
    expect(url).toBe("https://cue.example/api/v1/app/remote/events?after=4&waitSeconds=25");
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", headers: { Authorization: "Bearer tok" } });
    expect(page.next).toBe(5);
    expect(page.events.map((event) => event.key)).toEqual(["Guide"]);
    expect(page.remote?.url).toBe("https://cue.example/r/2");
  });

  it("treats a rejected app token as lost access", async () => {
    const app = new CuelightApp("expired", "https://cue.example/api/v1", async () => new Response(null, { status: 401 }));
    await expect(app.remoteEvents(0, 0, new AbortController().signal)).rejects.toBeInstanceOf(AppAuthError);
    expect(app.error).toBeInstanceOf(AppAuthError);
  });

  it("maps remote keys to guide actions", () => {
    const now = Date.parse(presentationFixture.occurrences[0]!.startsAt) + 1;
    const live = { ...presentationFixture, occurrences: presentationFixture.occurrences.map((occurrence) => ({ ...occurrence, startsAt: new Date(now - 1).toISOString(), endsAt: new Date(now + 60_000).toISOString() })) };
    const ready = runtimeReducer(initialRuntimeState, { type: "SYNC_REVISION", presentation: live });
    expect(globalRemoteAction(live, ready, "Guide", now)).toEqual({ type: "guide" });
    expect(globalRemoteAction(live, ready, "ChannelNumber:2", now)).toMatchObject({ type: "tune", occurrence: { channelId: "channel-2" } });
    expect(globalRemoteAction(live, ready, "ChannelDown", now)).toMatchObject({ type: "tune", occurrence: { channelId: "channel-2" } });
    const playing = runtimeReducer(ready, { type: "TUNE_LIVE", occurrence: live.occurrences[1]! });
    expect(globalRemoteAction(live, playing, "ChannelDown", now)).toMatchObject({ type: "tune", occurrence: { channelId: "channel-1" } });
    expect(globalRemoteAction(live, ready, "ChannelNumber:2", now + 120_000)).toEqual({ type: "off-air" });
    expect(globalRemoteAction(live, ready, "ArrowDown", now)).toBeUndefined();
    expect(globalRemoteAction(live, ready, "ChannelNumber:9", now)).toBeUndefined();
  });
});
