import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MaybeOptionalInit } from "openapi-fetch";
import type { PathsWithMethod } from "openapi-typescript-helpers";

import { type LiveStatus, type Reader, type Signal, hostLive, readLive, readsOf } from "../live";
import type { Answer, Api, InitParam } from "../types";

export type { LiveStatus, Signal } from "../live";

let reader: Reader | null = null;
/** One per bundle: each of the page's bundles reads the same relay. */
function pageReader(): Reader {
  reader ??= readLive(window, { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) });
  return reader;
}

/**
 * The page's one socket at `url` (an `x-socket` operation's `api.url`), relayed on `window` for every
 * bundle's readers; mounted once, by the host page. Hidden and visible pause and resume it, `online`
 * retries at once.
 */
export function useLiveSocket(url: URL, handlers: { onUnauthenticated: () => void; onForbidden: () => void }): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  const href = url.href;
  useEffect(() => {
    const socket = hostLive(href, window, {
      connect(at, on) {
        const ws = new WebSocket(at);
        ws.onopen = () => on.open();
        ws.onmessage = (e: MessageEvent) => on.message(e.data);
        ws.onclose = (e: CloseEvent) => on.close(e.code);
        return { close: (code) => ws.close(code) };
      },
      timers: { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) },
      random: Math.random,
      onUnauthenticated: () => latest.current.onUnauthenticated(),
      onForbidden: () => latest.current.onForbidden(),
    });
    const onVisibility = () => (document.visibilityState === "hidden" ? socket.pause() : socket.resume());
    const onOnline = () => socket.nudge();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    socket.start();
    if (document.visibilityState === "hidden") socket.pause();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      socket.stop();
    };
  }, [href]);
}

/** The page's socket as its host tells it; null until it has. */
export function useLiveStatus(): LiveStatus | null {
  const r = pageReader();
  return useSyncExternalStore(r.watch, r.status, () => null);
}

/** A burst (a batch import sends one change per row) is one call, not fifty. */
const DEBOUNCE_MS = 400;

/** Calls `onSignals` with what changed in the tables `answer` read, and on every resync; nothing before there is an answer. */
export function useLive(answer: Response | undefined, onSignals: (signals: readonly Signal[]) => void): void {
  const latest = useRef(onSignals);
  useEffect(() => {
    latest.current = onSignals;
  });
  const topics = answer === undefined ? null : readsOf(answer).join(",");

  useEffect(() => {
    if (topics === null) return;
    let batch: Signal[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = pageReader().follow(topics === "" ? [] : topics.split(","), (signal) => {
      batch.push(signal);
      timer ??= setTimeout(() => {
        timer = null;
        const signals = batch;
        batch = [];
        latest.current(signals);
      }, DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [topics]);
}

type Data<A> = A extends { data: infer D; error?: never } ? D : never;
type Refused<A> = A extends { error: infer E; data?: never } ? E : never;

export type Resource<D, F> = { status: "loading" } | { status: "ok"; data: D } | { status: "error"; failure: F };

type Shown<D, F> = { status: "loading" } | { status: "ok"; data: D; response: Response } | { status: "error"; failure: F };

interface Answered<D, F> {
  key: string;
  group: string;
  tick: number;
  value: Shown<D, F>;
}

/**
 * The GET `path` with `init`, re-read when its URL changes, on `reload`, and on a change of a table its
 * last answer read (`x-sa-reads`); an answer that read none re-reads when the window regains focus. The
 * answer to an earlier URL never overwrites a later one.
 *
 * Stale-while-revalidate: a reload keeps the last answer on screen until the next lands; with `keep`,
 * so does the last answer of the same operation at other params. `fresh` tells the two apart: what must
 * act on the answer asked for waits for it. A re-read nobody asked for is quiet: if it fails, the last
 * answer stays. A broken contract (an answer off its schema) is thrown in render.
 */
export function useResource<Paths extends {}, P extends PathsWithMethod<Paths, "get">, I extends MaybeOptionalInit<Paths[P], "get" & keyof Paths[P]> & { keep?: boolean }>(
  api: Api<Paths>,
  path: P,
  ...init: InitParam<I>
): Resource<Data<Answer<Paths[P]["get" & keyof Paths[P]] & Record<string | number, unknown>, I>>, Refused<Answer<Paths[P]["get" & keyof Paths[P]] & Record<string | number, unknown>, I>>> & {
  reload: () => void;
  fresh: boolean;
} {
  type D = Data<Answer<Paths[P]["get" & keyof Paths[P]] & Record<string | number, unknown>, I>>;
  type F = Refused<Answer<Paths[P]["get" & keyof Paths[P]] & Record<string | number, unknown>, I>>;
  const options = init[0] as ({ params?: object; keep?: boolean } & Record<string, unknown>) | undefined;
  const key = (api.url as (p: string, params?: object) => URL)(String(path), options?.params).href;
  const group = options?.keep ? String(path) : key;

  const [state, setState] = useState<Answered<D, F>>({ key, group, tick: 0, value: { status: "loading" } });
  const [tick, setTick] = useState(0);
  const quiet = useRef(false);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const refresh = useCallback(() => {
    quiet.current = true;
    setTick((n) => n + 1);
  }, []);

  const shownState = state.value.status === "ok" && state.group === group ? state.value : null;
  const answer = shownState?.response;
  useLive(answer, refresh);
  const readNothing = answer !== undefined && readsOf(answer).length === 0;
  useEffect(() => {
    if (!readNothing) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [readNothing, refresh]);

  useEffect(() => {
    let current = true;
    const background = quiet.current;
    quiet.current = false;
    const { keep, ...request } = options ?? {};
    (api.GET as (p: string, i?: object) => Promise<{ data?: D; error?: F; response?: Response }>)(String(path), request).then(
      (a) => {
        if (!current) return;
        if (a.error === undefined) return setState({ key, group, tick, value: { status: "ok", data: a.data as D, response: a.response! } });
        const failure = a.error;
        setState((prev) =>
          background && prev.group === group && prev.value.status === "ok" ? { ...prev, key, tick } : { key, group, tick, value: { status: "error", failure } },
        );
      },
      (broken: unknown) =>
        current &&
        setState(() => {
          throw broken;
        }),
    );
    return () => {
      current = false;
    };
    // `init` is a fresh object every render; `key` (its URL) names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const fresh = state.key === key && state.tick === tick;
  const value: Shown<D, F> = fresh ? state.value : (shownState ?? { status: "loading" });
  if (value.status !== "ok") return { ...value, reload, fresh };
  return { status: "ok", data: value.data, reload, fresh };
}
