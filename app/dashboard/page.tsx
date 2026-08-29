"use client";

import { useCallback, useEffect, useState } from "react";

// ── Paleta ─────────────────────────────────────────────────────────────────
const C = {
  bg: "#0a0d14",
  panel: "#121824",
  panel2: "#0e131e",
  border: "#1e2734",
  text: "#e8eaf0",
  muted: "#8a93a6",
  faint: "#5b6472",
  accent: "#f5c518", // amarillo taxi
  blue: "#5b9dff",
  green: "#34d399",
  red: "#f87171",
  amber: "#fbbf24",
  purple: "#a78bfa",
  lime: "#a3e635",
};

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
function fmtNum(n: any): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : (n ?? "—");
}
function todayET(): string {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
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
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<{ name: string; role: string } | null>(null);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");

  const [to, setTo] = useState(todayET());
  const [from, setFrom] = useState(addDays(todayET(), -6));
  const [platform, setPlatform] = useState("");
  const [user, setUser] = useState("");

  useEffect(() => {
    const t = localStorage.getItem("tl_dash_token");
    const n = localStorage.getItem("tl_dash_name");
    const r = localStorage.getItem("tl_dash_role");
    if (t) { setToken(t); setMe({ name: n || "", role: r || "viewer" }); }
  }, []);

  const logout = () => {
    localStorage.removeItem("tl_dash_token");
    localStorage.removeItem("tl_dash_name");
    localStorage.removeItem("tl_dash_role");
    setToken(null); setMe(null); setData(null);
  };

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from, to });
      if (platform) qs.set("platform", platform);
      if (user) qs.set("user", user);
      const res = await fetch(`/api/dashboard?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { setError("Sesión expirada"); logout(); return; }
      const json = await res.json();
      setData(json);
      if (json?.session) { setMe(json.session); localStorage.setItem("tl_dash_name", json.session.name); localStorage.setItem("tl_dash_role", json.session.role); }
      setError("");
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch { setError("Error de red"); } finally { setLoading(false); }
  }, [token, from, to, platform, user]);

  useEffect(() => {
    if (!token) return;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [token, load]);

  if (!token) return <Login onLogin={(t, name, role) => { setToken(t); setMe({ name, role }); }} />;

  const op = data?.operational;
  const kpis = data?.kpis;
  const users: Array<{ id: string; name: string }> = data?.users ?? [];
  const r = kpis?.responses;
  const tc = op?.taxicaller;

  const preset = (days: number) => { setTo(todayET()); setFrom(addDays(todayET(), -(days - 1))); };
  const spanDays = (() => {
    const [ay, am, ad] = from.split("-").map(Number);
    const [by, bm, bd] = to.split("-").map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000) + 1;
  })();
  const activePreset = to === todayET() ? (spanDays === 1 ? 1 : spanDays === 7 ? 7 : spanDays === 30 ? 30 : null) : null;
  const rangeLabel = activePreset === 1 ? "Hoy" : activePreset === 7 ? "Últimos 7 días" : activePreset === 30 ? "Últimos 30 días" : `${from} → ${to}`;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* Top bar */}
      <header style={{ position: "sticky", top: 0, zIndex: 10, background: "linear-gradient(180deg,#0d1119,#0a0d14)", borderBottom: `1px solid ${C.border}`, padding: "12px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 12, height: 12, borderRadius: 3, background: C.accent, boxShadow: `0 0 12px ${C.accent}88` }} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0.5 }}>TAXI LASER</div>
            <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, textTransform: "uppercase" }}>Panel de Control · KPI</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 11, color: C.faint, textAlign: "right" }}>
            {loading ? "Actualizando…" : `Actualizado ${updatedAt || "—"}`}<br />
            <span style={{ color: C.faint }}>auto 60s</span>
          </div>
          <button onClick={load} title="Refrescar" style={{ ...iconBtn }}>↻</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, padding: "4px 6px 4px 12px" }}>
            <div style={{ width: 26, height: 26, borderRadius: "50%", background: `${C.accent}22`, color: C.accent, display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12 }}>
              {(me?.name || "?").slice(0, 1).toUpperCase()}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.1 }}>
              <div style={{ fontWeight: 600 }}>{me?.name || "Usuario"}</div>
              <div style={{ fontSize: 9.5, color: C.faint, textTransform: "uppercase" }}>{me?.role}</div>
            </div>
            <button onClick={logout} title="Salir" style={{ ...iconBtn, fontSize: 13, marginLeft: 2 }}>⏻</button>
          </div>
        </div>
      </header>

      <div style={{ padding: "18px 22px 40px", maxWidth: 1400, margin: "0 auto" }}>
        {/* Filtros */}
        <div style={{ background: `linear-gradient(180deg,${C.panel},${C.panel2})`, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 9, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: C.text }}>Filtros</span>
            <span>· afectan solo <b style={{ color: C.blue }}>Atención de mensajes</b> — la sección Operativo es en vivo / hoy</span>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 6 }}>
              {([["Hoy", 1], ["Últimos 7 días", 7], ["Últimos 30 días", 30]] as Array<[string, number]>).map(([label, d]) => (
                <button key={label} onClick={() => preset(d)} style={activePreset === d ? chipActive : chip}>{label}</button>
              ))}
            </div>
            <span style={{ color: C.border }}>|</span>
            <label style={lbl}>Desde <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={dateInput} /></label>
            <label style={lbl}>Hasta <input type="date" value={to} min={from} max={todayET()} onChange={(e) => setTo(e.target.value)} style={dateInput} /></label>
            <span style={{ color: C.border }}>|</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} style={select}>
              {PLATFORMS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
            </select>
            <select value={user} onChange={(e) => setUser(e.target.value)} style={select}>
              <option value="">Todos los dispatchers</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 12.5, color: C.text, marginTop: 11 }}>
            Mostrando <b style={{ color: C.accent }}>{rangeLabel}</b>
            <span style={{ color: C.faint }}> · {spanDays} {spanDays === 1 ? "día" : "días"}</span>
            {platform && <span style={{ color: C.blue }}> · {PLATFORM_LABEL[platform] ?? platform}</span>}
            {user && <span style={{ color: C.purple }}> · {users.find((u) => u.id === user)?.name ?? "usuario"}</span>}
          </div>
        </div>

        {/* Operativo */}
        <SectionTitle badge="En vivo · hoy" badgeColor={C.green} hint="Estado del negocio en tiempo real. Estas tarjetas NO cambian con el rango de fechas — cada una indica su ventana.">Operativo</SectionTitle>
        <Grid>
          <Tile value={fmtNum(tc?.tripsToday ?? op?.trips?.today)} label="Viajes hoy" color={C.text} windowLabel="hoy"
            sub={tc?.tripsYesterday != null ? `ayer ${fmtNum(tc.tripsYesterday)} · sem. pasada ${fmtNum(tc?.tripsLastWeek)}` : `${op?.trips?.today ?? 0} por webhook`} />
          <Tile value={fmtNum(tc?.driversToday)} label="Conductores con turno hoy" color={C.purple} windowLabel="hoy"
            sub={tc?.activeVehicles != null ? `flota: ${fmtNum(tc?.activeVehicles)}/${fmtNum(tc?.fleetSize)} vehículos hab.` : (tc?.ok ? "sin datos" : "sin conexión")} pending={tc?.driversToday == null} />
          <Tile value={op?.missedCalls?.ok ? fmtNum(op?.missedCalls?.missed) : "—"} label="Llamadas perdidas" color={C.red} windowLabel="24h"
            sub={op?.missedCalls?.ok ? `de ${op?.missedCalls?.total} entrantes` : "scope/permiso RC"} pending={!op?.missedCalls?.ok} />
          <Tile value={fmtNum(tc?.avgRating)} label="Calificación" color={C.amber} windowLabel="7 días" sub="TaxiCaller (pendiente)" pending={tc?.avgRating == null} />
          <Tile value={fmtNum(op?.messages?.totalSent)} label="Mensajes enviados" color={C.blue} windowLabel="histórico"
            sub={`plantilla ${fmtNum(op?.messages?.template)} · texto ${fmtNum(op?.messages?.freetext)}`} />
          <Tile value={op?.messages ? `$${op?.savings?.total?.toFixed?.(2)}` : "—"} label="Ahorro acumulado" color={C.green} windowLabel="histórico" sub={`~$${op?.savings?.perMsg}/msg`} />
        </Grid>

        {/* Atención de mensajes */}
        <SectionTitle badge={rangeLabel} badgeColor={C.blue}
          hint={`Cadencia de atención en el rango y filtros de arriba. Tiempo entre el mensaje del cliente y la primera respuesta del dispatcher (SMS + WhatsApp).`}>
          Atención de mensajes
        </SectionTitle>
        {data?.coverage && data.coverage.daysWithData < data.coverage.requestedDays && (
          <div style={{ fontSize: 12, color: C.amber, background: "#241f0f", border: "1px solid #4a3d14", borderRadius: 10, padding: "9px 13px", marginBottom: 12 }}>
            ⚠️ Historial parcial: datos de <b>{data.coverage.daysWithData}</b> de los <b>{data.coverage.requestedDays}</b> días pedidos{data.coverage.firstDay ? ` (desde ${data.coverage.firstDay})` : ""}. El historial se completa día a día, por eso los rangos largos pueden coincidir por ahora.
          </div>
        )}
        <Grid>
          <Tile value={fmtNum(kpis?.inbound?.total)} label="Mensajes entrantes" color={C.text} windowLabel="rango" />
          <Tile value={fmtNum(r?.count)} label="Respondidos" color={C.blue} windowLabel="rango" />
          <Tile value={fmtMs(r?.avgMs)} label="Tiempo prom. respuesta" color={C.text} windowLabel="rango" />
          <Tile value={fmtMs(r?.p50Ms)} label="Mediana (p50)" color={C.lime} windowLabel="rango" />
          <Tile value={fmtMs(r?.p90Ms)} label="p90" color={C.amber} windowLabel="rango" />
          <Tile value={r?.slaPct != null ? `${r.slaPct}%` : "—"} label={`Dentro de SLA (${kpis?.slaSeconds ?? 300}s)`}
            color={r?.slaPct != null && r.slaPct >= 80 ? C.green : C.red} sub={`${fmtNum(r?.slaBreaches ?? 0)} tardías`} windowLabel="rango" />
        </Grid>

        {/* Detalle */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 18, marginTop: 10, alignItems: "start" }}>
          <Panel>
            <SubTitle>Por dispatcher <span style={{ color: C.faint, fontWeight: 400 }}>· clic para filtrar</span></SubTitle>
            <table style={table}>
              <thead><tr style={thr}><th style={th}>Dispatcher</th><th style={thN}>Respond.</th><th style={thN}>Prom.</th><th style={thN}>Tardías</th></tr></thead>
              <tbody>
                {(kpis?.byUser ?? []).map((u: any) => (
                  <tr key={u.userId} style={{ borderBottom: `1px solid ${C.panel2}`, cursor: "pointer", background: user === u.userId ? `${C.blue}14` : "transparent" }} onClick={() => setUser(u.userId === user ? "" : u.userId)}>
                    <td style={td}>{user === u.userId ? "▸ " : ""}{u.name}</td>
                    <td style={tdN}>{fmtNum(u.count)}</td>
                    <td style={tdN}>{fmtMs(u.avgMs)}</td>
                    <td style={{ ...tdN, color: u.slaBreaches ? C.red : C.faint }}>{fmtNum(u.slaBreaches)}</td>
                  </tr>
                ))}
                {(!kpis?.byUser || kpis.byUser.length === 0) && <tr><td style={{ ...td, color: C.muted }} colSpan={4}>Sin respuestas en el rango.</td></tr>}
              </tbody>
            </table>
            <SubTitle>Por plataforma</SubTitle>
            <table style={table}>
              <thead><tr style={thr}><th style={th}>Plataforma</th><th style={thN}>Respond.</th><th style={thN}>Prom.</th></tr></thead>
              <tbody>
                {Object.entries(kpis?.byPlatform ?? {}).map(([p, v]: any) => (
                  <tr key={p} style={{ borderBottom: `1px solid ${C.panel2}` }}><td style={td}>{PLATFORM_LABEL[p] ?? p}</td><td style={tdN}>{fmtNum(v.count)}</td><td style={tdN}>{fmtMs(v.avgMs)}</td></tr>
                ))}
                {Object.keys(kpis?.byPlatform ?? {}).length === 0 && <tr><td style={{ ...td, color: C.muted }} colSpan={3}>—</td></tr>}
              </tbody>
            </table>
          </Panel>
          <Panel>
            <SubTitle>Distribución de tiempos de respuesta</SubTitle>
            <BarChart labels={r?.histLabels ?? []} values={r?.hist ?? []} color={C.blue} />
            <SubTitle>Mensajes entrantes por hora del día</SubTitle>
            <BarChart labels={Array.from({ length: 24 }, (_, i) => String(i))} values={kpis?.inbound?.byHour ?? []} color={C.purple} dense />
          </Panel>
        </div>

        {error && <p style={{ color: C.red, marginTop: 12 }}>{error}</p>}
        <p style={{ color: C.faint, fontSize: 11, marginTop: 26 }}>
          Rango {data?.range?.from} → {data?.range?.to} · KPIs de atención derivados de las conversaciones de GoHighLevel. Datos operativos en vivo de TaxiCaller / RingCentral.
        </p>
      </div>
    </div>
  );
}

// ── Login ──────────────────────────────────────────────────────────────────
function Login({ onLogin }: { onLogin: (token: string, name: string, role: string) => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!u || !p) return;
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: p }) });
      if (!res.ok) { setErr(res.status === 401 ? "Usuario o contraseña incorrectos" : "Error al ingresar"); return; }
      const j = await res.json();
      localStorage.setItem("tl_dash_token", j.token);
      localStorage.setItem("tl_dash_name", j.name);
      localStorage.setItem("tl_dash_role", j.role);
      onLogin(j.token, j.name, j.role);
    } catch { setErr("Error de red"); } finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: "100vh", background: `radial-gradient(1200px 500px at 50% -10%, #16203010, transparent), ${C.bg}`, color: C.text, display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif", padding: 20 }}>
      <div style={{ width: 360, maxWidth: "100%", background: `linear-gradient(180deg,${C.panel},${C.panel2})`, border: `1px solid ${C.border}`, borderRadius: 18, padding: "30px 26px", boxShadow: "0 20px 60px #00000060" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 22 }}>
          <div style={{ width: 14, height: 14, borderRadius: 4, background: C.accent, boxShadow: `0 0 14px ${C.accent}88` }} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5 }}>TAXI LASER</div>
            <div style={{ fontSize: 10.5, color: C.muted, letterSpacing: 1, textTransform: "uppercase" }}>Panel de Control · KPI</div>
          </div>
        </div>
        <label style={{ fontSize: 12, color: C.muted }}>Usuario</label>
        <input value={u} onChange={(e) => setU(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder="tu usuario" style={field} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <label style={{ fontSize: 12, color: C.muted, marginTop: 12, display: "block" }}>Contraseña</label>
        <input value={p} onChange={(e) => setP(e.target.value)} type="password" placeholder="••••••••" style={field} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <button onClick={submit} disabled={busy} style={{ ...primaryBtn, marginTop: 20, opacity: busy ? 0.6 : 1 }}>{busy ? "Ingresando…" : "Ingresar"}</button>
        {err && <p style={{ color: C.red, fontSize: 13, marginTop: 12, textAlign: "center" }}>{err}</p>}
      </div>
    </div>
  );
}

// ── Componentes ──────────────────────────────────────────────────────────────
function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(168px,1fr))", gap: 12 }}>{children}</div>;
}
function Panel({ children }: { children: React.ReactNode }) {
  return <div style={{ background: `linear-gradient(180deg,${C.panel},${C.panel2})`, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 16px" }}>{children}</div>;
}
function SectionTitle({ children, hint, badge, badgeColor }: { children: React.ReactNode; hint?: string; badge?: string; badgeColor?: string }) {
  const col = badgeColor ?? C.blue;
  return (
    <div style={{ margin: "24px 0 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 15, textTransform: "uppercase", letterSpacing: 0.7, color: C.text, margin: 0, fontWeight: 700 }}>{children}</h2>
        {badge && <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: col, background: `${col}18`, border: `1px solid ${col}44`, borderRadius: 6, padding: "2px 8px" }}>{badge}</span>}
      </div>
      {hint && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4, maxWidth: 820 }}>{hint}</div>}
    </div>
  );
}
function SubTitle({ children }: { children: React.ReactNode }) {
  return <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, color: C.muted, margin: "6px 0 10px", fontWeight: 600 }}>{children}</h3>;
}
function Tile({ value, label, color, sub, pending, windowLabel }: { value: any; label: string; color?: string; sub?: string; pending?: boolean; windowLabel?: string }) {
  return (
    <div style={{ position: "relative", background: `linear-gradient(180deg,${C.panel},${C.panel2})`, border: `1px solid ${pending ? "#3f2d1a" : C.border}`, borderRadius: 13, padding: "14px 16px", opacity: pending ? 0.72 : 1, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: color ?? C.text, opacity: 0.55 }} />
      {windowLabel && <div style={{ position: "absolute", top: 10, right: 11, fontSize: 8.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>{windowLabel}</div>}
      <div style={{ fontSize: 25, fontWeight: 800, color: color ?? C.text, lineHeight: 1.1 }}>{value}{pending && <span style={{ fontSize: 9, color: C.amber, marginLeft: 6, verticalAlign: "middle" }}>pendiente</span>}</div>
      <div style={{ fontSize: 10.5, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 5 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: C.faint, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
function BarChart({ labels, values, color, dense }: { labels: string[]; values: number[]; color: string; dense?: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: dense ? 2 : 6, height: 130, padding: "10px 4px 4px" }}>
      {values.map((v, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }} title={`${labels[i]}: ${v}`}>
          <div style={{ fontSize: 8.5, color: C.faint }}>{v || ""}</div>
          <div style={{ width: "100%", background: `linear-gradient(180deg,${color},${color}66)`, borderRadius: "3px 3px 0 0", height: `${(v / max) * 100}%`, minHeight: v ? 3 : 0, transition: "height .3s" }} />
          <div style={{ fontSize: dense ? 8 : 9, color: C.faint, marginTop: 3 }}>{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}

// ── Estilos ──────────────────────────────────────────────────────────────────
const iconBtn: React.CSSProperties = { background: C.panel, border: `1px solid ${C.border}`, color: C.text, borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 15 };
const field: React.CSSProperties = { width: "100%", padding: "11px 13px", marginTop: 6, borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, fontSize: 15, boxSizing: "border-box" };
const primaryBtn: React.CSSProperties = { width: "100%", padding: "12px", borderRadius: 10, border: "none", background: C.accent, color: "#1a1500", fontSize: 15, fontWeight: 700, cursor: "pointer" };
const chip: React.CSSProperties = { padding: "6px 13px", borderRadius: 20, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, fontSize: 12, cursor: "pointer" };
const chipActive: React.CSSProperties = { ...chip, background: C.blue, borderColor: C.blue, color: "white", fontWeight: 700 };
const select: React.CSSProperties = { padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, fontSize: 13 };
const dateInput: React.CSSProperties = { padding: "7px 8px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, fontSize: 13, marginLeft: 6 };
const lbl: React.CSSProperties = { fontSize: 12, color: C.muted, display: "flex", alignItems: "center" };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 6 };
const thr: React.CSSProperties = { textAlign: "left", color: C.muted, borderBottom: `1px solid ${C.border}` };
const th: React.CSSProperties = { padding: "8px 8px", fontWeight: 500, whiteSpace: "nowrap" };
const thN: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "8px 8px", whiteSpace: "nowrap" };
const tdN: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
