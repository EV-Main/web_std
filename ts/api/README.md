# `@evinvest/api`

A service's OpenAPI document as its client: the client side of [`ev_lib::api`](../../rust/src/ops/api/README.md).
Generic over the `paths` openapi-typescript generates from the same document, and knows nothing of
any one service: its base path, what a 401 does and the headers a request carries (a CSRF token) are
the caller's.

```ts
import { createApi } from "@evinvest/api";
import { useLiveSocket, useResource } from "@evinvest/api/react";
import openapi from "./openapi.json";
import type { paths } from "./schema";

export const api = createApi<paths>({
  document: openapi,
  baseUrl: "/api/v1",
  headers: (method) => (method === "GET" ? {} : { "x-sa-csrf": csrf() }),
  onUnauthenticated: goToSignIn,
});

const set = await api.PUT("/notes/{id}", { params: { path: { id } }, body });
if (set.error?.code === "conflict") …            // typed by the operation's refusals, plus "network"

const note = useResource(api, "/notes/{id}", { params: { path: { id } } });

useLiveSocket(api.url("/live"), { onUnauthenticated, onForbidden });   // the host page, once
```

## What the document decides

```text
answer 2xx        checked against the operation's JSON schema (ajv)    off it: throws
refusal           {code, error} checked against its schema; code ∈ x-errors, status = x-errors[code]
                  ─▶ { error } keyed by code; anything else throws; a 401 also calls onUnauthenticated
hop refusal       a code the host's hop in front answers itself (createApi's `hop`, {code: status}), at its status
no answer         fetch failed, or a non-JSON 502/503/504 (a proxy's page) ─▶ { error: {code: "network"} }
url(path, p)      the GET operation's URL; ws:/wss: when the document marks it x-socket
upload(m, p, …)   XHR for its progress; content type the operation's one, or the body's own among several; same checks
mayCall(m, p, ps) the operation's x-permission is among the caller's permissions (the service's /me, a host's); none named: true
GET x-sa-reads    the tables the answer read (<service>.<table>); every GET answer carries it
```

A thrown error is a broken contract between the document and the service, never a failure a screen
handles; `useResource` throws it in render, for the nearest error boundary.

## Live

```text
host page   useLiveSocket(url) ── one socket per tab, backoff with jitter, paused while hidden
                 │  relayed on window: ev:live (every frame) · ev:live-status (+ ev:live-status-request)
every bundle     ▼  (the host's own and each microfrontend's)
            useLiveStatus()        the host's status; null until told
            useLive(answer, on)    a change on a table `answer` read · resync · back live after a drop
                                   · every 60 s while offline; a burst folded into one call per 400 ms
            useResource(api, path, init)
                                   re-reads on useLive of its last answer; one that read no table
                                   re-reads on window focus; stale-while-revalidate (`fresh`), quiet
                                   background re-reads; `keep: true` keeps the operation's last answer
                                   at other params on screen while these load
```

The socket stays a broadcast; each reader matches its own tables. Closes 4401 (session gone) and
4403 (access withdrawn) end it and call the host's handlers.
