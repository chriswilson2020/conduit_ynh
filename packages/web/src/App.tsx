import { useEffect, useState } from "react";
import type { MeResponse, HealthResponse } from "@conduit/shared";
import { fetchMe, fetchHealth, basePath } from "./api";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; me: MeResponse; health: HealthResponse };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    Promise.all([fetchMe(), fetchHealth()])
      .then(([me, health]) => setState({ kind: "ready", me, health }))
      .catch((error: unknown) =>
        setState({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
      );
  }, []);

  if (state.kind === "loading") return <main><p>Loading...</p></main>;
  if (state.kind === "error") {
    return (
      <main>
        <h1>Conduit</h1>
        <p role="alert">Could not reach the API: {state.message}</p>
      </main>
    );
  }

  const { user } = state.me;
  return (
    <main>
      <h1>Conduit</h1>
      <p data-testid="greeting">
        Logged in as {user.fullName ?? user.username} ({user.username})
      </p>
      <dl>
        <dt>Version</dt>
        <dd data-testid="version">{state.health.version}</dd>
        <dt>Database</dt>
        <dd data-testid="database">{state.health.database}</dd>
        <dt>Base path</dt>
        <dd data-testid="base-path">{basePath()}</dd>
      </dl>
    </main>
  );
}
