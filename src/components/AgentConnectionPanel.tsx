"use client";

import { useState, useSyncExternalStore } from "react";
import { connectAgent, disconnectAgent, useAgentConnection } from "@/lib/agent/browser-session";
import { useDesignStore } from "@/store/design-store";
import "./agent-connection.css";
import { httpWarning } from "@/lib/agent/connection-security";

const subscribeOrigin = () => () => {};

export function AgentConnectionPanel() {
  const connection = useAgentConnection();
  const designName = useDesignStore(
    (state) => state.designs.find((entry) => entry.id === state.activeDesignId)?.name,
  );
  const [code, setCode] = useState("");
  const [allowCreate, setAllowCreate] = useState(false);
  const [error, setError] = useState<string>();
  const origin = useSyncExternalStore(
    subscribeOrigin,
    () => window.location.origin,
    () => "",
  );
  const securityWarning = origin ? httpWarning(origin)?.message : undefined;
  return (
    <div className="agent-connection" data-agent-panel>
      <p>Authorize an agent to edit this design. Keep this tab open. Each batch can be undone.</p>
      {securityWarning ? (
        <p role="alert">Warning: {securityWarning} Connection is allowed.</p>
      ) : null}
      <p role="status">
        {connection.state === "connected"
          ? "Connected"
          : connection.state === "connecting"
            ? "Connecting"
            : "Disconnected"}
        {connection.state === "connected" && designName ? ` · ${designName}` : ""}
      </p>
      <label>
        Pairing code
        <input
          aria-label="Agent pairing code"
          autoComplete="off"
          spellCheck={false}
          type="password"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      {connection.state !== "connected" && code.trim().startsWith("gtnh-agent.") ? (
        <p>Local pairing authorizes this browser session, including new designs.</p>
      ) : connection.state !== "connected" ? (
        <label className="agent-connection-scope">
          <input
            type="checkbox"
            checked={allowCreate}
            onChange={(event) => setAllowCreate(event.target.checked)}
          />
          Allow new designs in this session
        </label>
      ) : (
        <p>
          {connection.allowCreate
            ? "New designs allowed in this session."
            : "Only the paired design is authorized."}
        </p>
      )}
      <p>{designName ? `Selected design: ${designName}` : "Open a design or allow new designs."}</p>
      <div className="agent-connection-actions">
        <button
          type="button"
          disabled={!code || connection.state === "connecting"}
          onClick={async () => {
            try {
              await connectAgent(code, { allowCreate });
              setError(undefined);
              setCode("");
            } catch (failure) {
              useAgentConnection.setState({ state: "error" });
              setError(failure instanceof Error ? failure.message : String(failure));
            }
          }}
        >
          Connect
        </button>
        <button type="button" onClick={disconnectAgent}>
          Disconnect
        </button>
      </div>
      {error || connection.message ? <p role="alert">{error ?? connection.message}</p> : null}
      <p>
        Ask your agent to call begin_pairing, then paste its code here. Remote connections use the
        website relay and need no open port on your computer.
      </p>
    </div>
  );
}
