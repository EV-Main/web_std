"use client";

import * as React from "react";

/**
 * The optimistic half of a nav: the id of the item just clicked, until the
 * pathname catches up.
 *
 * A router that waits for the next page's payload changes the pathname 150–300ms
 * after the click — exactly the window in which a highlight that has not moved
 * reads as a click that did not land. So the clicked item is marked at once.
 *
 * The entry remembers the pathname it was made on, so the moment the pathname
 * changes it is stale by construction and the URL is the truth again. It is
 * cleared during render, not in an effect (an effect would paint one frame with
 * the URL's row marked and the stale one not), and cleared rather than ignored:
 * left behind, it would come back to life on a return to the page it was made
 * on. A click that never navigates is forgotten by the next one.
 */
export function usePendingNavigation(
  pathname: string,
): readonly [pendingId: string | null, markPending: (id: string) => void] {
  const [pending, setPending] = React.useState<{ id: string; from: string } | null>(null);
  if (pending && pending.from !== pathname) setPending(null);
  const pendingId = pending && pending.from === pathname ? pending.id : null;
  const markPending = React.useCallback(
    (id: string) => setPending({ id, from: pathname }),
    [pathname],
  );
  return [pendingId, markPending] as const;
}
