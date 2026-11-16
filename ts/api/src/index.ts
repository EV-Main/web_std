import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import createClient, { createFinalURL, createQuerySerializer, defaultPathSerializer } from "openapi-fetch";
import type { Api, Network } from "./types";

export type { Api, Failure, Network } from "./types";

interface ApiOptions {
  /** The service's OpenAPI document, the one `Paths` is generated from. */
  document: object;
  /** Where the document's paths are mounted (`/api/v1`); relative to the page when not absolute. */
  baseUrl: string;
  /** A 401: the session is gone. */
  onUnauthenticated: () => void;
  /** Sent with every request of `method` (a write's CSRF token, say). */
  headers?: (method: string) => Record<string, string>;
  fetch?: typeof fetch;
}

interface Operation {
  responses: Record<string, { content?: Record<string, unknown> }>;
  requestBody?: { content: Record<string, unknown> };
  "x-errors": Record<string, number>;
  "x-socket"?: unknown;
  "x-permission"?: unknown;
}

const NETWORK = "network";
const PROXIED = new Set([502, 503, 504]);

class Unreachable extends Error {}

function operations(document: object): Map<string, Operation> {
  const paths = (document as { paths?: Record<string, Record<string, unknown>> }).paths;
  if (typeof paths !== "object" || paths === null) throw new Error("api: the document has no paths");
  const ops = new Map<string, Operation>();
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === "parameters" || method === "summary" || method === "description" || method === "servers") continue;
      const errors = (op as Partial<Operation>)["x-errors"];
      if (typeof errors !== "object" || errors === null) throw new Error(`api: ${method.toUpperCase()} ${path} has no x-errors`);
      if (NETWORK in errors) throw new Error(`api: ${method.toUpperCase()} ${path} lists "${NETWORK}", the client's own code`);
      ops.set(`${method.toUpperCase()} ${path}`, op as Operation);
    }
  }
  return ops;
}

function isJson(response: Response): boolean {
  return /^application\/([\w.+-]*\+)?json\b/.test(response.headers.get("content-type") ?? "");
}

export function createApi<Paths extends {}>(options: ApiOptions): Api<Paths> {
  const ops = operations(options.document);
  // A cast would only promise the shape: every answer is checked against the same document the types come from.
  const ajv = new Ajv2020({ strict: false, validateFormats: false, validateSchema: false });
  ajv.addSchema(options.document, "api");
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));

  const operation = (method: string, path: string): Operation => {
    const op = ops.get(`${method} ${path}`);
    if (!op) throw new Error(`api: the document has no ${method} ${path}`);
    return op;
  };

  const schema = (method: string, path: string, status: string): ValidateFunction | null => {
    if (!operation(method, path).responses[status]?.content?.["application/json"]) return null;
    const pointer = ["paths", path, method.toLowerCase(), "responses", status, "content", "application/json", "schema"]
      .map((p) => encodeURIComponent(p.replaceAll("~", "~0").replaceAll("/", "~1")))
      .join("/");
    const validate = ajv.getSchema(`api#/${pointer}`);
    if (!validate) throw new Error(`api: ${method} ${path} ${status}: the document's schema does not compile`);
    return validate;
  };

  const validated = (method: string, path: string, status: string, body: unknown, what: string) => {
    const validate = schema(method, path, status);
    if (!validate) throw new Error(`api: ${method} ${path} answered ${what} the document does not describe`);
    if (!validate(body)) throw new Error(`api: ${method} ${path} ${status}: ${ajv.errorsText(validate.errors)}`);
  };

  /** Throws on anything the document does not allow; `Unreachable` when the service did not answer. */
  async function check(method: string, path: string, response: Response): Promise<void> {
    const status = String(response.status);
    if (response.ok) {
      if (response.status === 204 || !isJson(response)) return;
      validated(method, path, status, await response.clone().json(), `JSON for ${status}`);
      return;
    }
    if (!isJson(response)) {
      if (PROXIED.has(response.status)) throw new Unreachable(`${response.status} from in front of the service`);
      throw new Error(`api: ${method} ${path} refused with ${status} and no JSON body`);
    }
    const body: unknown = await response.clone().json();
    const op = operation(method, path);
    validated(method, path, op.responses[status] ? status : "default", body, `a refusal ${status}`);
    const code = (body as { code: unknown }).code;
    if (typeof code !== "string") throw new Error(`api: ${method} ${path} ${status}: a refusal without a code`);
    const listed = op["x-errors"][code];
    if (listed !== response.status) throw new Error(`api: ${method} ${path} refused with ${code} ${status}; x-errors has ${listed ?? "no such code"}`);
    if (response.status === 401) options.onUnauthenticated();
  }

  const client = createClient<Paths>({
    baseUrl: options.baseUrl,
    fetch: (request) => fetchFn(request),
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  client.use({
    onRequest({ request }) {
      for (const [k, v] of Object.entries(options.headers?.(request.method) ?? {})) request.headers.set(k, v);
    },
    async onResponse({ request, response, schemaPath }) {
      await check(request.method, schemaPath, response);
    },
    onError: ({ error }) => new Unreachable(error instanceof Error ? error.message : String(error)),
  });

  const network = (e: unknown) => {
    if (e instanceof Unreachable) return { error: { code: NETWORK, error: e.message } satisfies Network };
    throw e;
  };
  const method =
    (m: "GET" | "POST" | "PUT" | "PATCH" | "DELETE") =>
    (path: string, init?: object) =>
      (client[m] as (p: string, i?: object) => Promise<unknown>)(path, init).catch(network);

  const querySerializer = createQuerySerializer();
  const resolve = (path: string, params: object | undefined) =>
    new URL(createFinalURL(path, { baseUrl: options.baseUrl, params: params ?? {}, querySerializer, pathSerializer: defaultPathSerializer }), globalThis.location?.href);

  return {
    GET: method("GET"),
    POST: method("POST"),
    PUT: method("PUT"),
    PATCH: method("PATCH"),
    DELETE: method("DELETE"),
    mayCall(method: string, path: string, permissions: readonly string[]) {
      const needs = operation(method.toUpperCase(), path)["x-permission"];
      if (needs === undefined) return true;
      if (typeof needs !== "string") throw new Error(`api: ${method.toUpperCase()} ${path}: x-permission is not a permission`);
      return permissions.includes(needs);
    },
    url(path: string, params?: object) {
      const url = resolve(path, params);
      if (operation("GET", path)["x-socket"] !== undefined) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url;
    },
    upload(m: string, path: string, { params, body, onProgress }: { params: object; body: Blob; onProgress: (sent: number) => void }) {
      const method = m.toUpperCase();
      const types = Object.keys(operation(method, path).requestBody?.content ?? {});
      if (types.length !== 1) throw new Error(`api: ${method} ${path} takes ${types.length} body types; an upload needs exactly one`);
      return new Promise((done, fail) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, resolve(path, params));
        xhr.setRequestHeader("content-type", types[0]!);
        xhr.setRequestHeader("accept", "application/json");
        for (const [k, v] of Object.entries(options.headers?.(method) ?? {})) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
        xhr.onerror = () => done({ error: { code: NETWORK, error: "the upload got no answer" } satisfies Network });
        xhr.onload = () => {
          const headers = new Headers();
          for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
            const at = line.indexOf(":");
            if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
          }
          const response = new Response(xhr.status === 204 ? null : xhr.responseText, { status: xhr.status, headers });
          check(method, path, response)
            .then(async () => {
              const json = response.status !== 204 && isJson(response) ? await response.json() : undefined;
              done(response.ok ? { data: json, response } : { error: json, response });
            })
            .catch((e: unknown) => {
              try {
                done(network(e));
              } catch (broken) {
                fail(broken);
              }
            });
        };
        xhr.send(body);
      });
    },
  } as Api<Paths>;
}
