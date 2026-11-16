// Typed against the conductor's generated schema (a vendored copy): never run, only `tsc`'d.
import { createApi, type Failure } from "../src/index";
import { useResource } from "../src/react/index";
import openapi from "./fixtures/conductor/openapi.json";
import type { ErrorCode, components, paths } from "./fixtures/conductor/schema";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(t: T) => t;

const api = createApi<paths>({ document: openapi, baseUrl: "/api/v1", onUnauthenticated: () => undefined });

export async function calls() {
  const kit = await api.GET("/gmbs/{id}/kit", { params: { path: { id: 1 } } });
  if (kit.error) {
    is<Equal<typeof kit.error.code, ErrorCode | "network">>(true);
    return;
  }
  is<Equal<typeof kit.data, components["schemas"]["GmbKit"]>>(true);

  // @ts-expect-error the path parameter is required
  await api.GET("/gmbs/{id}/kit");
  // @ts-expect-error and typed
  await api.GET("/gmbs/{id}/kit", { params: { path: { id: "1" } } });

  const trade = await api.POST("/trades", { body: { name: "x" } });
  if (!trade.error) is<Equal<typeof trade.data, components["schemas"]["Trade"]>>(true);

  await api.upload("put", "/gmails/{id}/browser/film", { params: { path: { id: 1 } }, body: new Blob(), onProgress: () => undefined });
  // @ts-expect-error no GET at this path
  api.url("/gmails/{id}/browser/film", { path: { id: 1 } });
  api.url("/gmbs/{id}/kit", { path: { id: 1 } });
  // @ts-expect-error the path parameter is required
  api.url("/gmbs/{id}/kit");

  const failure: Failure<paths> = { code: "network", error: "" };
  return failure;
}

export function Screen({ id }: { id: number }) {
  const kit = useResource(api, "/gmbs/{id}/kit", { params: { path: { id } } });
  if (kit.status === "ok") is<Equal<typeof kit.data, components["schemas"]["GmbKit"]>>(true);
  if (kit.status === "error") is<Equal<typeof kit.failure.code, ErrorCode | "network">>(true);
  // @ts-expect-error the path parameter is required
  useResource(api, "/gmbs/{id}/kit");
  useResource(api, "/gmails/{id}/connections", { params: { path: { id } }, keep: true });
  return null;
}
