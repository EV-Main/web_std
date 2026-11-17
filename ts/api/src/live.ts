/**
 * - `connecting` — the first attempt;
 * - `live` — a socket is open;
 * - `reconnecting` — it dropped (or never opened) and the next attempt is scheduled;
 * - `offline` — several attempts in a row never opened, while the attempts go on;
 * - `paused` — the tab is hidden and no socket is open: nothing is attempted;
 * - `closed` — stopped, or the server ended the session for good.
 */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline" | "paused" | "closed";
const STATUSES: readonly LiveStatus[] = ["connecting", "live", "reconnecting", "offline", "paused", "closed"];

/** What a reader hears: a change on a table it read (`<service>.<table>`), or "re-read" (a `resync`, a reconnect, a poll while offline). */
export type Signal = { type: "changed"; topic: string; at: string; brand_id?: string; id?: string } | { type: "resync" };

/** A server frame as it came: relayed untouched, readers take what they know. */
type Message = { type: string } & Record<string, unknown>;

/** The session is gone, as on an HTTP 401. */
const CLOSE_UNAUTHENTICATED = 4401;
/** Access was withdrawn: reconnecting would only be refused again. */
const CLOSE_FORBIDDEN = 4403;

// The page's one socket, as every bundle on it hears it.
const LIVE_EVENT = "ev:live";
const LIVE_STATUS_EVENT = "ev:live-status";
const LIVE_STATUS_REQUEST_EVENT = "ev:live-status-request";

const READS_HEADER = "x-sa-reads";
const TOPIC = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/** The tables an answer read; every GET answer says, an empty header when it read none. */
export function readsOf(response: Response): readonly string[] {
  const header = response.headers.get(READS_HEADER);
  if (header === null) throw new Error(`live: ${response.url} answered without ${READS_HEADER}`);
  const topics = header.split(",").map((t) => t.trim()).filter((t) => t !== "");
  for (const t of topics) if (!TOPIC.test(t)) throw new Error(`live: ${READS_HEADER} names "${t}", not <service>.<table>`);
  return topics;
}

function parseMessage(data: unknown): Message {
  if (typeof data !== "string") throw new Error("live: a binary frame");
  const body: unknown = JSON.parse(data);
  if (typeof body !== "object" || body === null || !("type" in body) || typeof body.type !== "string") throw new Error(`live: a frame without a type: ${data}`);
  return body as Message;
}

function signalOf(message: Message): Signal | null {
  if (message.type === "resync") return { type: "resync" };
  if (message.type !== "changed") return null;
  const { topic, at, brand_id, id } = message;
  if (typeof topic !== "string" || typeof at !== "string") throw new Error(`live: a change without topic or at: ${JSON.stringify(message)}`);
  for (const [k, v] of [["brand_id", brand_id], ["id", id]] as const) if (v !== undefined && typeof v !== "string") throw new Error(`live: ${k} is not a string: ${JSON.stringify(message)}`);
  return { type: "changed", topic, at, ...(brand_id === undefined ? {} : { brand_id: brand_id as string }), ...(id === undefined ? {} : { id: id as string }) };
}

/**
 * The wait before reconnect attempt `attempt` (0-based): exponential, capped, half of it certain and
 * half at random, so a server restart does not get every open tab back in the same millisecond.
 */
export function backoffDelay(attempt: number, random: () => number, baseMs = 1_000, capMs = 30_000): number {
  const step = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(step / 2 + random() * (step / 2));
}

export interface SocketEvents {
  open(): void;
  message(data: unknown): void;
  close(code: number): void;
}

/** Opens a socket that reports through `on`; a refused upgrade (429, 404) is a close without an open. */
export type Connect = (url: string, on: SocketEvents) => { close(code?: number): void };

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface Host {
  connect: Connect;
  timers: Timers;
  random: () => number;
  onUnauthenticated(): void;
  onForbidden(): void;
}

export interface LiveSocket {
  start(): void;
  stop(): void;
  /** The tab went hidden. */
  pause(): void;
  /** The tab is visible again. */
  resume(): void;
  /** The network is back: try now rather than at the next backoff step. */
  nudge(): void;
}

const FAILURES_BEFORE_OFFLINE = 3;

/**
 * The page's one socket, kept up and relayed on `target` for every bundle's readers. A hidden tab
 * keeps an open socket but makes no attempts while it has none; becoming visible reconnects at once.
 */
export function hostLive(url: string, target: EventTarget, host: Host): LiveSocket {
  const { timers } = host;
  let status: LiveStatus = "closed";
  const tell = () => target.dispatchEvent(new CustomEvent(LIVE_STATUS_EVENT, { detail: { status } }));
  target.addEventListener(LIVE_STATUS_REQUEST_EVENT, tell);

  let socket: { close(code?: number): void } | null = null;
  // Each socket's handlers check this, so a socket closed on purpose cannot report into a newer one's state.
  let generation = 0;
  let attempt = 0;
  let failures = 0;
  let hidden = false;
  let ended = false;
  let retry: number | null = null;

  const set = (next: LiveStatus) => {
    if (status === next) return;
    status = next;
    tell();
  };
  const clearRetry = () => {
    if (retry !== null) timers.clear(retry);
    retry = null;
  };
  const drop = () => {
    generation += 1;
    socket?.close(1000);
    socket = null;
  };
  const end = () => {
    ended = true;
    clearRetry();
    drop();
    set("closed");
    target.removeEventListener(LIVE_STATUS_REQUEST_EVENT, tell);
  };

  function connect() {
    clearRetry();
    drop();
    const mine = ++generation;
    let opened = false;
    const ours = () => mine === generation && !ended;
    socket = host.connect(url, {
      open() {
        if (!ours()) return;
        opened = true;
        attempt = 0;
        failures = 0;
        set("live");
      },
      message(data) {
        if (ours()) target.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: parseMessage(data) }));
      },
      close(code) {
        if (!ours()) return;
        socket = null;
        if (code === CLOSE_UNAUTHENTICATED || code === CLOSE_FORBIDDEN) {
          end();
          if (code === CLOSE_UNAUTHENTICATED) host.onUnauthenticated();
          else host.onForbidden();
          return;
        }
        if (!opened) failures += 1;
        if (hidden) return set("paused");
        set(failures >= FAILURES_BEFORE_OFFLINE ? "offline" : "reconnecting");
        retry = timers.set(connect, backoffDelay(attempt, host.random));
        attempt += 1;
      },
    });
  }

  return {
    start() {
      if (ended || status !== "closed") return;
      set("connecting");
      connect();
    },
    stop() {
      if (!ended) end();
    },
    pause() {
      hidden = true;
      if (ended || status === "live") return;
      clearRetry();
      drop();
      set("paused");
    },
    resume() {
      hidden = false;
      if (ended || status !== "paused") return;
      attempt = 0;
      set(failures >= FAILURES_BEFORE_OFFLINE ? "offline" : "reconnecting");
      connect();
    },
    nudge() {
      if (ended || hidden || (status !== "reconnecting" && status !== "offline")) return;
      attempt = 0;
      connect();
    },
  };
}

/** While the socket cannot be had, readers re-read on this period instead. */
const POLL_MS = 60_000;

export interface Reader {
  /** Null until the host has told it: a bundle may load after the socket's last change. */
  status(): LiveStatus | null;
  watch(listener: () => void): () => void;
  /** `on` hears a change on one of `topics`, and every resync. */
  follow(topics: readonly string[], on: (signal: Signal) => void): () => void;
}

/** The socket as relayed on `target`: a reconnect after a drop re-reads everything (changes were missed), and so does every minute offline. */
export function readLive(target: EventTarget, timers: Timers): Reader {
  let status: LiveStatus | null = null;
  let poll: number | null = null;
  const watchers = new Set<() => void>();
  const followers = new Set<{ topics: ReadonlySet<string>; on: (signal: Signal) => void }>();
  const emit = (signal: Signal) => {
    // A copy: a follower may leave (a screen unmounting) while being told.
    for (const f of [...followers]) if (signal.type === "resync" || f.topics.has(signal.topic)) f.on(signal);
  };

  target.addEventListener(LIVE_EVENT, (e) => {
    const signal = signalOf((e as CustomEvent<Message>).detail);
    if (signal) emit(signal);
  });
  target.addEventListener(LIVE_STATUS_EVENT, (e) => {
    const next = (e as CustomEvent<{ status: unknown }>).detail.status as LiveStatus;
    if (!STATUSES.includes(next)) throw new Error(`live: a status "${String(next)}"`);
    const was = status;
    status = next;
    if (next === "live" && was !== null && was !== "connecting" && was !== "live") emit({ type: "resync" });
    if (next === "offline" && poll === null) poll = timers.set(function tick() {
      emit({ type: "resync" });
      poll = timers.set(tick, POLL_MS);
    }, POLL_MS);
    if (next !== "offline" && poll !== null) {
      timers.clear(poll);
      poll = null;
    }
    for (const w of [...watchers]) w();
  });
  target.dispatchEvent(new CustomEvent(LIVE_STATUS_REQUEST_EVENT));

  return {
    status: () => status,
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    follow(topics, on) {
      const follower = { topics: new Set(topics), on };
      followers.add(follower);
      return () => followers.delete(follower);
    },
  };
}
