import { describe, expect, it, vi } from "vitest";

import { type SocketEvents, type Signal, hostLive, readLive } from "../src/live";

function page() {
  const target = new EventTarget();
  const timers = new Map<number, () => void>();
  let next = 0;
  const clock = { set: (fn: () => void) => (timers.set(++next, fn), next), clear: (id: number) => void timers.delete(id) };
  const fire = () => {
    const due = [...timers];
    timers.clear();
    for (const [, fn] of due) fn();
  };
  let socket: SocketEvents | null = null;
  const onUnauthenticated = vi.fn();
  const host = hostLive("ws://x/live", target, {
    connect: (url, on) => {
      expect(url).toBe("ws://x/live");
      socket = on;
      return { close: () => undefined };
    },
    timers: clock,
    random: () => 0,
    onUnauthenticated,
    onForbidden: () => undefined,
  });
  const reader = readLive(target, clock);
  const heard: Signal[] = [];
  reader.follow(["notes.notes"], (s) => heard.push(s));
  const send = (message: object) => socket!.message(JSON.stringify(message));
  return { target, clock, host, reader, heard, send, socket: () => socket!, fire, onUnauthenticated };
}

describe("a reader", () => {
  it("hears changes on the tables it read, and only those", () => {
    const p = page();
    p.host.start();
    p.socket().open();
    p.send({ type: "hello", at: "t", user_id: "u" });
    p.send({ type: "changed", topic: "notes.notes", id: "7", at: "t" });
    p.send({ type: "changed", topic: "notes.tags", at: "t" });
    p.send({ type: "resync" });
    expect(p.heard).toEqual([{ type: "changed", topic: "notes.notes", id: "7", at: "t" }, { type: "resync" }]);
  });

  it("re-reads when the socket is back after a drop, not on the first open", () => {
    const p = page();
    p.host.start();
    p.socket().open();
    expect(p.heard).toEqual([]);
    p.socket().close(1006);
    p.fire();
    p.socket().open();
    expect(p.heard).toEqual([{ type: "resync" }]);
  });

  it("learns the status from a host that started before it", () => {
    const p = page();
    p.host.start();
    p.socket().open();
    expect(readLive(p.target, p.clock).status()).toBe("live");
    expect(readLive(new EventTarget(), p.clock).status()).toBeNull();
  });

  it("is told the session ended on 4401, and nothing reconnects", () => {
    const p = page();
    p.host.start();
    p.socket().open();
    p.socket().close(4401);
    expect(p.onUnauthenticated).toHaveBeenCalledOnce();
    expect(p.reader.status()).toBe("closed");
  });
});
