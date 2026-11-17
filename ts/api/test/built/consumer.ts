// The built package as a consumer imports it: its two entries' declarations must agree.
import { createApi } from "@evinvest/api";
import { useResource } from "@evinvest/api/react";
import openapi from "../fixtures/conductor/openapi.json";
import type { components, paths } from "../fixtures/conductor/schema";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(t: T) => t;

const api = createApi<paths>({ document: openapi, baseUrl: "/api/v1", onUnauthenticated: () => undefined });

export function Screen() {
  const gmails = useResource(api, "/gmails");
  if (gmails.status === "ok") is<Equal<typeof gmails.data, components["schemas"]["Gmails"]>>(true);
  return null;
}
