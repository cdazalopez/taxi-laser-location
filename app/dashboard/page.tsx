"use client";

import { useCallback, useEffect, useState } from "react";

const PLATFORMS = [
  { v: "", label: "Todas las plataformas" },
  { v: "sms", label: "SMS / RingCentral" },
  { v: "whatsapp", label: "WhatsApp" },
  { v: "call", label: "Llamadas" },
  { v: "email", label: "Email" },
];

const PLATFORM_LABEL: Record<string, string> = {
  sms: "SMS", whatsapp: "WhatsApp", call: "Llamada", email: "Email", other: "Otro",
};

function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}
function todayET(): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of dtf.formatToParts(new Date())) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

export default function Dashboard() {
  const [key, setKey] = useState("");
  const [input, setInput] = useState("");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");

  const [to, setTo] = useState(todayET());
  const [from, setFrom] = useState(addDays(todayET(), -6));
  const [platform, setPlatform] = useState("");
  const [user, setUser] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("tl_dash_key");
    if (saved) setKey(saved);
  }, []);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ key, from, to });
      if (platform) qs.set("platform", platform);
      if (user) qs.set("user", user);
      const res = await fetch(`/api/dashboard?${qs.toString()}`);
      if (res.status === 401) {
        setError("Clave inválida");
        setKey("");
        localStorage.removeItem("tl_dash_key");
        return;
      }
      setData(await res.json());
      setError("");
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch {
      setError("Error de red");
    } finally {
      setLoading(false);
    }
  }, [key, from, to, platform, user]);

  useEffect(() => {
    if (!key) return;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [key, load]);

  if (!key) {
    return (
      <div style={wrap}>
        <div style={{ maxWidth: 340, margin: "80px auto", textAlign: "center" }}>
          <h1 style={{ fontSize: 22 }}>Taxi Laser — Dashboard KPI</h1>
          <p style={{ color: "#9ca3af", fontSize: 14 }}>Ingresa la clave de acceso</p>
          <input
            type="password" value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && input) { localStorage.setItem("tl_dash_key", input); setKey(input); } }}
            placeholder="Clave" style={inputStyle}
          />
          <button onClick={() => { if (input) { localStorage.setItem("tl_dash_key", input); setKey(input); } }} style={btn}>Entrar</button>
          {error && <p style={{ color: "#ef4444" }}>{error}</p>}
        </div>
      </div>
    );
  }

  const op = data?.operational;
  const kpis = data?.kpis;
  const users: Array<{ id: string; name: string }> = data?.users ?? [];
  const r = kpis?.responses;

  const preset = (days: number) => { setTo(todayET()); setFrom(addDays(todayET(), -(days - 1))); };
  const spanDays = (() => {
    const [ay, am, ad] = from.split("-").map(Number);
    const [by, bm, bd] = to.split("-").map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000) + 1;
  })();
  const activePreset = to === todayET() ? (spanDays === 1 ? 1 : spanDays === 7 ? 7 : spanDays === 30 ? 30 : null) : null;

  return (
    <div style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Taxi Laser — Panel de Control KPI</h1>
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          {loading ? "Actualizando…" : `Actualizado ${updatedAt}`} · auto 60s
          <button onClick={load} style={{ ...btn, width: "auto", padding: "4px 10px", marginLeft: 10 }}>↻</button>
        </div>
      </div>

      {/* Filtros — solo afectan la sección "Atención de mensajes" */}
      <div style={{ background: "#0e1524", border: "1px solid #1f2937", borderRadius: 10, padding: "12px 14px", marginBottom: 18 }}>
        <div style={{ fontSize: 11, color: "#8b93a3", marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Filtros</span>
          <span>· solo afectan <b style={{ color: "#93c5fd" }}>Atención de mensajes</b> (la sección Operativo es en vivo / hoy)</span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {([["Hoy", 1], ["Últimos 7 días", 7], ["Últimos 30 días", 30]] as Array<[string, number]>).map(([label, d]) => (
              <button key={label} onClick={() => preset(d)} style={activePreset === d ? chipActive : chip}>{label}</button>
            ))}
          </div>
          <span style={{ color: "#4b5563" }}>|</span>
          <label style={lbl}>Desde <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={dateInput} /></label>
          <label style={lbl}>Hasta <input type="date" value={to} min={from} max={todayET()} onChange={(e) => setTo(e.target.value)} style={dateInput} /></label>
          <span style={{ color: "#4b5563" }}>|</span>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} style={select}>
            {PLATFORMS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
          </select>
          <select value={user} onChange={(e) => setUser(e.target.value)} style={select}>
            <option value="">Todos los dispatchers</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 12, color: "#e5e7eb", marginTop: 10 }}>
          Mostrando <b>{spanDays === 1 && activePreset === 1 ? "hoy" : `${from} → ${to}`}</b>
          <span style={{ color: "#6b7280" }}> ({spanDays} {spanDays === 1 ? "día" : "días"})</span>
          {platform && <span style={{ color: "#93c5fd" }}> · {PLATFORM_LABEL[platform] ?? platform}</span>}
          {user && <span style={{ color: "#a78bfa" }}> · {users.find((u) => u.id === user)?.name ?? "usuario"}</span>}
        </div>
      </div>

      {/* Fila operativa — ventana fija (hoy / en vivo / 24h / histórico), NO usa el rango */}
      <SectionTitle badge="En vivo · hoy" badgeColor="#34d399" hint="Estado del negocio en tiempo real. Estas tarjetas NO cambian con el rango de fechas — cada una indica su ventana arriba a la derecha.">
        Operativo
      </SectionTitle>
      <div style={row}>
        <Tile
          value={op?.taxicaller?.tripsToday ?? op?.trips?.today ?? "—"} label="Viajes hoy" color="#e5e7eb" windowLabel="hoy"
          sub={op?.taxicaller?.tripsYesterday != null ? `ayer ${op.taxicaller.tripsYesterday} · sem. pasada ${op?.taxicaller?.tripsLastWeek ?? "—"}` : `${op?.trips?.today ?? 0} contados por webhook`}
        />
        <Tile value={op?.taxicaller?.activeVehicles ?? "—"} label="Vehículos activos" color="#a78bfa" windowLabel="en vivo" sub={op?.taxicaller?.activeVehicles != null ? `de ${op?.taxicaller?.fleetSize} en flota` : (op?.taxicaller?.ok ? "sin datos" : "sin conexión")} pending={op?.taxicaller?.activeVehicles == null} />
        <Tile value={op?.missedCalls?.ok ? op?.missedCalls?.missed : "—"} label="Llamadas perdidas" color="#f87171" windowLabel="24h" sub={op?.missedCalls?.ok ? `de ${op?.missedCalls?.total} entrantes` : "scope/permiso RC"} pending={!op?.missedCalls?.ok} />
        <Tile value={op?.taxicaller?.avgRating ?? "—"} label="Calificación promedio" color="#fbbf24" windowLabel="7 días" sub="TaxiCaller (pendiente)" pending={op?.taxicaller?.avgRating == null} />
        <Tile value={op?.messages?.totalSent ?? "—"} label="Mensajes enviados" color="#60a5fa" windowLabel="histórico" sub={`plantilla ${op?.messages?.template ?? 0} · texto ${op?.messages?.freetext ?? 0}`} />
        <Tile value={op?.messages ? `$${op?.savings?.total?.toFixed?.(2)}` : "—"} label="Ahorro acumulado" color="#22c55e" windowLabel="histórico" sub={`~$${op?.savings?.perMsg}/msg`} />
      </div>

      {/* KPIs de dispatchers — usan el rango + filtros seleccionados */}
      <SectionTitle
        badge={activePreset === 1 ? "Hoy" : activePreset === 7 ? "Últimos 7 días" : activePreset === 30 ? "Últimos 30 días" : `${from} → ${to}`}
        badgeColor="#93c5fd"
        hint={`Cadencia de atención en el rango y filtros de arriba${kpis?.filters?.platform ? ` · ${PLATFORM_LABEL[kpis.filters.platform] ?? kpis.filters.platform}` : ""}${kpis?.filters?.user ? " · usuario filtrado" : ""}. Derivado de las conversaciones de GHL (SMS + WhatsApp): tiempo entre el mensaje del cliente y la primera respuesta del dispatcher.`}
      >
        Atención de mensajes
      </SectionTitle>
      {data?.coverage && data.coverage.daysWithData < data.coverage.requestedDays && (
        <div style={{ fontSize: 11.5, color: "#fbbf24", background: "#2a2411", border: "1px solid #4d3f16", borderRadius: 8, padding: "7px 11px", marginBottom: 10 }}>
          ⚠️ Historial parcial: hay datos de <b>{data.coverage.daysWithData}</b> de los <b>{data.coverage.requestedDays}</b> días pedidos
          {data.coverage.firstDay ? ` (desde ${data.coverage.firstDay})` : ""}. El historial se completa día a día; por eso rangos largos aún pueden coincidir.
        </div>
      )}
      <div style={row}>
        <Tile value={kpis?.inbound?.total ?? "—"} label="Mensajes entrantes" color="#e5e7eb" windowLabel="rango sel." />
        <Tile value={r?.count ?? "—"} label="Respondidos" color="#60a5fa" windowLabel="rango sel." />
        <Tile value={fmtMs(r?.avgMs)} label="Tiempo prom. respuesta" color="#e5e7eb" windowLabel="rango sel." />
        <Tile value={fmtMs(r?.p50Ms)} label="Mediana (p50)" color="#a3e635" windowLabel="rango sel." />
        <Tile value={fmtMs(r?.p90Ms)} label="p90" color="#fbbf24" windowLabel="rango sel." />
        <Tile value={r?.slaPct != null ? `${r.slaPct}%` : "—"} label={`Dentro de SLA (${kpis?.slaSeconds ?? 300}s)`} color={r?.slaPct != null && r.slaPct >= 80 ? "#22c55e" : "#f87171"} sub={`${r?.slaBreaches ?? 0} tardías`} windowLabel="rango sel." />
      </div>

      {/* Por usuario */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 8, alignItems: "start" }}>
        <div>
          <SectionTitle>Por dispatcher</SectionTitle>
          <table style={table}>
            <thead>
              <tr style={{ textAlign: "left", color: "#9ca3af", borderBottom: "1px solid #374151" }}>
                <th style={th}>Dispatcher</th><th style={th}>Respondidos</th><th style={th}>Prom.</th><th style={th}>Tardías</th>
              </tr>
            </thead>
            <tbody>
              {(kpis?.byUser ?? []).map((u: any) => (
                <tr key={u.userId} style={{ borderBottom: "1px solid #1f2937", cursor: "pointer" }} onClick={() => setUser(u.userId === user ? "" : u.userId)}>
                  <td style={td}>{u.name}{user === u.userId ? " ◀" : ""}</td>
                  <td style={td}>{u.count}</td>
                  <td style={td}>{fmtMs(u.avgMs)}</td>
                  <td style={{ ...td, color: u.slaBreaches ? "#f87171" : "#9ca3af" }}>{u.slaBreaches}</td>
                </tr>
              ))}
              {(!kpis?.byUser || kpis.byUser.length === 0) && (
                <tr><td style={{ ...td, color: "#9ca3af" }} colSpan={4}>Sin respuestas registradas en el rango.</td></tr>
              )}
            </tbody>
          </table>

          <SectionTitle>Por plataforma</SectionTitle>
          <table style={table}>
            <thead><tr style={{ textAlign: "left", color: "#9ca3af", borderBottom: "1px solid #374151" }}><th style={th}>Plataforma</th><th style={th}>Respondidos</th><th style={th}>Prom.</th></tr></thead>
            <tbody>
              {Object.entries(kpis?.byPlatform ?? {}).map(([p, v]: any) => (
                <tr key={p} style={{ borderBottom: "1px solid #1f2937" }}>
                  <td style={td}>{PLATFORM_LABEL[p] ?? p}</td><td style={td}>{v.count}</td><td style={td}>{fmtMs(v.avgMs)}</td>
                </tr>
              ))}
              {Object.keys(kpis?.byPlatform ?? {}).length === 0 && <tr><td style={{ ...td, color: "#9ca3af" }} colSpan={3}>—</td></tr>}
            </tbody>
          </table>
        </div>

        <div>
          <SectionTitle>Distribución de tiempos de respuesta</SectionTitle>
          <BarChart labels={r?.histLabels ?? []} values={r?.hist ?? []} color="#60a5fa" />
          <SectionTitle>Entrantes por hora (del día)</SectionTitle>
          <BarChart labels={Array.from({ length: 24 }, (_, i) => String(i))} values={kpis?.inbound?.byHour ?? []} color="#a78bfa" dense />
        </div>
      </div>

      {error && <p style={{ color: "#ef4444", marginTop: 12 }}>{error}</p>}
      <p style={{ color: "#4b5563", fontSize: 11, marginTop: 24 }}>
        Rango {data?.range?.from} → {data?.range?.to} ({data?.range?.days} días). KPIs de atención derivados de las conversaciones de GoHighLevel.
      </p>
    </div>
  );
}

function BarChart({ labels, values, color, dense }: { labels: string[]; values: number[]; color: string; dense?: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: dense ? 2 : 6, height: 120, padding: "8px 4px", background: "#111827", border: "1px solid #1f2937", borderRadius: 8 }}>
      {values.map((v, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }} title={`${labels[i]}: ${v}`}>
          <div style={{ fontSize: 9, color: "#9ca3af" }}>{v || ""}</div>
          <div style={{ width: "100%", background: color, borderRadius: 2, height: `${(v / max) * 100}%`, minHeight: v ? 2 : 0 }} />
          <div style={{ fontSize: dense ? 8 : 9, color: "#6b7280", marginTop: 2 }}>{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}

function SectionTitle({ children, hint, badge, badgeColor }: { children: React.ReactNode; hint?: string; badge?: string; badgeColor?: string }) {
  return (
    <div style={{ margin: "22px 0 8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 0.6, color: "#e5e7eb", margin: 0 }}>{children}</h2>
        {badge && <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: badgeColor ?? "#93c5fd", background: `${badgeColor ?? "#93c5fd"}1a`, border: `1px solid ${badgeColor ?? "#93c5fd"}55`, borderRadius: 6, padding: "2px 7px" }}>{badge}</span>}
      </div>
      {hint && <div style={{ fontSize: 11.5, color: "#8b93a3", marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

function Tile({ value, label, color, sub, pending, windowLabel }: { value: any; label: string; color?: string; sub?: string; pending?: boolean; windowLabel?: string }) {
  return (
    <div style={{ position: "relative", background: "#111827", border: `1px solid ${pending ? "#3f2d1a" : "#1f2937"}`, borderRadius: 10, padding: "12px 16px", minWidth: 150, flex: "1 1 150px", opacity: pending ? 0.72 : 1 }}>
      {windowLabel && <div style={{ position: "absolute", top: 9, right: 10, fontSize: 8.5, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>{windowLabel}</div>}
      <div style={{ fontSize: 24, fontWeight: 700, color: color ?? "#e5e7eb" }}>{value}{pending && <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 6 }}>pendiente</span>}</div>
      <div style={{ fontSize: 11, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

const wrap: React.CSSProperties = { minHeight: "100vh", background: "#0b0f19", color: "#e5e7eb", fontFamily: "system-ui, -apple-system, sans-serif", padding: 20 };
const row: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 10 };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 8 };
const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 500, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "7px 10px", whiteSpace: "nowrap" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", margin: "12px 0", borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#e5e7eb", fontSize: 15 };
const btn: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: 8, border: "none", background: "#2563eb", color: "white", fontSize: 15, cursor: "pointer" };
const chip: React.CSSProperties = { padding: "6px 12px", borderRadius: 20, border: "1px solid #374151", background: "#111827", color: "#e5e7eb", fontSize: 12, cursor: "pointer" };
const chipActive: React.CSSProperties = { ...chip, background: "#2563eb", borderColor: "#2563eb", color: "white", fontWeight: 700 };
const select: React.CSSProperties = { padding: "7px 10px", borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#e5e7eb", fontSize: 13 };
const dateInput: React.CSSProperties = { padding: "6px 8px", borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#e5e7eb", fontSize: 13, marginLeft: 6 };
const lbl: React.CSSProperties = { fontSize: 12, color: "#9ca3af", display: "flex", alignItems: "center" };
