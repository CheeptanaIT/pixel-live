import { useSyncExternalStore } from "react";

/** Three routes don't justify a router library. */
export type Route =
  | { name: "home" }
  | { name: "room"; roomId: string }
  | { name: "stage"; roomId: string }
  | { name: "devStage" }
  | { name: "notFound" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/") return { name: "home" };
  if (import.meta.env.DEV && pathname === "/dev/stage") return { name: "devStage" };
  const m = pathname.match(/^\/(r|s)\/([^/]+)\/?$/);
  if (m) return { name: m[1] === "r" ? "room" : "stage", roomId: m[2] };
  return { name: "notFound" };
}

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, () => location.pathname);
  return parseRoute(pathname);
}

export function navigate(to: string) {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
