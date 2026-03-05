import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";

export default function OAuthInteractiveStep({
  title,
  subtitle,
  wsPath,
  onExit,
  onCancel,
  showCancel = true,
  headLabel,
  phaseLabel = "상태",
  stepLabel = "진행",
}) {
  const terminalRef = useRef(null);
  const wsRef = useRef(null);
  const [phase, setPhase] = useState("interactive_auth_started");
  const [status, setStatus] = useState("세션 연결 중...");

  useEffect(() => {
    if (!wsPath) return undefined;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "'IBM Plex Mono', 'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#0f1114",
        foreground: "#d5d9e2",
        cursor: "#d3d3d3",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);
    fitAddon.fit();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}${wsPath}`);
    wsRef.current = socket;

    socket.onopen = () => {
      setStatus("연결됨. 안내에 따라 진행해 주세요.");
      terminal.focus();
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === "output") {
          terminal.write(message.data || "");
          return;
        }

        if (message.type === "phase") {
          setPhase(message.phase || "unknown");
          return;
        }

        if (message.type === "error") {
          const text = `${message.code || "error"}: ${message.message || "interactive error"}`;
          setStatus(text);
          onExit?.({ ok: false, code: message.code || "cli_failed", message: text });
          return;
        }

        if (message.type === "exit") {
          if (message.code === 0) {
            setStatus("인증이 완료되었습니다.");
            onExit?.({ ok: true });
          } else {
            const text = "인증 세션이 종료되었습니다. 다시 시도해 주세요.";
            setStatus(text);
            onExit?.({ ok: false, code: "cli_failed", message: text });
          }
        }
      } catch {
        // ignore malformed payload
      }
    };

    socket.onerror = () => {
      setStatus("세션 연결 오류");
      onExit?.({ ok: false, code: "cli_failed", message: "websocket error" });
    };

    socket.onclose = () => {
      setStatus((prev) => (prev.includes("완료") ? prev : "세션 연결이 종료되었습니다."));
    };

    terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resize = () => {
      fitAddon.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };

    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      try {
        socket.close();
      } catch {
        // ignore close error
      }
      terminal.dispose();
    };
  }, [wsPath, onExit]);

  const handleCancel = async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "cancel" }));
    }
    await onCancel?.();
  };

  return (
    <div className="ov0-step">
      <div className="ov0-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>

      <div className="terminal-shell">
        <div className="terminal-head">{headLabel || wsPath}</div>
        <div ref={terminalRef} className="terminal-body compact" />
      </div>

      <p className="status-text ov0-status">
        {stepLabel}: <strong>{phase}</strong> · {phaseLabel}: {status}
      </p>

      {showCancel ? (
        <div className="ov0-inline-actions">
          <button type="button" className="ov0-btn ghost danger" onClick={handleCancel}>
            인증 취소
          </button>
        </div>
      ) : null}
    </div>
  );
}
