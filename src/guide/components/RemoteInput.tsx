import * as React from "react";
import QRCode from "qrcode";
import { AppAuthError, type CuelightApp, type RemoteDescriptor, type RemoteEvent } from "../cuelightApp";

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  window.setTimeout(resolve, milliseconds);
  return promise;
}

export function RemoteQRCode({ url }: { url: string }) {
  const [source, setSource] = React.useState("");
  React.useEffect(() => {
    let active = true;
    void QRCode.toDataURL(url, { width: 220, margin: 1, color: { dark: "#07152e", light: "#f4fbff" } }).then((value) => { if (active) setSource(value); });
    return () => { active = false; };
  }, [url]);
  return source ? <aside className="qr-card"><span>Remote</span><img src={source} alt="Scan to open this screen's remote" /></aside> : null;
}

/**
 * Long-polls the screen's remote events through the Cuelight app API. The
 * first poll only learns the current sequence so stale presses are not
 * replayed. When a phone-remote session is active the page carries its
 * descriptor, which `onRemote` receives (for the QR code).
 */
export function useRemoteInput(app: CuelightApp | undefined, onEvent: (event: RemoteEvent) => void, onRemote?: (remote: RemoteDescriptor) => void, onAuthError?: (error: AppAuthError) => void) {
  const handlers = React.useRef({ onEvent, onRemote, onAuthError });
  React.useEffect(() => { handlers.current = { onEvent, onRemote, onAuthError }; }, [onEvent, onRemote, onAuthError]);
  React.useEffect(() => {
    if (!app) return;
    const controller = new AbortController();
    let after = 0;
    let initialized = false;
    let remoteURL: string | undefined;
    const poll = async () => {
      while (!controller.signal.aborted) {
        try {
          const page = await app.remoteEvents(after, initialized ? 25 : 0, controller.signal);
          after = page.next;
          if (page.remote?.url && page.remote.url !== remoteURL) {
            remoteURL = page.remote.url;
            handlers.current.onRemote?.(page.remote);
          }
          if (!initialized) {
            initialized = true;
            continue;
          }
          for (const event of page.events) {
            handlers.current.onEvent(event);
            await delay(75);
          }
        } catch (error) {
          if (error instanceof AppAuthError) {
            handlers.current.onAuthError?.(error);
            return;
          }
          if (!controller.signal.aborted) await delay(1_000);
        }
      }
    };
    void poll();
    return () => controller.abort();
  }, [app]);
}

const keyboardKeys: Record<string, string> = {
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Enter: "Enter",
  Escape: "Escape",
  Backspace: "Backspace",
  PageUp: "ChannelUp",
  PageDown: "ChannelDown",
  g: "Guide",
  G: "Guide",
  m: "Mute",
  M: "Mute",
  "+": "VolumeUp",
  "=": "VolumeUp",
  "-": "VolumeDown",
};

/**
 * Keyboard stand-in for the remote (local testing): arrows/Enter/Escape,
 * PageUp/PageDown for channel up/down, G for the guide, M and +/- for audio,
 * and typed digits for a channel number (committed after a short pause).
 */
export function useKeyboardRemote(onEvent: (event: RemoteEvent) => void) {
  const handler = React.useRef(onEvent);
  React.useEffect(() => { handler.current = onEvent; }, [onEvent]);
  React.useEffect(() => {
    let digits = "";
    let timer: number | undefined;
    let sequence = 0;
    const emit = (key: string) => handler.current({ sequence: --sequence, type: "key", key });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        digits = `${digits}${event.key}`.slice(-3);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          emit(`ChannelNumber:${Number(digits)}`);
          digits = "";
        }, 900);
        return;
      }
      const key = keyboardKeys[event.key];
      if (!key) return;
      event.preventDefault();
      emit(key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(timer);
    };
  }, []);
}
