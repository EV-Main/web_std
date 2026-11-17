import type { FetchResponse, MaybeOptionalInit } from "openapi-fetch";
import type { ErrorResponse, HttpMethod, MediaType, PathsWithMethod, RequiredKeysOf, ResponseObjectMap } from "openapi-typescript-helpers";

/** The request never got an answer from the service: fetch failed, or a proxy answered for it (a 502 page during a restart). */
export interface Network {
  code: "network";
  error: string;
}

/** Every refusal any operation of `Paths` can answer, and `Network`: what a screen showing any failure takes. */
export type Failure<Paths extends {}> = Refusals<Paths> | Network;

type Refusals<Paths> = {
  [P in keyof Paths]: {
    [M in keyof Paths[P] & HttpMethod]: Paths[P][M] extends Record<string | number, unknown> ? ErrorResponse<ResponseObjectMap<Paths[P][M]>, MediaType> : never;
  }[keyof Paths[P] & HttpMethod];
}[keyof Paths];

export type InitParam<I> = RequiredKeysOf<I> extends never ? [(I & { [key: string]: unknown })?] : [I & { [key: string]: unknown }];

export type Answer<Op extends Record<string | number, unknown>, I> = FetchResponse<Op, I, MediaType> | { data?: never; error: Network; response?: never };

type Method<Paths extends {}, M extends HttpMethod> = <P extends PathsWithMethod<Paths, M>, I extends MaybeOptionalInit<Paths[P], M & keyof Paths[P]>>(
  path: P,
  ...init: InitParam<I>
) => Promise<Answer<Paths[P][M & keyof Paths[P]] & Record<string | number, unknown>, I>>;

export type Params<Op> = Op extends { parameters: infer X } ? X : never;
type ParamsParam<Op> = RequiredKeysOf<Params<Op>> extends never ? [Params<Op>?] : [Params<Op>];

export interface Api<Paths extends {}> {
  GET: Method<Paths, "get">;
  POST: Method<Paths, "post">;
  PUT: Method<Paths, "put">;
  PATCH: Method<Paths, "patch">;
  DELETE: Method<Paths, "delete">;
  /** A raw body over XHR, for its progress (a fraction sent); its content type the operation's one, or the body's own where it lists several. */
  upload<M extends "put" | "post", P extends PathsWithMethod<Paths, M>>(
    method: M,
    path: P,
    upload: { params: Params<Paths[P][M & keyof Paths[P]]>; body: Blob; onProgress: (sent: number) => void },
  ): Promise<Answer<Paths[P][M & keyof Paths[P]] & Record<string | number, unknown>, object>>;
  /** Where a GET operation is, absolute; `ws:`/`wss:` for one the document marks `x-socket`. */
  url<P extends PathsWithMethod<Paths, "get">>(path: P, ...params: ParamsParam<Paths[P]["get" & keyof Paths[P]]>): URL;
  /** Whether a caller holding `permissions` passes the operation's gate: its `x-permission`, or any signed-in caller where it names none. */
  mayCall<M extends HttpMethod, P extends PathsWithMethod<Paths, M>>(method: M, path: P, permissions: readonly string[]): boolean;
}

