import { useEffect, useState } from "react";
import type { MeResponse, HealthResponse } from "@conduit/shared";
import { fetchMe, fetchHealth, basePath } from "./api";
import { userLabel } from "./lib";

// Identity and health are fetched independently, not with Promise.all. The
// user resolver caches a resolved identity for up to 60 seconds, so during a
// transient database blip /api/me can still succeed from cache while
// /api/health correctly reports degraded. Identity is required for the page
// to be useful; health is supplementary and must not block it.
type MeState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; me: MeResponse };

type HealthState =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; health: HealthResponse };

export function App() {
  const [meState, setMeState] = useState<MeState>({ kind: "loading" });
  const [healthState, setHealthState] = useState<HealthState>({ kind: "loading" });

  useEffect(() => {
    fetchMe()
      .then((me) => setMeState({ kind: "ready", me }))
      .catch((error: unknown) =>
        setMeState({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
      );
  }, []);

  useEffect(() => {
    fetchHealth()
      .then((health) => setHealthState({ kind: "ready", health }))
      .catch((error: unknown) =>
        setHealthState({
          kind: "unavailable",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, []);

  // No wrapping <main> here: this component is rendered inside the router's
  // Shell, which already provides the page's <main> landmark (nesting two
  // <main> elements would be invalid HTML).
  if (meState.kind === "loading") return <p>Loading...</p>;
  if (meState.kind === "error") {
    return (
      <div>
        <h1>Conduit</h1>
        <p role="alert">Could not reach the API: {meState.message}</p>
      </div>
    );
  }

  const { user } = meState.me;
  const version = healthState.kind === "ready" ? healthState.health.version : "unavailable";
  const database = healthState.kind === "ready" ? healthState.health.database : "unavailable";

  return (
    <div>
      <h1>Conduit</h1>
      <p data-testid="greeting">
        Logged in as {userLabel(user, "")} ({user.username})
      </p>
      <dl>
        <dt>Version</dt>
        <dd data-testid="version">{version}</dd>
        <dt>Database</dt>
        <dd data-testid="database">{database}</dd>
        <dt>Base path</dt>
        <dd data-testid="base-path">{basePath()}</dd>
      </dl>
    </div>
  );
}
