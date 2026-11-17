import { describe, expect, it, vi } from "vitest";

import { createApi } from "../src/index";
import document from "./fixtures/notes.json";
import type { paths } from "./fixtures/notes";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function notes(answer: (request: Request) => Response | Promise<Response>) {
  const onUnauthenticated = vi.fn();
  const seen: Request[] = [];
  const api = createApi<paths>({
    document,
    baseUrl: "http://service.test/api/v1",
    onUnauthenticated,
    headers: (method) => (method === "GET" ? {} : { "x-csrf": "t" }),
    fetch: async (input) => {
      const request = input as Request;
      seen.push(request);
      return answer(request);
    },
  });
  return { api, onUnauthenticated, seen };
}

describe("answers", () => {
  it("are the document's", async () => {
    const { api, seen } = notes(() => json(200, { text: "hi" }));
    const note = await api.GET("/notes/{id}", { params: { path: { id: 7 } } });
    expect(note.data).toEqual({ text: "hi" });
    expect(seen[0]!.url).toBe("http://service.test/api/v1/notes/7");
  });

  it("off their schema are a broken contract, not a failure", async () => {
    const { api } = notes(() => json(200, { text: 1 }));
    await expect(api.GET("/notes/{id}", { params: { path: { id: 7 } } })).rejects.toThrow(/notes\/\{id\} 200/);
  });

  it("carry the injected headers", async () => {
    const { api, seen } = notes(() => new Response(null, { status: 204 }));
    await api.PUT("/notes/{id}", { params: { path: { id: 7 } }, body: { text: "x" } });
    await api.GET("/notes/{id}", { params: { path: { id: 7 } } }).catch(() => undefined);
    expect(seen.map((r) => r.headers.get("x-csrf"))).toEqual(["t", null]);
  });
});

describe("refusals", () => {
  it("come back keyed by code", async () => {
    const { api } = notes(() => json(409, { code: "conflict", error: "edited meanwhile" }));
    const set = await api.PUT("/notes/{id}", { params: { path: { id: 7 } }, body: { text: "x" } });
    expect(set.error).toEqual({ code: "conflict", error: "edited meanwhile" });
  });

  it("with a code outside the operation's x-errors, or the wrong status for it, break the contract", async () => {
    await expect(notes(() => json(404, { code: "not_found", error: "" })).api.PUT("/notes/{id}", { params: { path: { id: 7 } }, body: { text: "x" } })).rejects.toThrow(/x-errors has no such code/);
    await expect(notes(() => json(400, { code: "not_found", error: "" })).api.GET("/notes/{id}", { params: { path: { id: 7 } } })).rejects.toThrow(/x-errors has 404/);
  });

  it("401 signs out", async () => {
    const { api, onUnauthenticated } = notes(() => json(401, { code: "unauthenticated", error: "" }));
    expect((await api.GET("/notes/{id}", { params: { path: { id: 7 } } })).error?.code).toBe("unauthenticated");
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });
});

describe("network", () => {
  it("is a dead fetch or a proxy's page", async () => {
    const dead = notes(() => Promise.reject(new TypeError("fetch failed")));
    expect((await dead.api.GET("/notes/{id}", { params: { path: { id: 7 } } })).error).toEqual({ code: "network", error: "fetch failed" });
    const proxied = notes(() => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }));
    expect((await proxied.api.GET("/notes/{id}", { params: { path: { id: 7 } } })).error?.code).toBe("network");
  });

  it("is a code no document may list", () => {
    const listing = structuredClone(document) as { paths: Record<string, Record<string, { "x-errors": Record<string, number> }>> };
    listing.paths["/live"]!["get"]!["x-errors"]["network"] = 503;
    expect(() => createApi<paths>({ document: listing, baseUrl: "/", onUnauthenticated: () => undefined })).toThrow(/client's own code/);
  });
});

describe("url", () => {
  it("fills the path and takes the socket scheme from x-socket", () => {
    const { api } = notes(() => json(200, {}));
    expect(api.url("/notes/{id}", { path: { id: 7 } }).href).toBe("http://service.test/api/v1/notes/7");
    expect(api.url("/live").href).toBe("ws://service.test/api/v1/live");
  });
});

describe("mayCall", () => {
  it("is the operation's x-permission, and any signed-in caller where it names none", () => {
    const { api } = notes(() => json(200, {}));
    expect(api.mayCall("put", "/notes/{id}", ["notes:edit"])).toBe(true);
    expect(api.mayCall("put", "/notes/{id}", ["notes:read"])).toBe(false);
    expect(api.mayCall("get", "/notes/{id}", [])).toBe(true);
  });
});

describe("upload", () => {
  it("sends the operation's one type, or the body's own among several, and refuses one it does not list", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        status = 204;
        responseText = "";
        upload = {};
        onload: (() => void) | null = null;
        open() {}
        setRequestHeader(name: string, value: string) {
          if (name === "content-type") sent.push(value);
        }
        getAllResponseHeaders() {
          return "";
        }
        send() {
          this.onload!();
        }
      },
    );
    const { api } = notes(() => json(200, {}));
    const photo = (type: string) => api.upload("post", "/notes/{id}/photo", { params: { path: { id: 7 } }, body: new Blob(["x"], { type }), onProgress: () => undefined });
    expect((await photo("image/png")).error).toBeUndefined();
    expect(() => photo("image/gif")).toThrow(/takes image\/jpeg, image\/png, not a body of type "image\/gif"/);
    expect(sent).toEqual(["image/png"]);
    vi.unstubAllGlobals();
  });
});
