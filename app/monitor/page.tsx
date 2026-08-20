"use client";

import { useEffect, useState, useCallback } from "react";

const EVENT_LABEL: Record<string, string> = {
  waiting_for_passenger: "Llegada",
  job_marked_as_delivered: "Finalizado",
  cancelled_by_company: "Cancelado",
};

const CHANNEL_LABEL: Record<string, string> = {
  "ghl-text": "Texto (rico)",
  "ghl-template": "Plantilla",
  meta: "Meta",
};

function statusColor(status: string | null, outcome: string): string {
  if (outcome === "no_phone") return "#f59e0b";
  const s = (status ?? "").toLowerCase();
  if (s === "delivered" || s === "read") return "#22c55e";
  if (s === "failed" || s === "undelivered") return "#ef4444";
  if (s === "pending" || s === "sent") return "#3b82f6";
  return "#6b7280";
}

export default function Monitor() {
  const [key, setKey] = useState("");
  const [input, setInput] = useState("");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>("");

  useEffect(() => {
    const saved = localStorage.getItem("tl_monitor_key");
    if (saved) setKey(saved);
  }, []);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/monitor?key=${encodeURIComponent(key)}&limit=150`);
      if (res.status === 401) {
        setError("Clave inválida");
        setKey("");
        localStorage.removeItem("tl_monitor_key");
        return;
      }
      const json = await res.json();
      setData(json);
      setError("");
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch {
      setError("Error de red");
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    if (!key) return;
    load();
    // Refresco cada 60s (antes 15s). Con el estado de entrega cacheado en Redis,
    // esto ya casi no consume cuota de GHL, pero un intervalo mayor es más seguro.
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [key, load]);

  if (!key) {
    return (
      <div style={wrap}>
        <div style={{ maxWidth: 340, margin: "80px auto", textAlign: "center" }}>
          <h1 style={{ fontSize: 22 }}>Taxi Laser — Monitor</h1>
          <p style={{ color: "#9ca3af", fontSize: 14 }}>Ingresa la clave de acceso</p>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && input) {
                localStorage.setItem("tl_monitor_key", input);
                setKey(input);
              }
            }}
            placeholder="Clave"
            style={inputStyle}
          />
          <button
            onClick={() => {
              if (input) {
                localStorage.setItem("tl_monitor_key", input);
                setKey(input);
              }
            }}
            style={btn}
          >
            Entrar
          </button>
          {error && <p style={{ color: "#ef4444" }}>{error}</p>}
        </div>
      </div>
    );
  }

  const stats = data?.stats;
  const totals = data?.totals;
  const events = data?.events ?? [];

  return (
    <div style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Taxi Laser — Monitor de mensajes</h1>
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          {loading ? "Actualizando…" : `Actualizado ${updatedAt}`} · auto 15s
          <button onClick={load} style={{ ...btn, width: "auto", padding: "4px 10px", marginLeft: 10 }}>↻</button>
        </div>
      </div>

      {totals && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14, alignItems: "stretch" }}>
          <Stat label="Total enviados (histórico)" value={totals.totalSent} color="#e5e7eb" wide />
          <div style={{ background: "#0f1b12", border: "1px solid #14532d", borderRadius: 8, padding: "10px 16px" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#22c55e" }}>
              ${totals.cost.costTotal.toFixed(2)}
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Costo estimado
            </div>
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4 }}>
              Plantilla/workflow {totals.template}×${totals.cost.rateTemplate} = ${totals.cost.costTemplate.toFixed(3)}<br />
              Servicio (texto) {totals.freetext}×${totals.cost.rateFreetext} = ${totals.cost.costFreetext.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {stats && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 18 }}>
          <Stat label="Eventos (recientes)" value={stats.total} />
          <Stat label="Entregados" value={stats.delivered} color="#22c55e" />
          <Stat label="Fallidos" value={stats.failed} color="#ef4444" />
          <Stat label="Fallo 24h" value={stats.failed24h} color="#ef4444" />
          <Stat label="Pendientes" value={stats.pending} color="#3b82f6" />
          <Stat label="Sin teléfono" value={stats.noPhone} color="#f59e0b" />
          <Stat label="Cache hits" value={stats.cacheHits} color="#a78bfa" />
          <Stat label="Con estado" value={stats.enrichedCount} color="#9ca3af" />
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#9ca3af", borderBottom: "1px solid #374151" }}>
              <th style={th}>Hora</th>
              <th style={th}>Evento</th>
              <th style={th}>Job</th>
              <th style={th}>Teléfono</th>
              <th style={th}>Origen tel.</th>
              <th style={th}>Canal</th>
              <th style={th}>24h</th>
              <th style={th}>Entrega</th>
              <th style={th}>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e: any, i: number) => (
              <tr key={i} style={{ borderBottom: "1px solid #1f2937" }}>
                <td style={td}>{new Date(e.ts).toLocaleTimeString()}</td>
                <td style={td}>{EVENT_LABEL[e.event] ?? e.event}</td>
                <td style={{ ...td, fontFamily: "monospace", color: "#9ca3af" }}>{e.job_id}</td>
                <td style={{ ...td, fontFamily: "monospace" }}>{e.phone ?? "—"}</td>
                <td style={td}>{e.phoneSource === "cache" ? "🗄️ cache" : e.phoneSource === "webhook" ? "webhook" : "—"}</td>
                <td style={td}>{e.channel ? CHANNEL_LABEL[e.channel] ?? e.channel : "—"}</td>
                <td style={td}>{e.inWindow === true ? "✅" : e.inWindow === false ? "⛔" : "—"}</td>
                <td style={td}>
                  <span style={{ color: statusColor(e.deliveryStatus, e.outcome), fontWeight: 600 }}>
                    {e.outcome === "no_phone" ? "sin teléfono" : e.deliveryStatus ?? (e.ghlOk ? "enviado" : e.outcome)}
                  </span>
                </td>
                <td style={{ ...td, color: e.note ? "#f59e0b" : "#9ca3af", maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {e.deliveryError ?? e.note ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 && <p style={{ color: "#9ca3af", marginTop: 20 }}>Sin eventos registrados aún.</p>}
      </div>
    </div>
  );
}

function Stat({ label, value, color, wide }: { label: string; value: number; color?: string; wide?: boolean }) {
  return (
    <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8, padding: "10px 14px", minWidth: wide ? 150 : 92 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? "#e5e7eb" }}>{value ?? 0}</div>
      <div style={{ fontSize: 11, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  background: "#0b0f19",
  color: "#e5e7eb",
  fontFamily: "system-ui, -apple-system, sans-serif",
  padding: 20,
};
const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 500, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "7px 10px", whiteSpace: "nowrap" };
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "10px 12px", margin: "12px 0", borderRadius: 8,
  border: "1px solid #374151", background: "#111827", color: "#e5e7eb", fontSize: 15,
};
const btn: React.CSSProperties = {
  width: "100%", padding: "10px 12px", borderRadius: 8, border: "none",
  background: "#2563eb", color: "white", fontSize: 15, cursor: "pointer",
};
