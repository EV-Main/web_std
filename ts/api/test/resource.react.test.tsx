import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApi } from "../src/index";
import { type SocketEvents, hostLive } from "../src/live";
import { useResource } from "../src/react/index";
import document from "./fixtures/notes.json";
import type { paths } from "./fixtures/notes";

// What each note's answer says it read.
const READS: Record<string, string> = { "1": "notes.notes", "2": "notes.tags", "3": "" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useResource", () => {
  it("re-reads on a change of a table its answer read, and only then", async () => {
    const reads: string[] = [];
    const api = createApi<paths>({
      document,
      baseUrl: "http://service.test",
      onUnauthenticated: () => undefined,
      fetch: async (input) => {
        const id = new URL((input as Request).url).pathname.split("/").pop()!;
        reads.push(id);
        return new Response(JSON.stringify({ text: `note ${id}` }), { headers: { "content-type": "application/json", "x-sa-reads": READS[id]! } });
      },
    });
    let socket: SocketEvents | null = null;
    const host = hostLive("ws://service.test/live", window, {
      connect: (url, on) => {
        expect(url).toBe("ws://service.test/live");
        socket = on;
        return { close: () => undefined };
      },
      timers: { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) },
      random: () => 0,
      onUnauthenticated: () => undefined,
      onForbidden: () => undefined,
    });
    host.start();
    socket!.open();

    function Note({ id }: { id: number }) {
      const note = useResource(api, "/notes/{id}", { params: { path: { id } } });
      return <p>{note.status === "ok" ? note.data.text : note.status}</p>;
    }
    const container = window.document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <>
          <Note id={1} />
          <Note id={2} />
          <Note id={3} />
        </>,
      );
      await vi.runAllTimersAsync();
    });
    expect(container.textContent).toBe("note 1note 2note 3");
    expect(reads.sort()).toEqual(["1", "2", "3"]);

    reads.length = 0;
    await act(async () => {
      socket!.message(JSON.stringify({ type: "changed", topic: "notes.notes", at: "t" }));
      socket!.message(JSON.stringify({ type: "changed", topic: "notes.notes", at: "t" }));
      socket!.message(JSON.stringify({ type: "changed", topic: "other.notes", at: "t" }));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(reads).toEqual(["1"]);

    reads.length = 0;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(reads).toEqual(["3"]);

    act(() => root.unmount());
    host.stop();
  });
});
