"use client";

import { useState } from "react";
import { connectAgent, disconnectAgent, useAgentConnection } from "@/lib/agent/browser-session";
import { useDesignStore } from "@/store/design-store";
import "./agent-connection.css";

export function AgentConnectionPanel() {
  const connection = useAgentConnection();
  const designName = useDesignStore(
    (state) => state.designs.find((entry) => entry.id === state.activeDesignId)?.name,
  );
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  return (
    <div className="agent-connection" data-agent-panel>
      <p>Connect a local agent to this browser tab. Each batch can be undone on the board.</p>
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
      <div className="agent-connection-actions">
        <button
          type="button"
          disabled={!code || connection.state === "connecting"}
          onClick={() => {
            try {
              connectAgent(code);
              setError(undefined);
              setCode("");
            } catch (failure) {
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
        Ask your MCP client to call begin_pairing, then paste its code here. Keep this tab open
        while the agent works.
      </p>
    </div>
  );
}
