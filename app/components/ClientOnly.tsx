import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

const emptySubscribe = () => () => {};

/**
 * Returns false during SSR and the first client render, true after hydration.
 * Uses useSyncExternalStore so the server snapshot is always false — no
 * hydration mismatch warnings.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true, // client snapshot
    () => false, // server snapshot
  );
}

/**
 * Renders `children()` only on the client, after hydration. Use to wrap
 * components that can't server-render (e.g. @shopify/polaris-viz charts, which
 * read `window` during render and throw "window is not defined" under SSR).
 * `children` is a function so it is never invoked on the server.
 */
export function ClientOnly({
  children,
  fallback = null,
}: {
  children: () => ReactNode;
  fallback?: ReactNode;
}): ReactNode {
  return useHydrated() ? children() : fallback;
}
