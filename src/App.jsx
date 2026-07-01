import React, { useState, useEffect, useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import { supabase, signInWithGoogle, signOut } from "./supabase";
/* =========================================================================
   ChargeLog — บันทึกการชาร์จ EV  (เก็บถาวรด้วย window.storage)
   ========================================================================= */
const ALL = "ALL";

const COLORS = {
  bg: "#EEF1EA", surface: "#FFFFFF", ink: "#11201A", muted: "#5C6E64", faint: "#90A096",
  line: "#DCE3DC", teal: "#27C16F", tealDeep: "#0B1812", clusterAlt: "#16281F", green: "#7BE3A6",
  blue: "#3DA9FC", amber: "#F2A93B", violet: "#8B7CF6",
};
const LOCATIONS = ["Home (ชาร์จบ้าน)", "ที่ทำงาน", "สถานีชาร์จ", "อื่นๆ"];
const TH_M = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

/* ---------- helpers ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
const pad = (x) => String(x).padStart(2, "0");
const fmtNum = (n, d = 2) => (Number(n) || 0).toLocaleString("th-TH", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBaht = (n) => "฿" + (Number(n) || 0).toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

const nowLocalISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const thaiDateTime = (dt) => {
  if (!dt) return "";
  const [date, time] = dt.split("T");
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${TH_M[m - 1]} ${(y + 543) % 100}${time ? "  " + time : ""}`;
};
const thaiDateShort = (dt) => {
  const [, m, d] = (dt || "").split("T")[0].split("-").map(Number);
  return `${d} ${TH_M[m - 1]}`;
};
const monthKey = (dt) => (dt || "").slice(0, 7);
const thaiMonthLabel = (key) => {
  const [y, m] = key.split("-").map(Number);
  return `${TH_M[m - 1]} ${(y + 543) % 100}`;
};

/* per-session cost */
function deriveCost(s, defaultRate) {
  const kwh = num(s.kwh), ppu = num(s.pricePerUnit), total = num(s.totalCost);
  let cost = 0;
  if (total != null && total > 0) cost = total;
  else if (kwh != null && ppu != null) cost = kwh * ppu;
  else if (kwh != null) cost = kwh * (defaultRate || 0);
  const rate = kwh && cost ? cost / kwh : ppu != null ? ppu : defaultRate || 0;
  const added = num(s.endPercent) != null && num(s.startPercent) != null ? num(s.endPercent) - num(s.startPercent) : null;
  return { kwh: kwh || 0, cost, rate, added, carEff: num(s.efficiency) };
}

/* distance map for one vehicle, baseline = startOdo */
function distanceMapFor(vehicleSessions, startOdo) {
  const asc = [...vehicleSessions].sort((a, b) => (a.datetime < b.datetime ? -1 : 1));
  const map = {};
  let prev = num(startOdo);
  for (const s of asc) {
    const odo = num(s.odometer);
    if (odo != null && prev != null && odo >= prev) map[s.id] = odo - prev;
    else map[s.id] = null;
    if (odo != null) prev = odo;
  }
  return map;
}
const tripDefault = (startOdo) => ({ startOdo: num(startOdo) || 0, startAt: "1970-01-01T00:00" });

/* % แบตที่ใช้ตอนขับ (ระหว่างจบชาร์จรอบก่อน ถึงเริ่มชาร์จรอบนี้) สำหรับรถคันเดียว */
function percentUsedMapFor(vehicleSessions) {
  const asc = [...vehicleSessions].sort((a, b) => (a.datetime < b.datetime ? -1 : 1));
  const map = {};
  let prevEnd = null;
  for (const s of asc) {
    const startP = num(s.startPercent);
    if (startP != null && prevEnd != null && prevEnd >= startP) map[s.id] = prevEnd - startP;
    else map[s.id] = null;
    const endP = num(s.endPercent);
    if (endP != null) prevEnd = endP;
  }
  return map;
}

/* generate realistic-looking mock charging history for testing */
/* ============================ APP ============================ */
export default function App() {
  const [sessions, setSessions] = useState([]);
  const [settings, setSettings] = useState({
    rate: 3.5,
    vehicles: [{ id: "v1", name: "Jaecoo 5 EV", startOdo: 0, tripA: tripDefault(0), tripB: tripDefault(0) }],
    activeVehicle: "v1",
  });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("dash");
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showVehicles, setShowVehicles] = useState(false);
  const [tripVehicleId, setTripVehicleId] = useState(null);

  const today = new Date();
  const [pmode, setPmode] = useState("M"); // D | M | Y | All
  const [psel, setPsel] = useState({ y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() });

  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    // ตรวจสอบ session เมื่อเปิดแอป
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) loadData(session.user.id);
      else { setLoading(false); setAuthChecked(true); }
    });
    // ฟัง auth state changes (login/logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      setAuthChecked(true);
      if (u) loadData(u.id);
      else { setSessions([]); setLoading(false); }
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadData = async (uid) => {
    try {
      const { data: sessData } = await supabase
        .from('sessions').select('*').eq('user_id', uid).order('datetime', { ascending: true });
      if (sessData && sessData.length) {
        const mapped = sessData.map((row) => ({
          id: row.id, vehicleId: row.vehicle_id, datetime: row.datetime,
          chargeType: row.charge_type, location: row.location,
          odometer: row.odometer ?? "", kwh: row.kwh ?? "",
          pricePerUnit: row.price_per_unit ?? "", totalCost: row.total_cost ?? "",
          startPercent: row.start_percent ?? "", endPercent: row.end_percent ?? "",
          efficiency: row.efficiency ?? "", note: row.note ?? "",
        }));
        setSessions(mapped);
      }
    } catch (e) { console.error('load sessions error', e); }
    try {
      const { data: stData } = await supabase
        .from('user_settings').select('data').eq('user_id', uid).single();
      if (stData && stData.data) {
        const st = stData.data;
        if (!st.vehicles || !st.vehicles.length) st.vehicles = [{ id: "v1", name: "Jaecoo 5 EV", startOdo: 0 }];
        st.vehicles = st.vehicles.map((v) => ({
          startOdo: 0, ...v,
          tripA: v.tripA || tripDefault(v.startOdo || 0),
          tripB: v.tripB || tripDefault(v.startOdo || 0),
        }));
        if (!st.activeVehicle) st.activeVehicle = st.vehicles[0].id;
        setSettings(st);
      }
    } catch (e) { console.error('load settings error', e); }
    setLoading(false);
    setAuthChecked(true);
  };

  const persistSessions = async (next) => {
    setSessions(next);
    const uid = user?.id; if (!uid) return;
    try {
      const { data: existing } = await supabase.from('sessions').select('id').eq('user_id', uid);
      const existingIds = new Set((existing || []).map((r) => r.id));
      const nextIds = new Set(next.map((s) => s.id));
      const toDelete = [...existingIds].filter((id) => !nextIds.has(id));
      if (toDelete.length) await supabase.from('sessions').delete().in('id', toDelete);
      if (next.length) {
        const rows = next.map((s) => ({
          id: s.id, user_id: uid, vehicle_id: s.vehicleId || "",
          datetime: s.datetime || "", charge_type: s.chargeType || "AC",
          location: s.location || "",
          odometer: s.odometer === "" ? null : Number(s.odometer) || null,
          kwh: s.kwh === "" ? null : Number(s.kwh) || null,
          price_per_unit: s.pricePerUnit === "" ? null : Number(s.pricePerUnit) || null,
          total_cost: s.totalCost === "" ? null : Number(s.totalCost) || null,
          start_percent: s.startPercent === "" ? null : Number(s.startPercent) || null,
          end_percent: s.endPercent === "" ? null : Number(s.endPercent) || null,
          efficiency: s.efficiency === "" ? null : Number(s.efficiency) || null,
          note: s.note || "",
        }));
        await supabase.from('sessions').upsert(rows);
      }
    } catch (e) { console.error('persist sessions error', e); }
  };

  const persistSettings = async (next) => {
    setSettings(next);
    const uid = user?.id; if (!uid) return;
    try {
      await supabase.from('user_settings').upsert({ user_id: uid, data: next, updated_at: new Date().toISOString() });
    } catch (e) { console.error('persist settings error', e); }
  };

  const isAll = settings.activeVehicle === ALL;
  const activeV = isAll ? null : settings.vehicles.find((v) => v.id === settings.activeVehicle) || settings.vehicles[0];

  const saveSession = (data) => {
    const vid = data.vehicleId || (activeV ? activeV.id : settings.vehicles[0].id);
    const rec = { ...data, vehicleId: vid };
    if (editing) persistSessions(sessions.map((s) => (s.id === editing.id ? { ...rec, id: editing.id } : s)));
    else persistSessions([...sessions, { ...rec, id: uid() }]);
    setShowForm(false); setEditing(null);
  };
  const deleteSession = (id) => persistSessions(sessions.filter((s) => s.id !== id));

  const removeVehicle = (id) => {
    const left = settings.vehicles.filter((v) => v.id !== id);
    let nextActive = settings.activeVehicle;
    if (settings.activeVehicle === id) nextActive = left.length ? left[0].id : ALL;
    persistSessions(sessions.filter((s) => s.vehicleId !== id));
    persistSettings({ ...settings, vehicles: left, activeVehicle: nextActive });
  };

  const openNew = () => { setEditing(null); setShowForm(true); };
  const openEdit = (s) => { setEditing(s); setShowForm(true); };

  /* scope sessions by vehicle (or all) */
  const scopeSessions = useMemo(
    () => (isAll ? sessions : sessions.filter((s) => (s.vehicleId || settings.vehicles[0]?.id) === settings.activeVehicle)),
    [sessions, isAll, settings.activeVehicle, settings.vehicles]
  );

  /* distance map (merge per-vehicle) */
  const distMap = useMemo(() => {
    if (isAll) {
      const map = {};
      settings.vehicles.forEach((v) => {
        const vs = sessions.filter((s) => (s.vehicleId || settings.vehicles[0]?.id) === v.id);
        Object.assign(map, distanceMapFor(vs, v.startOdo));
      });
      return map;
    }
    return distanceMapFor(scopeSessions, activeV ? activeV.startOdo : 0);
  }, [isAll, sessions, settings.vehicles, scopeSessions, activeV]);

  /* % แบตที่ใช้ตอนขับ ก่อนชาร์จรอบนั้นๆ (รวมทุกคันถ้าเลือก All) */
  const percentMap = useMemo(() => {
    if (isAll) {
      const map = {};
      settings.vehicles.forEach((v) => {
        const vs = sessions.filter((s) => (s.vehicleId || settings.vehicles[0]?.id) === v.id);
        Object.assign(map, percentUsedMapFor(vs));
      });
      return map;
    }
    return percentUsedMapFor(scopeSessions);
  }, [isAll, sessions, settings.vehicles, scopeSessions]);

  const sorted = useMemo(
    () => [...scopeSessions].sort((a, b) => (a.datetime < b.datetime ? 1 : a.datetime > b.datetime ? -1 : 0)),
    [scopeSessions]
  );

  /* period filter */
  const inPeriod = (dt) => {
    if (pmode === "All") return true;
    const [date] = (dt || "").split("T");
    const [y, m, d] = date.split("-").map(Number);
    if (pmode === "Y") return y === psel.y;
    if (pmode === "M") return y === psel.y && m === psel.m;
    if (pmode === "D") return y === psel.y && m === psel.m && d === psel.d;
    return true;
  };
  const filtered = useMemo(() => sorted.filter((s) => inPeriod(s.datetime)), [sorted, pmode, psel]);

  const stats = useMemo(() => {
    let kwh = 0, cost = 0, dist = 0, added = 0, acKwh = 0, acCost = 0, dcKwh = 0, dcCost = 0;
    let kwhForPctSum = 0, pctAddedSum = 0, effSum = 0, effN = 0;
    let distForPctUsedSum = 0, pctUsedSum = 0;
    filtered.forEach((s) => {
      const d = deriveCost(s, settings.rate);
      kwh += d.kwh; cost += d.cost;
      if (d.added != null) added += d.added;
      const di = distMap[s.id]; if (di != null) dist += di;
      if (s.chargeType === "DC") { dcKwh += d.kwh; dcCost += d.cost; } else { acKwh += d.kwh; acCost += d.cost; }
      if (d.added != null && d.added > 0 && d.kwh > 0) { kwhForPctSum += d.kwh; pctAddedSum += d.added; }
      if (d.carEff != null && d.carEff > 0) { effSum += d.carEff; effN++; }
      const pu = percentMap[s.id];
      if (pu != null && pu > 0 && di != null && di > 0) { distForPctUsedSum += di; pctUsedSum += pu; }
    });
    let curOdo = null;
    if (!isAll) {
      const odos = scopeSessions.map((s) => num(s.odometer)).filter((x) => x != null);
      curOdo = odos.length ? Math.max(...odos) : null;
    }
    const n = filtered.length;
    const wallEff = dist > 0 ? (kwh / dist) * 100 : null;
    const carEff = effN ? effSum / effN : null;
    const avgKmPerPercentUsed = pctUsedSum > 0 ? distForPctUsedSum / pctUsedSum : null;
    return {
      n, kwh, cost, dist, added, avgKwh: n ? kwh / n : 0,
      wallEff,
      costPerKm: dist > 0 ? cost / dist : null,
      avgKwhPerPercent: pctAddedSum > 0 ? kwhForPctSum / pctAddedSum : null,
      avgKmPerKwh: dist > 0 && kwh > 0 ? dist / kwh : null,
      avgKmPerPercentUsed,
      estFullRange: avgKmPerPercentUsed != null ? avgKmPerPercentUsed * 100 : null,
      carEff,
      chargingLossPct: wallEff != null && wallEff > 0 && carEff != null ? ((wallEff - carEff) / wallEff) * 100 : null,
      curOdo, acKwh, acCost, dcKwh, dcCost,
    };
  }, [filtered, distMap, percentMap, scopeSessions, settings.rate, isAll]);

  const years = useMemo(() => {
    const ys = sessions.map((s) => Number((s.datetime || "").slice(0, 4))).filter(Boolean);
    const min = ys.length ? Math.min(...ys) : today.getFullYear();
    const max = Math.max(today.getFullYear(), ys.length ? Math.max(...ys) : today.getFullYear());
    const out = []; for (let y = max; y >= min; y--) out.push(y); return out;
  }, [sessions]);

  if (!authChecked || loading) {
    return (<div style={styles.page}><Fonts /><div style={{ ...styles.shell, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh", color: COLORS.muted }}>กำลังโหลด…</div></div>);
  }

  if (!user) {
    return (
      <div style={styles.page}>
        <Fonts />
        <div style={{ ...styles.shell, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: 20, textAlign: "center" }}>
          <div style={{ width: 80, height: 80, borderRadius: 24, background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.green})`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 12px 26px rgba(14,124,102,0.3)" }}>
            <BoltIcon big />
          </div>
          <div style={{ fontFamily: "'IBM Plex Sans Thai', sans-serif", fontWeight: 700, fontSize: 26, color: COLORS.ink }}>ChargeLog</div>
          <div style={{ fontSize: 14, color: COLORS.muted, maxWidth: 280, lineHeight: 1.6 }}>บันทึกการชาร์จ EV ที่บ้าน คำนวณค่าไฟ ระยะทาง และประสิทธิภาพอัตโนมัติ</div>
          <button onClick={signInWithGoogle} style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1.5px solid #DCE3DC", borderRadius: 14, padding: "14px 24px", fontSize: 15, fontWeight: 600, cursor: "pointer", color: COLORS.ink, boxShadow: "0 4px 12px rgba(0,0,0,0.08)", fontFamily: "'IBM Plex Sans Thai', sans-serif" }}>
            <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            Sign in with Google
          </button>
          <div style={{ fontSize: 12, color: COLORS.faint, marginTop: 8 }}>เปลี่ยนมือถือหรืออุปกรณ์ ข้อมูลก็ยังอยู่ครบ</div>
        </div>
      </div>
    );
  }

  const headerName = isAll ? "ทุกคัน (All Cars)" : activeV.name;

  return (
    <div style={styles.page}>
      <Fonts />
      <div style={styles.shell}>
        <header style={styles.header}>
          <button style={styles.vehiclePick} onClick={() => setShowVehicles(true)}>
            <span style={styles.carDot}>{isAll ? <CarsIcon /> : <CarIcon />}</span>
            <span style={styles.vehicleName}>{headerName}</span>
            <ChevronIcon />
          </button>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: COLORS.faint, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.email}</div>
            </div>
            <button style={styles.gear} onClick={() => setShowSettings(true)} aria-label="ตั้งค่า"><GearIcon /></button>
            <button style={{ ...styles.gear, fontSize: 16 }} onClick={signOut} title="ออกจากระบบ">⏏</button>
          </div>
        </header>

        <div style={styles.segment}>
          <button style={{ ...styles.segBtn, ...(tab === "dash" ? styles.segActive : {}) }} onClick={() => setTab("dash")}>ภาพรวม</button>
          <button style={{ ...styles.segBtn, ...(tab === "history" ? styles.segActive : {}) }} onClick={() => setTab("history")}>ประวัติ</button>
        </div>

        {tab === "dash" ? (
          <Dashboard
            stats={stats} filtered={filtered} allSorted={sorted} distMap={distMap}
            rate={settings.rate} isAll={isAll} vehicles={settings.vehicles}
            pmode={pmode} setPmode={setPmode} psel={psel} setPsel={setPsel} years={years}
            onAdd={openNew}
          />
        ) : (
          <History sorted={sorted} distMap={distMap} percentMap={percentMap} rate={settings.rate} isAll={isAll}
            vehicles={settings.vehicles} onAdd={openNew} onEdit={openEdit} onDelete={deleteSession} />
        )}
      </div>

      {showForm && (
        <SessionForm
          initial={editing} defaultRate={settings.rate} vehicles={settings.vehicles}
          defaultVehicleId={editing ? editing.vehicleId : activeV ? activeV.id : settings.vehicles[0].id}
          lastOdoFor={(vid) => {
            const odos = sessions.filter((s) => s.vehicleId === vid).map((s) => num(s.odometer)).filter((x) => x != null);
            const v = settings.vehicles.find((x) => x.id === vid);
            const base = v ? num(v.startOdo) : null;
            return odos.length ? Math.max(...odos) : base;
          }}
          onCancel={() => { setShowForm(false); setEditing(null); }} onSave={saveSession}
        />
      )}
      {showSettings && (
        <SettingsSheet settings={settings} sessions={sessions}
          onSave={persistSettings} onClose={() => setShowSettings(false)} onClearAll={() => persistSessions([])} />
      )}
      {showVehicles && (
        <VehicleSheet settings={settings} sessions={sessions} onSave={persistSettings} onClose={() => setShowVehicles(false)}
          onOpenTrip={(vid) => { setTripVehicleId(vid); setShowVehicles(false); }} onRemoveVehicle={removeVehicle} />
      )}
      {tripVehicleId && (
        <TripSheet
          vehicle={settings.vehicles.find((v) => v.id === tripVehicleId)}
          sessions={sessions.filter((s) => s.vehicleId === tripVehicleId)}
          rate={settings.rate}
          onReset={(key) => {
            const v = settings.vehicles.find((x) => x.id === tripVehicleId);
            const odos = sessions.filter((s) => s.vehicleId === tripVehicleId).map((s) => num(s.odometer)).filter((x) => x != null);
            const cur = odos.length ? Math.max(...odos) : num(v.startOdo) || 0;
            const nv = settings.vehicles.map((x) => x.id === tripVehicleId ? { ...x, [key]: { startOdo: cur, startAt: nowLocalISO() } } : x);
            persistSettings({ ...settings, vehicles: nv });
          }}
          onClose={() => setTripVehicleId(null)}
        />
      )}
    </div>
  );
}

/* ============================ PERIOD SELECTOR ============================ */
function PeriodSelector({ pmode, setPmode, psel, setPsel, years }) {
  const maxDay = daysInMonth(psel.y, psel.m);
  const yDis = pmode === "All", mDis = pmode === "All" || pmode === "Y", dDis = pmode !== "D";
  const upd = (k) => (e) => setPsel({ ...psel, [k]: Number(e.target.value) });
  return (
    <div style={styles.periodWrap}>
      <div style={styles.periodTop}>
        <span style={styles.periodTitle}>ช่วงเวลา:</span>
        <div style={styles.selRow}>
          <select value={psel.y} onChange={upd("y")} disabled={yDis} style={{ ...styles.sel, ...(yDis ? styles.selDis : {}) }}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={psel.m} onChange={upd("m")} disabled={mDis} style={{ ...styles.sel, ...(mDis ? styles.selDis : {}) }}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{pad(m)}</option>)}
          </select>
          <select value={Math.min(psel.d, maxDay)} onChange={upd("d")} disabled={dDis} style={{ ...styles.sel, ...(dDis ? styles.selDis : {}) }}>
            {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{pad(d)}</option>)}
          </select>
        </div>
      </div>
      <div style={styles.modeRow}>
        {[["D", "วัน"], ["M", "เดือน"], ["Y", "ปี"], ["All", "ทั้งหมด"]].map(([k, l]) => (
          <button key={k} onClick={() => setPmode(k)} style={{ ...styles.modeBtn, ...(pmode === k ? styles.modeOn : {}) }}>
            {k === "All" ? "All" : k}<span style={styles.modeSub}>{l}</span>
          </button>
        ))}
      </div>
      <div style={styles.periodHint}>เปลี่ยนเฉพาะช่วงที่แสดงผลเท่านั้น ยอดเงินจริงไม่ถูกแปลง</div>
    </div>
  );
}

function periodLabel(pmode, psel) {
  if (pmode === "All") return "ทั้งหมด";
  if (pmode === "Y") return `ปี ${psel.y + 543}`;
  if (pmode === "M") return `${TH_M[psel.m - 1]} ${(psel.y + 543) % 100}`;
  return `${psel.d} ${TH_M[psel.m - 1]} ${(psel.y + 543) % 100}`;
}

/* ============================ DASHBOARD ============================ */
function Dashboard({ stats, filtered, allSorted, distMap, rate, isAll, vehicles, pmode, setPmode, psel, setPsel, years, onAdd }) {
  if (allSorted.length === 0) return (<><EmptyState onAdd={onAdd} /></>);

  const asc = [...filtered].sort((a, b) => (a.datetime < b.datetime ? -1 : 1));
  const sessionBars = asc.slice(-14).map((s) => ({ name: thaiDateShort(s.datetime), kwh: deriveCost(s, rate).kwh }));
  const cpkLine = asc.filter((s) => distMap[s.id] && distMap[s.id] > 0).slice(-14)
    .map((s) => ({ name: thaiDateShort(s.datetime), cpk: deriveCost(s, rate).cost / distMap[s.id] }));
  const wallEffLine = asc.filter((s) => distMap[s.id] > 0 && deriveCost(s, rate).kwh > 0).slice(-14)
    .map((s) => ({ name: thaiDateShort(s.datetime), val: (deriveCost(s, rate).kwh / distMap[s.id]) * 100 }));
  const kwhPctLine = asc.filter((s) => { const d = deriveCost(s, rate); return d.added > 0 && d.kwh > 0; }).slice(-14)
    .map((s) => { const d = deriveCost(s, rate); return { name: thaiDateShort(s.datetime), val: d.kwh / d.added }; });
  const kmPerKwhLine = asc.filter((s) => distMap[s.id] > 0 && deriveCost(s, rate).kwh > 0).slice(-14)
    .map((s) => ({ name: thaiDateShort(s.datetime), val: distMap[s.id] / deriveCost(s, rate).kwh }));
  /* กราฟเปรียบเทียบ มิเตอร์ vs รถบอก — เฉพาะรายการที่มีทั้งคู่ */
  const effCompareLine = asc.filter((s) => {
    const d = deriveCost(s, rate);
    return distMap[s.id] > 0 && d.kwh > 0 && d.carEff != null;
  }).slice(-14).map((s) => {
    const d = deriveCost(s, rate);
    const wall = (d.kwh / distMap[s.id]) * 100;
    return { name: thaiDateShort(s.datetime), มิเตอร์: Math.round(wall * 10) / 10, รถบอก: d.carEff };
  });
  const monthMap = {};
  allSorted.forEach((s) => { const k = monthKey(s.datetime); monthMap[k] = (monthMap[k] || 0) + deriveCost(s, rate).cost; });
  const monthBars = Object.keys(monthMap).sort().slice(-8).map((k) => ({ name: thaiMonthLabel(k), cost: Math.round(monthMap[k]) }));

  const totalACDC = stats.acKwh + stats.dcKwh;
  const acPct = totalACDC > 0 ? (stats.acKwh / totalACDC) * 100 : 0;

  return (
    <div style={{ paddingBottom: 28 }}>
      <div style={styles.hero}>
        <div style={styles.heroScan} />
        <div style={styles.heroGlow} />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={styles.heroLabel}>ค่าใช้จ่ายรวม · {periodLabel(pmode, psel)}</div>
          <div style={styles.heroValue}>{fmtBaht(stats.cost)}</div>
          {!isAll && stats.curOdo != null && <div style={styles.odoChip}>เลขไมล์ล่าสุด: {fmtNum(stats.curOdo, 0)} km</div>}
          {isAll && <div style={styles.odoChip}>รวม {vehicles.length} คัน</div>}
          <div style={styles.heroFlow}><div style={styles.heroFlowFill} /></div>
          <div style={styles.heroRow}>
            <HeroStat label="ชาร์จไป" value={`${fmtNum(stats.kwh, 1)} kWh`} />
            <HeroStat label="ระยะทางวิ่ง" value={stats.dist > 0 ? `${fmtNum(stats.dist, 0)} km` : "—"} />
            <HeroStat label="จำนวนครั้ง" value={`${stats.n}`} />
          </div>
        </div>
      </div>

      <PeriodSelector pmode={pmode} setPmode={setPmode} psel={psel} setPsel={setPsel} years={years} />

      {filtered.length === 0 && (
        <div style={styles.noDataBanner}>ไม่มีข้อมูลการชาร์จในช่วงเวลานี้ — ลองเปลี่ยนช่วงเวลาที่เลือกด้านบน</div>
      )}

      <UsageAverageCard stats={stats} />

      {totalACDC > 0 && (
        <div style={styles.splitCard}>
          <div style={styles.splitHead}>สัดส่วนการชาร์จ AC / DC</div>
          <div style={styles.splitBar}>
            <div style={{ width: `${acPct}%`, background: COLORS.blue, height: "100%" }} />
            <div style={{ width: `${100 - acPct}%`, background: COLORS.amber, height: "100%" }} />
          </div>
          <div style={styles.splitLegend}>
            <div><span style={{ ...styles.legDot, background: COLORS.blue }} />AC ปกติ · {fmtNum(stats.acKwh, 1)} kWh · {fmtBaht(stats.acCost)}</div>
            <div><span style={{ ...styles.legDot, background: COLORS.amber }} />DC เร็ว · {fmtNum(stats.dcKwh, 1)} kWh · {fmtBaht(stats.dcCost)}</div>
          </div>
        </div>
      )}

      <div style={styles.grid2}>
        <MiniCard accent={COLORS.amber} label="เฉลี่ยต่อระยะทาง" value={stats.costPerKm != null ? fmtNum(stats.costPerKm, 2) : "N/A"} unit="บาท/กม." hint={stats.dist > 0 ? `ขับรวม ${fmtNum(stats.dist, 0)} กม.` : "เพิ่มเลขไมล์เพื่อคำนวณ"} />
        <MiniCard accent={COLORS.teal} label="อัตรากินไฟ (มิเตอร์)" value={stats.wallEff != null ? fmtNum(stats.wallEff, 1) : "N/A"} unit="kWh/100km" hint="วัดจากหน้าบ้าน" />
        <MiniCard accent={COLORS.blue} label="อัตรากินไฟ (รถบอก)" value={stats.carEff != null ? fmtNum(stats.carEff, 1) : "N/A"} unit="kWh/100km" hint={stats.carEff != null ? "ค่าจากแอปรถ" : "ยังไม่มีข้อมูล"} />
        <MiniCard accent={COLORS.green} label="แบตที่เติม" value={fmtNum(stats.added, 0)} unit="%" hint="รวมทุกครั้งในช่วงนี้" />
      </div>

      <ChargingLossCard stats={stats} />

      <ChartCard title="หน่วยที่ชาร์จต่อครั้ง" sub="kWh">
        {sessionBars.length === 0 ? <NoChart /> : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={sessionBars} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={COLORS.line} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: COLORS.faint }} interval="preserveEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: COLORS.faint }} axisLine={false} tickLine={false} />
              <Tooltip content={<TipKwh />} cursor={{ fill: "rgba(14,124,102,0.06)" }} />
              <Bar dataKey="kwh" radius={[6, 6, 0, 0]}>{sessionBars.map((_, i) => <Cell key={i} fill={COLORS.teal} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {cpkLine.length >= 2 && (
        <ChartCard title="ต้นทุนค่าไฟต่อกิโลเมตร — รายครั้ง" sub="บาท/กม. (ดูย้อนหลังได้)">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={cpkLine} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={COLORS.line} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: COLORS.faint }} interval="preserveEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: COLORS.faint }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
              <Tooltip content={<TipCpk />} />
              <Line type="monotone" dataKey="cpk" stroke={COLORS.amber} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.amber }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {wallEffLine.length >= 2 && (
        <ChartCard title="อัตรากินไฟ — รายครั้ง" sub="kWh/100km (วัดจากมิเตอร์จริง) — ยิ่งต่ำยิ่งประหยัด">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={wallEffLine} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={COLORS.line} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: COLORS.faint }} interval="preserveEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: COLORS.faint }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
              <Tooltip content={<TipWallEff />} />
              <Line type="monotone" dataKey="val" stroke={COLORS.teal} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.teal }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {effCompareLine.length >= 2 && (
        <ChartCard title="มิเตอร์บ้าน vs รถบอก — รายครั้ง" sub="kWh/100km · ส่วนต่างคือ Charging Loss">
          <div style={{ display: "flex", gap: 14, padding: "2px 4px 8px", fontSize: 11.5, fontWeight: 600 }}>
            <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 999, background: COLORS.teal, marginRight: 5, verticalAlign: "middle" }} />มิเตอร์บ้าน</span>
            <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 999, background: COLORS.blue, marginRight: 5, verticalAlign: "middle" }} />รถบอก</span>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={effCompareLine} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={COLORS.line} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: COLORS.faint }} interval="preserveEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: COLORS.faint }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
              <Tooltip content={<TipEffCompare />} />
              <Line type="monotone" dataKey="มิเตอร์" stroke={COLORS.teal} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.teal }} activeDot={{ r: 5 }} />
              <Line type="monotone" dataKey="รถบอก" stroke={COLORS.blue} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.blue }} activeDot={{ r: 5 }} strokeDasharray="5 3" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {kwhPctLine.length >= 2 && (
        <ChartCard title="ไฟที่ใช้ชาร์จต่อ 1% แบต — รายครั้ง" sub="kWh / 1%">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={kwhPctLine} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={COLORS.line} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: COLORS.faint }} interval="preserveEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: COLORS.faint }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
              <Tooltip content={<TipKwhPct />} />
              <Line type="monotone" dataKey="val" stroke={COLORS.violet} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.violet }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {kmPerKwhLine.length >= 2 && (
        <ChartCard title="ระยะทางที่วิ่งได้ต่อหน่วยไฟ — รายครั้ง" sub="กม. / kWh — ยิ่งสูงยิ่งประหยัด">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={kmPerKwhLine} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={COLORS.line} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: COLORS.faint }} interval="preserveEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: COLORS.faint }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
              <Tooltip content={<TipKmKwh />} />
              <Line type="monotone" dataKey="val" stroke={COLORS.teal} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.teal }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {monthBars.length >= 2 && (
        <ChartCard title="ค่าไฟรายเดือน" sub="บาท · แสดงทุกเดือนเสมอ ไม่ขึ้นกับตัวกรองช่วงเวลาด้านบน">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={monthBars} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={COLORS.line} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: COLORS.faint }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: COLORS.faint }} axisLine={false} tickLine={false} />
              <Tooltip content={<TipBaht />} cursor={{ fill: "rgba(232,148,26,0.06)" }} />
              <Bar dataKey="cost" radius={[6, 6, 0, 0]}>{monthBars.map((_, i) => <Cell key={i} fill={COLORS.amber} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      <button style={styles.addWide} onClick={onAdd}><PlusIcon /> จดบันทึก</button>
    </div>
  );
}

function HeroStat({ label, value }) {
  return (<div style={{ flex: 1 }}><div style={styles.heroStatVal}>{value}</div><div style={styles.heroStatLabel}>{label}</div></div>);
}
function UsageAverageCard({ stats }) {
  const has = stats.avgKwhPerPercent != null || stats.avgKmPerKwh != null || stats.avgKmPerPercentUsed != null;
  if (!has) return null;
  return (
    <div style={styles.usageCard}>
      <div style={styles.usageHead}>ค่าเฉลี่ยการใช้งาน</div>
      <div style={styles.usageGrid}>
        <div style={styles.usageItem}>
          <div style={{ ...styles.usageVal, color: COLORS.tealDeep }}>{stats.avgKmPerPercentUsed != null ? fmtNum(stats.avgKmPerPercentUsed, 2) : "—"}</div>
          <div style={styles.usageLabel}>กม. / 1% แบต</div>
          <div style={styles.usageSub}>{stats.estFullRange != null ? `เต็มแบต ~${fmtNum(stats.estFullRange, 0)} กม.` : "ตอนขับ"}</div>
        </div>
        <div style={styles.usageDiv} />
        <div style={styles.usageItem}>
          <div style={styles.usageVal}>{stats.avgKwhPerPercent != null ? fmtNum(stats.avgKwhPerPercent, 3) : "—"}</div>
          <div style={styles.usageLabel}>kWh / 1%</div>
          <div style={styles.usageSub}>ไฟที่ใช้ชาร์จ</div>
        </div>
        <div style={styles.usageDiv} />
        <div style={styles.usageItem}>
          <div style={styles.usageVal}>{stats.avgKmPerKwh != null ? fmtNum(stats.avgKmPerKwh, 2) : "—"}</div>
          <div style={styles.usageLabel}>กม. / หน่วยไฟ</div>
          <div style={styles.usageSub}>1 kWh วิ่งได้</div>
        </div>
      </div>
    </div>
  );
}
function ChargingLossCard({ stats }) {
  if (stats.wallEff == null || stats.carEff == null) return null;
  const loss = stats.chargingLossPct;
  const lossColor = loss < 10 ? COLORS.teal : loss < 18 ? COLORS.amber : "#E05C5C";
  return (
    <div style={styles.lossCard}>
      <div style={styles.lossHead}>ประสิทธิภาพการชาร์จ (Charging Efficiency)</div>
      <div style={styles.lossRow}>
        <div style={styles.lossItem}>
          <div style={styles.lossVal}>{fmtNum(stats.wallEff, 1)}</div>
          <div style={styles.lossLabel}>kWh/100km</div>
          <div style={styles.lossSub}>มิเตอร์หน้าบ้าน</div>
        </div>
        <div style={styles.lossArrow}>→</div>
        <div style={styles.lossItem}>
          <div style={styles.lossVal}>{fmtNum(stats.carEff, 1)}</div>
          <div style={styles.lossLabel}>kWh/100km</div>
          <div style={styles.lossSub}>รถบอก</div>
        </div>
        <div style={styles.lossArrow}>=</div>
        <div style={{ ...styles.lossItem, flex: "none" }}>
          <div style={{ ...styles.lossVal, color: lossColor }}>{fmtNum(loss, 1)}%</div>
          <div style={styles.lossLabel}>Charging</div>
          <div style={styles.lossSub}>Loss</div>
        </div>
      </div>
      <div style={styles.lossHint}>
        {loss < 10 ? "✓ ระบบชาร์จมีประสิทธิภาพดี" : loss < 18 ? "⚡ ค่าปกติสำหรับ AC charging (10–18%)" : "⚠ สูงกว่าปกติ ลองชาร์จในอุณหภูมิห้อง"}
      </div>
    </div>
  );
}

function MiniCard({ accent, label, value, unit, hint }) {
  return (
    <div style={styles.miniCard}>
      <div style={{ ...styles.miniDot, background: accent, boxShadow: `0 0 7px ${accent}AA` }} />
      <div style={styles.miniLabel}>{label}</div>
      <div style={styles.miniValueRow}><span style={styles.miniValue}>{value}</span><span style={styles.miniUnit}>{unit}</span></div>
      <div style={styles.miniHint}>{hint}</div>
    </div>
  );
}
function ChartCard({ title, sub, children }) {
  return (<div style={styles.chartCard}><div style={styles.chartHead}><div style={styles.chartTitle}>{title}</div><div style={styles.chartSub}>{sub}</div></div>{children}</div>);
}
function NoChart() { return <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.faint, fontSize: 13 }}>ยังไม่มีข้อมูลพอ</div>; }

/* ============================ HISTORY ============================ */
function History({ sorted, distMap, percentMap, rate, isAll, vehicles, onAdd, onEdit, onDelete }) {
  const [confirmId, setConfirmId] = useState(null);
  const [detailSession, setDetailSession] = useState(null);
  const vname = (id) => (vehicles.find((v) => v.id === id) || {}).name || "";
  const groups = {};
  sorted.forEach((s) => { const k = monthKey(s.datetime); (groups[k] = groups[k] || []).push(s); });
  const keys = Object.keys(groups).sort().reverse();
  return (
    <div style={{ paddingBottom: 28 }}>
      <button style={styles.addWide} onClick={onAdd}><PlusIcon /> จดบันทึก</button>
      {sorted.length === 0 ? <EmptyState onAdd={onAdd} compact /> : keys.map((k) => {
        const mk = groups[k].reduce((a, s) => a + deriveCost(s, rate).kwh, 0);
        const mc = groups[k].reduce((a, s) => a + deriveCost(s, rate).cost, 0);
        return (
          <div key={k}>
            <div style={styles.monthHead}><span style={styles.monthName}>{thaiMonthLabel(k)}</span><span style={styles.monthMeta}>{fmtNum(mk, 1)} kWh · {fmtBaht(mc)}</span></div>
            {groups[k].map((s) => (
              <SessionCard key={s.id} s={s} dist={distMap[s.id]} pctUsed={percentMap[s.id]} rate={rate} vname={isAll ? vname(s.vehicleId) : null}
                onDetail={() => setDetailSession({ s, dist: distMap[s.id], pctUsed: percentMap[s.id] })}
                onEdit={() => onEdit(s)} confirm={confirmId === s.id}
                onAskDelete={() => setConfirmId(s.id)} onCancelDelete={() => setConfirmId(null)}
                onConfirmDelete={() => { onDelete(s.id); setConfirmId(null); }} />
            ))}
          </div>
        );
      })}
      {detailSession && (
        <SessionDetailSheet
          s={detailSession.s} dist={detailSession.dist} pctUsed={detailSession.pctUsed} rate={rate}
          onClose={() => setDetailSession(null)}
          onEdit={() => { onEdit(detailSession.s); setDetailSession(null); }}
        />
      )}
    </div>
  );
}
function SessionCard({ s, dist, pctUsed, rate, vname, onDetail, onEdit, confirm, onAskDelete, onCancelDelete, onConfirmDelete }) {
  const d = deriveCost(s, rate);
  const start = num(s.startPercent), end = num(s.endPercent);
  const cpk = dist && dist > 0 ? d.cost / dist : null;
  const isDC = s.chargeType === "DC";
  return (
    <div style={{ ...styles.sessionCard, cursor: "pointer" }} onClick={onDetail}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={styles.badgeRow}>
            <span style={{ ...styles.badge, background: isDC ? "#FDEFDC" : "#E3F1FD", color: isDC ? "#A8690A" : "#1D6FB8" }}>{isDC ? "DC เร็ว" : "AC ปกติ"}</span>
            {vname ? <span style={{ ...styles.locBadge, background: "#E2F6EA", color: COLORS.tealDeep }}>{vname}</span> : null}
            {s.location ? <span style={styles.locBadge}>{s.location}</span> : null}
          </div>
          <div style={styles.sessDate}>{thaiDateTime(s.datetime)}</div>
          <div style={styles.sessKwh}>{fmtNum(d.kwh, 2)} <span style={{ fontSize: 12, color: COLORS.muted, fontWeight: 500 }}>kWh</span></div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={styles.sessCost}>{fmtBaht(d.cost)}</div>
          <div style={styles.sessRate}>@ {fmtNum(d.rate, 2)} บ./หน่วย</div>
          <div style={{ fontSize: 11, color: COLORS.faint, marginTop: 4 }}>กดดูรายละเอียด →</div>
        </div>
      </div>
      {start != null && end != null && (
        <div style={{ marginTop: 12 }}>
          <div style={styles.battTrack}>
            <div style={{ ...styles.battStart, width: `${Math.max(0, Math.min(100, start))}%` }} />
            <div style={{ ...styles.battFill, left: `${Math.max(0, Math.min(100, start))}%`, width: `${Math.max(0, Math.min(100, end - start))}%` }} />
          </div>
          <div style={styles.battLabel}>{start}% → {end}% <span style={{ color: COLORS.green, fontWeight: 600 }}>(+{end - start}%)</span></div>
        </div>
      )}
      {cpk != null && (
        <div style={styles.cpkBanner}>
          <div><div style={styles.cpkLabel}>ต้นทุนค่าไฟ</div><div style={styles.cpkBig}>{fmtNum(cpk, 2)} <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.muted }}>บาท/กม.</span></div></div>
          <div style={{ textAlign: "right" }}><div style={styles.cpkLabel}>วิ่งจากครั้งก่อน</div><div style={styles.cpkSub}>{fmtNum(dist, 0)} กม.</div></div>
        </div>
      )}
      <div style={styles.sessMetaRow}>
        {num(s.odometer) != null && <span style={styles.tag}>⛽ ไมล์ {fmtNum(num(s.odometer), 0)} km</span>}
        {dist > 0 && pctUsed > 0 && <span style={styles.tag}>🔋 {fmtNum(dist / pctUsed, 2)} กม./%</span>}
        {d.carEff != null && <span style={styles.tag}>⚡ {fmtNum(d.carEff, 1)} kWh/100km</span>}
      </div>
      {s.note ? <div style={styles.sessNote}>{s.note}</div> : null}
      <div style={styles.sessActions} onClick={(e) => e.stopPropagation()}>
        {confirm ? (
          <><span style={{ fontSize: 13, color: COLORS.muted, marginRight: "auto" }}>ลบรายการนี้?</span>
            <button style={styles.btnGhost} onClick={onCancelDelete}>ยกเลิก</button>
            <button style={styles.btnDanger} onClick={onConfirmDelete}>ลบ</button></>
        ) : (
          <><button style={styles.btnGhost} onClick={onEdit}>แก้ไข</button><button style={styles.btnGhost} onClick={onAskDelete}>ลบ</button></>
        )}
      </div>
    </div>
  );
}

/* ============================ SESSION DETAIL ============================= */
function SessionDetailSheet({ s, dist, pctUsed, rate, onClose, onEdit }) {
  const d = deriveCost(s, rate);
  const start = num(s.startPercent);
  const end = num(s.endPercent);
  const added = d.added;          // % ที่ชาร์จเพิ่มรอบนี้
  const isDC = s.chargeType === "DC";

  /* ---- คำนวณทุกค่า ---- */
  // ใช้ pctUsed (% แบตที่ใช้ตอนขับ ก่อนชาร์จรอบนี้) คู่กับ dist — ไม่ใช่ added (% ที่ชาร์จเพิ่ม) เพราะคนละความหมาย
  const kmPerPct   = dist > 0 && pctUsed > 0 ? dist / pctUsed : null;
  const fullRange  = kmPerPct != null ? kmPerPct * 100 : null;

  // ฝั่งมิเตอร์
  const meterEff   = dist > 0 && d.kwh > 0 ? (d.kwh / dist) * 100 : null; // kWh/100km
  const kmPerKwh   = dist > 0 && d.kwh > 0 ? dist / d.kwh : null;
  const kwhPerPct  = added > 0 && d.kwh > 0 ? d.kwh / added : null;
  const bahtPerKm  = dist > 0 ? d.cost / dist : null;
  const bahtPer10km = bahtPerKm != null ? bahtPerKm * 10 : null;
  const bahtPer100km = bahtPerKm != null ? bahtPerKm * 100 : null;
  const bahtPerPct = added > 0 ? d.cost / added : null;

  // ฝั่งรถ
  const carEff     = d.carEff;    // kWh/100km ที่รถบอก
  const carKmPerKwh = carEff ? 100 / carEff : null;
  const carEnergy  = dist > 0 && carEff ? (dist * carEff) / 100 : null;

  // Charging Loss
  const lossKwh    = carEnergy != null ? d.kwh - carEnergy : null;
  const lossPct    = lossKwh != null && d.kwh > 0 ? (lossKwh / d.kwh) * 100 : null;
  const chargingEff = lossPct != null ? 100 - lossPct : null;

  // Usable battery estimate
  const usableBatt  = kwhPerPct != null ? kwhPerPct * 100 * (chargingEff ? chargingEff / 100 : 1) : null;
  const meterBatt100 = kwhPerPct != null ? kwhPerPct * 100 : null;

  // สีตาม loss
  const lossColor = lossPct == null ? COLORS.faint : lossPct < 10 ? COLORS.teal : lossPct < 18 ? COLORS.amber : "#E05C5C";

  const Grp = ({ title, children }) => (
    <div style={styles.detGrp}>
      <div style={styles.detGrpTitle}>{title}</div>
      {children}
    </div>
  );
  const Row = ({ label, value, unit, accent, big }) => (
    <div style={styles.detRow}>
      <span style={styles.detLabel}>{label}</span>
      <span style={{ ...styles.detVal, ...(accent ? { color: accent } : {}), ...(big ? { fontSize: 17 } : {}) }}>
        {value ?? "—"}{unit ? <span style={styles.detUnit}> {unit}</span> : null}
      </span>
    </div>
  );

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={{ ...styles.sheet, maxHeight: "96vh" }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.sheetGrab} />

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
          <div>
            <div style={styles.badgeRow}>
              <span style={{ ...styles.badge, background: isDC ? "#FDEFDC" : "#E3F1FD", color: isDC ? "#A8690A" : "#1D6FB8" }}>{isDC ? "DC เร็ว" : "AC ปกติ"}</span>
              {s.location ? <span style={styles.locBadge}>{s.location}</span> : null}
            </div>
            <div style={{ fontFamily: "'IBM Plex Sans Thai', sans-serif", fontWeight: 700, fontSize: 17, marginTop: 4 }}>{thaiDateTime(s.datetime)}</div>
          </div>
          <button style={styles.btnGhost} onClick={onEdit}>แก้ไข</button>
        </div>

        {/* Hero numbers */}
        <div style={styles.detHero}>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={styles.detHeroVal}>{fmtNum(d.kwh, 2)}</div>
            <div style={styles.detHeroLabel}>kWh (มิเตอร์)</div>
          </div>
          <div style={styles.detHeroDivider} />
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ ...styles.detHeroVal, color: COLORS.teal }}>{fmtBaht(d.cost)}</div>
            <div style={styles.detHeroLabel}>ค่าไฟ</div>
          </div>
          {dist > 0 && <>
            <div style={styles.detHeroDivider} />
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={styles.detHeroVal}>{fmtNum(dist, 0)}</div>
              <div style={styles.detHeroLabel}>กม. ที่วิ่ง</div>
            </div>
          </>}
        </div>

        {/* แบตเตอรี่ */}
        {start != null && end != null && (
          <Grp title="🔋 แบตเตอรี่">
            <div style={styles.battTrack}>
              <div style={{ ...styles.battStart, width: `${Math.max(0, Math.min(100, start))}%` }} />
              <div style={{ ...styles.battFill, left: `${Math.max(0, Math.min(100, start))}%`, width: `${Math.max(0, Math.min(100, added || 0))}%` }} />
            </div>
            <div style={{ ...styles.battLabel, marginBottom: 10 }}>{start}% → {end}% <span style={{ color: COLORS.green, fontWeight: 700 }}>(+{added}%)</span></div>
            <Row label="% ที่ชาร์จเพิ่มรอบนี้" value={fmtNum(added, 0)} unit="%" accent={COLORS.green} />
            {pctUsed > 0 && <Row label="% แบตที่ใช้ตอนขับมา" value={fmtNum(pctUsed, 0)} unit="%" accent={COLORS.amber} />}
            {kmPerPct != null && <Row label="แบตลด 1% วิ่งได้" value={fmtNum(kmPerPct, 2)} unit="กม./%" accent={COLORS.tealDeep} big />}
            {fullRange != null && <Row label="ระยะเต็มแบต (ประมาณ)" value={fmtNum(fullRange, 0)} unit="กม." />}
            {kmPerPct == null && <div style={{ fontSize: 11.5, color: COLORS.faint, marginTop: 6, lineHeight: 1.4 }}>ต้องมีทั้งระยะทางและ % ก่อนชาร์จของรอบก่อนหน้า ถึงคำนวณค่านี้ได้</div>}
          </Grp>
        )}

        {/* ต้นทุนค่าไฟ */}
        {d.cost > 0 && (
          <Grp title="💰 ต้นทุนค่าไฟ">
            <Row label="ค่าไฟรอบนี้" value={fmtBaht(d.cost)} accent={COLORS.tealDeep} big />
            <Row label="ราคาต่อหน่วย" value={fmtNum(d.rate, 2)} unit="บาท/kWh" />
            {bahtPerKm != null && <Row label="ต้นทุนต่อกิโลเมตร" value={fmtNum(bahtPerKm, 2)} unit="บาท/กม." accent={COLORS.amber} big />}
            {bahtPer10km != null && <Row label="ต้นทุนต่อ 10 กม." value={fmtNum(bahtPer10km, 2)} unit="บาท" />}
            {bahtPer100km != null && <Row label="ต้นทุนต่อ 100 กม." value={fmtNum(bahtPer100km, 1)} unit="บาท" />}
            {bahtPerPct != null && <Row label="ค่าไฟต่อ 1% แบต" value={fmtNum(bahtPerPct, 2)} unit="บาท/%" />}
          </Grp>
        )}

        {/* ประสิทธิภาพจากมิเตอร์ */}
        {meterEff != null && (
          <Grp title="⚡ ประสิทธิภาพ (มิเตอร์บ้าน)">
            <Row label="อัตรากินไฟ" value={fmtNum(meterEff, 2)} unit="kWh/100กม." big />
            <Row label="ระยะทางต่อหน่วยไฟ" value={fmtNum(kmPerKwh, 2)} unit="กม./kWh" />
            {kwhPerPct != null && <Row label="ไฟต่อ 1% แบต (ชาร์จ)" value={fmtNum(kwhPerPct, 3)} unit="kWh/%" />}
            {meterBatt100 != null && <Row label="ไฟมิเตอร์เทียบ 0→100%" value={fmtNum(meterBatt100, 1)} unit="kWh (รวม loss)" />}
          </Grp>
        )}

        {/* ประสิทธิภาพจากรถ */}
        {carEff != null && (
          <Grp title="🚗 ประสิทธิภาพ (รถบอก)">
            <Row label="อัตรากินไฟ" value={fmtNum(carEff, 2)} unit="kWh/100กม." big />
            {carKmPerKwh != null && <Row label="ระยะทางต่อหน่วยไฟ" value={fmtNum(carKmPerKwh, 2)} unit="กม./kWh" />}
            {carEnergy != null && <Row label="พลังงานที่ใช้จากแบต" value={fmtNum(carEnergy, 2)} unit="kWh" />}
            {usableBatt != null && <Row label="usable battery ประมาณ" value={fmtNum(usableBatt, 1)} unit="kWh" />}
          </Grp>
        )}

        {/* Charging Loss */}
        {lossPct != null && (
          <Grp title="🔌 Charging Loss">
            <Row label="ไฟจากมิเตอร์" value={fmtNum(d.kwh, 2)} unit="kWh" />
            <Row label="พลังงานเข้าแบต" value={fmtNum(carEnergy, 2)} unit="kWh" />
            <Row label="สูญเสียระหว่างชาร์จ" value={fmtNum(lossKwh, 2)} unit="kWh" />
            <Row label="Charging Loss" value={fmtNum(lossPct, 1)} unit="%" accent={lossColor} big />
            <Row label="Charging Efficiency" value={fmtNum(chargingEff, 1)} unit="%" accent={COLORS.teal} />
            <div style={{ ...styles.lossHint, marginTop: 8 }}>
              {lossPct < 10 ? "✓ ระบบชาร์จมีประสิทธิภาพดีมาก" : lossPct < 18 ? "⚡ อยู่ในระดับปกติสำหรับ AC charging (10–18%)" : "⚠ สูงกว่าปกติ ลองชาร์จในอุณหภูมิห้อง"}
            </div>
          </Grp>
        )}

        {/* ข้อมูลดิบ */}
        <Grp title="📋 ข้อมูลที่บันทึก">
          {num(s.odometer) != null && <Row label="เลขไมล์" value={fmtNum(num(s.odometer), 0)} unit="km" />}
          <Row label="ประเภทการชาร์จ" value={isDC ? "DC (ชาร์จเร็ว)" : "AC (ชาร์จปกติ)"} />
          {s.note ? <Row label="หมายเหตุ" value={s.note} /> : null}
        </Grp>

        <div style={styles.sheetActions}>
          <button style={styles.btnPrimary} onClick={onClose}>ปิด</button>
        </div>
      </div>
    </div>
  );
}

/* ============================ FORM ============================ */
function SessionForm({ initial, defaultRate, vehicles, defaultVehicleId, lastOdoFor, onCancel, onSave }) {
  const [f, setF] = useState(
    initial || {
      vehicleId: defaultVehicleId, datetime: nowLocalISO(), chargeType: "AC", location: LOCATIONS[0],
      odometer: "", kwh: "", pricePerUnit: defaultRate, totalCost: "",
      startPercent: "", endPercent: "", efficiency: "", note: "",
    }
  );
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const lastOdo = lastOdoFor(f.vehicleId);
  const vehName = (vehicles.find((v) => v.id === f.vehicleId) || {}).name || "";

  const submit = () => {
    if (num(f.odometer) == null) return setErr("กรอกเลขไมล์ปัจจุบัน (จำเป็นสำหรับคำนวณระยะทางและค่าเฉลี่ย)");
    if (num(f.startPercent) == null || num(f.endPercent) == null) return setErr("กรอก % ก่อน-หลังชาร์จ (จำเป็นสำหรับคำนวณค่าเฉลี่ยต่อ 1%)");
    if (num(f.kwh) == null && num(f.totalCost) == null) return setErr("กรอกจำนวนหน่วย (kWh) หรือยอดรวม (บาท) อย่างน้อย 1 อย่าง");
    if (!f.datetime) return setErr("กรุณาเลือกวันที่และเวลา");
    setErr(""); onSave(f);
  };
  const preview = deriveCost(f, defaultRate);
  const odoDist = num(f.odometer) != null && lastOdo != null && num(f.odometer) >= lastOdo ? num(f.odometer) - lastOdo : null;

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={styles.sheetGrab} />
        <div style={styles.sheetTitle}>{initial ? "แก้ไขบันทึก" : "จดบันทึก"}</div>

        {vehicles.length > 1 && (
          <Field label="รถ">
            <select value={f.vehicleId} onChange={set("vehicleId")} style={styles.input}>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>
        )}

        <div style={styles.requiredNote}>3 ค่านี้จำเป็น เพื่อให้คำนวณระยะทางและค่าเฉลี่ยได้ถูกต้อง</div>

        <Field label="เลขไมล์ปัจจุบัน (km)" required>
          <input type="number" inputMode="decimal" placeholder={lastOdo != null ? `ครั้งก่อน ${fmtNum(lastOdo, 0)} km` : "เช่น 12500"} value={f.odometer} onChange={set("odometer")} style={styles.input} />
          {odoDist != null && <div style={styles.hintGood}>วิ่งจากครั้งก่อน +{fmtNum(odoDist, 0)} km</div>}
        </Field>

        <div style={styles.row2}>
          <Field label="% ก่อนชาร์จ" required><input type="number" inputMode="numeric" placeholder="65" value={f.startPercent} onChange={set("startPercent")} style={styles.input} /></Field>
          <Field label="% หลังชาร์จ" required><input type="number" inputMode="numeric" placeholder="92" value={f.endPercent} onChange={set("endPercent")} style={styles.input} /></Field>
        </div>

        <div style={styles.row2}>
          <Field label="จำนวนหน่วย (kWh)" required><input type="number" inputMode="decimal" placeholder="8.98" value={f.kwh} onChange={set("kwh")} style={styles.input} /></Field>
          <Field label="ราคา/หน่วย (บาท)"><input type="number" inputMode="decimal" placeholder="4.62" value={f.pricePerUnit} onChange={set("pricePerUnit")} style={styles.input} /></Field>
        </div>

        <div style={styles.formDivider}>รายละเอียดเพิ่มเติม (ไม่บังคับ)</div>

        <Field label="ยอดรวม (ใส่แทน kWh ถ้าไม่ทราบหน่วย) — บาท"><input type="number" inputMode="decimal" placeholder="กรอกยอดเงินจากใบเสร็จ" value={f.totalCost} onChange={set("totalCost")} style={styles.input} /></Field>

        <div style={styles.acdcRow}>
          {[["AC", "AC (ชาร์จปกติ)"], ["DC", "DC (ชาร์จเร็ว)"]].map(([k, l]) => (
            <button key={k} onClick={() => setF({ ...f, chargeType: k })}
              style={{ ...styles.acdcBtn, ...(f.chargeType === k ? (k === "DC" ? styles.acdcDC : styles.acdcAC) : {}) }}>{l}</button>
          ))}
        </div>

        <Field label="สถานที่ชาร์จ">
          <div style={styles.chipRow}>
            {LOCATIONS.map((loc) => (
              <button key={loc} onClick={() => setF({ ...f, location: loc })} style={{ ...styles.chip, ...(f.location === loc ? styles.chipOn : {}) }}>{loc}</button>
            ))}
          </div>
          {f.location === "อื่นๆ" && (
            <input type="text" placeholder="ระบุสถานที่" value={f.locationText || ""} onChange={set("locationText")}
              onBlur={(e) => setF({ ...f, location: e.target.value || "อื่นๆ" })} style={{ ...styles.input, marginTop: 8 }} />
          )}
        </Field>

        <Field label="วันที่ & เวลา"><input type="datetime-local" value={f.datetime} onChange={set("datetime")} style={styles.input} /></Field>

        <Field label="kWh/100km ที่รถบอก (ไม่บังคับ)">
          <input type="number" inputMode="decimal" placeholder="เช่น 12.10 (ดูได้ในแอปรถ)" value={f.efficiency} onChange={set("efficiency")} style={styles.input} />
          <div style={{ fontSize: 11.5, color: COLORS.faint, marginTop: 6, lineHeight: 1.4 }}>
            ค่านี้รถวัดจากแบต ไม่รวมการสูญเสียตอนชาร์จ จะต่ำกว่าค่าที่คำนวณจากมิเตอร์เล็กน้อยตามปกติ — ใส่เพื่อดูเปอร์เซ็นต์ความสูญเสียในหน้าภาพรวม
          </div>
        </Field>

        <Field label="หมายเหตุ (ถ้ามี)"><input type="text" placeholder="เช่น ชาร์จกลางคืน" value={f.note} onChange={set("note")} style={styles.input} /></Field>

        {preview.cost > 0 && (
          <div style={styles.previewBox}>
            ค่าไฟครั้งนี้ ≈ <b style={{ color: COLORS.ink }}>{fmtBaht(preview.cost)}</b>
            {preview.added != null ? <> · เติม <b style={{ color: COLORS.green }}>+{preview.added}%</b></> : null}
            {odoDist != null && preview.cost > 0 ? <> · {fmtNum(preview.cost / odoDist, 2)} บ./กม.</> : null}
          </div>
        )}
        {err ? <div style={styles.errBox}>{err}</div> : null}

        <div style={styles.sheetActions}>
          <button style={styles.btnGhostBig} onClick={onCancel}>ยกเลิก</button>
          <button style={styles.btnPrimary} onClick={submit}>{initial ? "บันทึก" : "ยืนยัน"}</button>
        </div>
      </div>
    </div>
  );
}
function Field({ label, required, children }) {
  return (<div style={{ marginBottom: 14 }}><label style={styles.fieldLabel}>{label} {required && <span style={{ color: COLORS.tealDeep }}>*</span>}</label>{children}</div>);
}

/* ============================ VEHICLES ============================ */
function VehicleSheet({ settings, sessions, onSave, onClose, onOpenTrip, onRemoveVehicle }) {
  const noVehicles = settings.vehicles.length === 0;
  const [adding, setAdding] = useState(noVehicles);
  const [name, setName] = useState("");
  const [odo, setOdo] = useState("");
  const [err, setErr] = useState("");
  const [confirmDel, setConfirmDel] = useState(null); // vehicle id ที่กำลังจะลบ
  const [delPinId, setDelPinId] = useState(null);     // vehicle id ที่รอใส่ PIN
  const [delPin, setDelPin] = useState("");
  const [delPinErr, setDelPinErr] = useState("");
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editOdo, setEditOdo] = useState("");
  const [editErr, setEditErr] = useState("");

  const currentPin = settings.lockPin || "";
  const select = (id) => { onSave({ ...settings, activeVehicle: id }); onClose(); };
  const sessionCountFor = (id) => sessions.filter((s) => s.vehicleId === id).length;

  const startEdit = (v) => {
    setEditId(v.id); setEditName(v.name); setEditOdo(String(v.startOdo));
    setEditErr(""); setConfirmDel(null); setAdding(false);
    setDelPinId(null);
  };
  const cancelEdit = () => { setEditId(null); setEditErr(""); };
  const saveEdit = () => {
    if (!editName.trim()) return setEditErr("กรอกชื่อรถ");
    if (num(editOdo) == null) return setEditErr("กรอกเลขไมล์ตั้งต้น");
    const updated = settings.vehicles.map((v) =>
      v.id === editId ? { ...v, name: editName.trim(), startOdo: num(editOdo) } : v
    );
    onSave({ ...settings, vehicles: updated });
    setEditId(null);
  };

  /* ขอลบรถ: ถ้ามี PIN → ขอ PIN ก่อน, ถ้าไม่มี → ลบเลย */
  const askDelete = (id) => {
    setConfirmDel(confirmDel === id ? null : id);
    setDelPinId(null); setDelPin(""); setDelPinErr("");
    setEditId(null);
  };
  const proceedDelete = (id) => {
    if (currentPin) {
      setDelPinId(id); setDelPin(""); setDelPinErr("");
      setConfirmDel(null);
    } else {
      doRemove(id);
    }
  };
  const submitDelPin = (id) => {
    if (delPin !== currentPin) { setDelPinErr("PIN ไม่ถูกต้อง"); setDelPin(""); return; }
    doRemove(id);
  };
  const doRemove = (id) => {
    onRemoveVehicle(id);
    setConfirmDel(null); setDelPinId(null); setDelPin(""); setDelPinErr("");
    if (settings.vehicles.length <= 1) setAdding(true);
  };

  const addVehicle = () => {
    if (!name.trim()) return setErr("กรอกชื่อรถ");
    if (num(odo) == null) return setErr("กรอกเลขไมล์ตั้งต้น (จำเป็นสำหรับคำนวณระยะทาง)");
    const v = { id: uid(), name: name.trim(), startOdo: num(odo), tripA: tripDefault(num(odo)), tripB: tripDefault(num(odo)) };
    onSave({ ...settings, vehicles: [...settings.vehicles, v], activeVehicle: v.id });
    setName(""); setOdo(""); setErr(""); setAdding(false);
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={styles.sheetGrab} />
        <div style={styles.sheetTitle}>รถของฉัน</div>

        {settings.vehicles.map((v) => (
          <div key={v.id}>
            <div style={{ ...styles.vRow, ...(v.id === settings.activeVehicle ? styles.vRowOn : {}) }}>
              <button style={styles.vSelect} onClick={() => editId === v.id ? null : select(v.id)}>
                <span style={styles.carDotSm}><CarIcon /></span>
                <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                  <span style={{ fontWeight: 600 }}>{v.name}</span>
                  <span style={{ fontSize: 11, color: COLORS.faint }}>เริ่มที่ {fmtNum(v.startOdo, 0)} km · {sessionCountFor(v.id)} รายการ</span>
                </span>
                {v.id === settings.activeVehicle && <span style={styles.vActive}>กำลังใช้</span>}
              </button>
              <button style={styles.tripBtn} onClick={() => onOpenTrip(v.id)} title="ทริป"><TripIcon /></button>
              <button style={styles.btnGhost} onClick={() => editId === v.id ? cancelEdit() : startEdit(v)}>
                {editId === v.id ? "ยกเลิก" : "แก้ไข"}
              </button>
              <button style={styles.btnGhost} onClick={() => askDelete(v.id)}>ลบ</button>
            </div>

            {editId === v.id && (
              <div style={styles.editBox}>
                <div style={styles.addBoxTitle}>แก้ไขข้อมูลรถ</div>
                <label style={styles.fieldLabel}>ชื่อรถ</label>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} style={{ ...styles.input, marginBottom: 10 }} />
                <label style={styles.fieldLabel}>เลขไมล์ตั้งต้น (km)</label>
                <input type="number" inputMode="decimal" value={editOdo} onChange={(e) => setEditOdo(e.target.value)} style={styles.input} />
                <div style={{ fontSize: 11.5, color: COLORS.faint, marginTop: 6, lineHeight: 1.4 }}>
                  แก้เลขไมล์ตั้งต้นจะกระทบการคำนวณระยะทางของครั้งชาร์จแรกสุด — ระยะทางรายครั้งอื่นๆ ไม่เปลี่ยน
                </div>
                {editErr ? <div style={styles.errBox}>{editErr}</div> : null}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button style={styles.btnGhostBig} onClick={cancelEdit}>ยกเลิก</button>
                  <button style={styles.btnPrimary} onClick={saveEdit}>บันทึก</button>
                </div>
              </div>
            )}

            {confirmDel === v.id && (
              <div style={styles.clearConfirmBox}>
                <div style={styles.clearConfirmIcon}>⚠️</div>
                <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>ลบ "{v.name}"?</div>
                <div style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
                  {sessionCountFor(v.id) > 0
                    ? <>จะลบประวัติการชาร์จ <b>{sessionCountFor(v.id)} รายการ</b> ของรถคันนี้ออกทั้งหมด กู้คืนไม่ได้</>
                    : "รถคันนี้ยังไม่มีประวัติการชาร์จ"
                  }
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  <button style={styles.btnGhostBig} onClick={() => setConfirmDel(null)}>ยกเลิก</button>
                  <button style={styles.btnDanger} onClick={() => proceedDelete(v.id)}>
                    {currentPin ? "ต่อไป (ใส่ PIN)" : "ลบเลย"}
                  </button>
                </div>
              </div>
            )}

            {delPinId === v.id && (
              <div style={styles.clearConfirmBox}>
                <div style={styles.clearConfirmIcon}>🔒</div>
                <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 4 }}>ใส่ PIN เพื่อยืนยัน</div>
                <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 10 }}>ลบ "{v.name}" พร้อมประวัติ {sessionCountFor(v.id)} รายการ</div>
                <input type="password" inputMode="numeric" maxLength={6} placeholder="กรอก PIN" value={delPin}
                  onChange={(e) => setDelPin(e.target.value.replace(/\D/g, ""))}
                  style={{ ...styles.input, letterSpacing: 8, fontSize: 22, textAlign: "center", marginBottom: 10 }}
                  autoFocus
                />
                {delPinErr && <div style={styles.errBox}>{delPinErr}</div>}
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  <button style={styles.btnGhostBig} onClick={() => { setDelPinId(null); setDelPin(""); setDelPinErr(""); }}>ยกเลิก</button>
                  <button style={styles.btnDanger} onClick={() => submitDelPin(v.id)}>ยืนยันลบ</button>
                </div>
              </div>
            )}
          </div>
        ))}

        <button style={{ ...styles.vRow, width: "100%", cursor: "pointer", ...(settings.activeVehicle === ALL ? styles.vRowOn : {}) }} onClick={() => select(ALL)}>
          <span style={styles.carDotSm}><CarsIcon /></span>
          <span style={{ fontWeight: 600, marginLeft: 2 }}>ดูรวมทุกคัน (All Cars)</span>
          {settings.activeVehicle === ALL && <span style={{ ...styles.vActive, marginLeft: "auto" }}>กำลังใช้</span>}
        </button>

        {!adding ? (
          <button style={styles.addVehicleBtn} onClick={() => { setAdding(true); setEditId(null); }}><PlusIcon /> เพิ่มรถคันใหม่</button>
        ) : (
          <div style={styles.addBox}>
            <div style={styles.addBoxTitle}>เพิ่มรถคันใหม่</div>
            <input type="text" placeholder="ชื่อรถ เช่น BYD Atto 3" value={name} onChange={(e) => setName(e.target.value)} style={{ ...styles.input, marginBottom: 10 }} />
            <input type="number" inputMode="decimal" placeholder="เลขไมล์ตั้งต้น (km) — จำเป็น" value={odo} onChange={(e) => setOdo(e.target.value)} style={styles.input} />
            <div style={styles.addHint}>ใส่เลขไมล์ปัจจุบันบนหน้าปัด เพื่อให้คำนวณระยะทางครั้งแรกได้ถูกต้อง</div>
            {err ? <div style={styles.errBox}>{err}</div> : null}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button style={styles.btnGhostBig} onClick={() => { setAdding(false); setErr(""); }}>ยกเลิก</button>
              <button style={styles.btnPrimary} onClick={addVehicle}>เพิ่มรถ</button>
            </div>
          </div>
        )}

        <div style={styles.sheetActions}><button style={styles.btnPrimary} onClick={onClose}>เสร็จ</button></div>
      </div>
    </div>
  );
}

/* ============================ TRIP ============================ */
function TripSheet({ vehicle, sessions, rate, onReset, onClose }) {
  if (!vehicle) return null;
  const odos = sessions.map((s) => num(s.odometer)).filter((x) => x != null);
  const curOdo = odos.length ? Math.max(...odos) : num(vehicle.startOdo);

  const tripStat = (trip) => {
    const inTrip = sessions.filter((s) => (s.datetime || "") >= (trip.startAt || ""));
    let kwh = 0, cost = 0;
    inTrip.forEach((s) => { const d = deriveCost(s, rate); kwh += d.kwh; cost += d.cost; });
    const dist = curOdo != null && trip.startOdo != null && curOdo >= trip.startOdo ? curOdo - trip.startOdo : null;
    return { n: inTrip.length, kwh, cost, dist, costPerKm: dist > 0 ? cost / dist : null, eff: dist > 0 ? (kwh / dist) * 100 : null };
  };

  const TripCard = ({ label, trip, tkey, color }) => {
    const st = tripStat(trip);
    return (
      <div style={{ ...styles.tripCard, borderColor: color }}>
        <div style={styles.tripHead}>
          <span style={{ ...styles.tripLabel, color }}>{label}</span>
          <span style={styles.tripSince}>ตั้งแต่ {trip.startAt === "1970-01-01T00:00" ? "เริ่มต้น" : thaiDateTime(trip.startAt)}</span>
        </div>
        <div style={styles.tripDistBig}>{st.dist != null ? fmtNum(st.dist, 0) : "—"} <span style={{ fontSize: 13, color: COLORS.muted, fontWeight: 600 }}>km</span></div>
        <div style={styles.tripGrid}>
          <div><div style={styles.tripV}>{fmtNum(st.kwh, 1)}</div><div style={styles.tripK}>kWh</div></div>
          <div><div style={styles.tripV}>{fmtBaht(st.cost)}</div><div style={styles.tripK}>ค่าไฟ</div></div>
          <div><div style={styles.tripV}>{st.costPerKm != null ? fmtNum(st.costPerKm, 2) : "—"}</div><div style={styles.tripK}>บ./กม.</div></div>
          <div><div style={styles.tripV}>{st.eff != null ? fmtNum(st.eff, 1) : "—"}</div><div style={styles.tripK}>kWh/100km</div></div>
        </div>
        <button style={{ ...styles.tripReset, color }} onClick={() => onReset(tkey)}>↻ รีเซ็ตทริปนี้ (เริ่มนับใหม่จากตอนนี้)</button>
      </div>
    );
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={styles.sheetGrab} />
        <div style={styles.sheetTitle}>ทริป · <span style={{ color: COLORS.tealDeep }}>{vehicle.name}</span></div>
        <div style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 14 }}>เลขไมล์ปัจจุบัน {curOdo != null ? fmtNum(curOdo, 0) : "—"} km · ทริปนับสะสมจนกว่าจะกดรีเซ็ต</div>
        <TripCard label="ทริป A" trip={vehicle.tripA} tkey="tripA" color={COLORS.teal} />
        <TripCard label="ทริป B" trip={vehicle.tripB} tkey="tripB" color={COLORS.violet} />
        <div style={styles.sheetActions}><button style={styles.btnPrimary} onClick={onClose}>เสร็จ</button></div>
      </div>
    </div>
  );
}

/* ============================ SETTINGS ============================ */
function SettingsSheet({ settings, sessions, onSave, onClose, onClearAll }) {
  const [r, setR] = useState(settings.rate);

  /* PIN setup */
  const [pinMode, setPinMode] = useState("idle"); // idle | setup | change | remove
  const [pinInput, setPinInput] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinErr, setPinErr] = useState("");
  const currentPin = settings.lockPin || "";

  /* clear flow */
  const [clearStep, setClearStep] = useState("idle"); // idle | confirm | pin
  const [clearPin, setClearPin] = useState("");
  const [clearErr, setClearErr] = useState("");

  const exportCSV = () => {
    const head = ["วันที่เวลา", "รถ", "ชนิด", "สถานที่", "เลขไมล์", "kWh", "ราคา/หน่วย", "ยอดรวม", "%ก่อน", "%หลัง", "kWh100km", "หมายเหตุ"];
    const vn = (id) => (settings.vehicles.find((v) => v.id === id) || {}).name || "";
    const rows = [...sessions].sort((a, b) => (a.datetime < b.datetime ? -1 : 1)).map((s) =>
      [s.datetime, vn(s.vehicleId), s.chargeType, s.location, s.odometer, s.kwh, s.pricePerUnit, s.totalCost, s.startPercent, s.endPercent, s.efficiency, (s.note || "").replace(/,/g, " ")].join(","));
    const csv = "\uFEFF" + [head.join(","), ...rows].join("\n");
    try { const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" })); const a = document.createElement("a"); a.href = url; a.download = "chargelog.csv"; a.click(); URL.revokeObjectURL(url); } catch (e) { alert("ส่งออกไม่ได้ในหน้าตัวอย่าง"); }
  };

  const savePin = () => {
    if (pinInput.length < 4) return setPinErr("PIN ต้องมีอย่างน้อย 4 ตัวเลข");
    if (pinInput !== pinConfirm) return setPinErr("PIN ไม่ตรงกัน กรุณากรอกใหม่");
    onSave({ ...settings, lockPin: pinInput });
    setPinInput(""); setPinConfirm(""); setPinErr(""); setPinMode("idle");
  };
  const removePin = () => {
    if (pinInput !== currentPin) return setPinErr("PIN ไม่ถูกต้อง");
    const next = { ...settings }; delete next.lockPin;
    onSave(next);
    setPinInput(""); setPinErr(""); setPinMode("idle");
  };

  const startClear = () => setClearStep("confirm");
  const confirmClear = () => {
    if (currentPin) { setClearStep("pin"); setClearErr(""); }
    else { onClearAll(); setClearStep("idle"); }
  };
  const submitClearPin = () => {
    if (clearPin !== currentPin) { setClearErr("PIN ไม่ถูกต้อง"); setClearPin(""); return; }
    onClearAll(); setClearStep("idle"); setClearPin("");
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={styles.sheetGrab} />
        <div style={styles.sheetTitle}>ตั้งค่า</div>

        <Field label="ค่าไฟต่อหน่วยเริ่มต้น (บาท/kWh)">
          <input type="number" inputMode="decimal" value={r} onChange={(e) => setR(e.target.value)} style={styles.input} />
          <div style={{ fontSize: 12, color: COLORS.faint, marginTop: 6 }}>ใช้เป็นค่าตั้งต้นตอนจดบันทึกใหม่ (ค่าไฟบ้านไทยส่วนใหญ่อยู่ที่ประมาณ 3.5–4.5 บาท/หน่วย)</div>
        </Field>

        <button style={{ ...styles.btnGhostBig, width: "100%", marginBottom: 14 }} onClick={exportCSV}>
          ส่งออก CSV ({sessions.length} รายการ)
        </button>

        {/* PIN LOCK SECTION */}
        <div style={styles.formDivider}>ป้องกันการลบข้อมูล</div>

        {pinMode === "idle" && (
          <div style={styles.pinStatusRow}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                {currentPin ? "🔒 ตั้ง PIN ไว้แล้ว" : "🔓 ยังไม่มี PIN"}
              </div>
              <div style={{ fontSize: 12, color: COLORS.faint, marginTop: 3 }}>
                {currentPin ? "ต้องใส่ PIN เพื่อยืนยันก่อนลบข้อมูล" : "ตั้ง PIN เพื่อป้องกันการลบข้อมูลโดยไม่ตั้งใจ"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {currentPin
                ? <><button style={styles.btnGhost} onClick={() => { setPinMode("change"); setPinInput(""); setPinConfirm(""); setPinErr(""); }}>เปลี่ยน</button>
                    <button style={styles.btnGhost} onClick={() => { setPinMode("remove"); setPinInput(""); setPinErr(""); }}>ปิด</button></>
                : <button style={styles.btnGhost} onClick={() => { setPinMode("setup"); setPinInput(""); setPinConfirm(""); setPinErr(""); }}>ตั้ง PIN</button>
              }
            </div>
          </div>
        )}

        {(pinMode === "setup" || pinMode === "change") && (
          <div style={styles.pinBox}>
            <div style={styles.addBoxTitle}>{pinMode === "setup" ? "ตั้ง PIN ใหม่" : "เปลี่ยน PIN"}</div>
            <label style={styles.fieldLabel}>PIN (ตัวเลข 4–6 หลัก)</label>
            <input type="password" inputMode="numeric" maxLength={6} placeholder="กรอก PIN" value={pinInput} onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ""))} style={{ ...styles.input, marginBottom: 10, letterSpacing: 6, fontSize: 20 }} />
            <label style={styles.fieldLabel}>ยืนยัน PIN</label>
            <input type="password" inputMode="numeric" maxLength={6} placeholder="กรอก PIN อีกครั้ง" value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ""))} style={{ ...styles.input, letterSpacing: 6, fontSize: 20 }} />
            {pinErr && <div style={styles.errBox}>{pinErr}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button style={styles.btnGhostBig} onClick={() => { setPinMode("idle"); setPinErr(""); }}>ยกเลิก</button>
              <button style={styles.btnPrimary} onClick={savePin}>บันทึก PIN</button>
            </div>
          </div>
        )}

        {pinMode === "remove" && (
          <div style={styles.pinBox}>
            <div style={styles.addBoxTitle}>ปิดใช้งาน PIN</div>
            <div style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 10 }}>ใส่ PIN ปัจจุบันเพื่อยืนยัน</div>
            <input type="password" inputMode="numeric" maxLength={6} placeholder="PIN ปัจจุบัน" value={pinInput} onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ""))} style={{ ...styles.input, letterSpacing: 6, fontSize: 20 }} />
            {pinErr && <div style={styles.errBox}>{pinErr}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button style={styles.btnGhostBig} onClick={() => { setPinMode("idle"); setPinErr(""); }}>ยกเลิก</button>
              <button style={styles.btnDanger} onClick={removePin}>ปิด PIN</button>
            </div>
          </div>
        )}

        {/* CLEAR DATA SECTION */}
        <div style={styles.formDivider}>ล้างข้อมูล</div>

        {clearStep === "idle" && (
          <button style={styles.btnDangerWide} onClick={startClear}>ล้างข้อมูลการชาร์จทั้งหมด</button>
        )}

        {clearStep === "confirm" && (
          <div style={styles.clearConfirmBox}>
            <div style={styles.clearConfirmIcon}>⚠️</div>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>ยืนยันการลบข้อมูล</div>
            <div style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
              จะลบประวัติการชาร์จ <b>{sessions.length} รายการ</b> ออกทั้งหมด ข้อมูลนี้จะหายถาวรและกู้คืนไม่ได้
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={styles.btnGhostBig} onClick={() => setClearStep("idle")}>ยกเลิก</button>
              <button style={styles.btnDanger} onClick={confirmClear}>
                {currentPin ? "ต่อไป (ใส่ PIN)" : "ลบทั้งหมดเลย"}
              </button>
            </div>
          </div>
        )}

        {clearStep === "pin" && (
          <div style={styles.clearConfirmBox}>
            <div style={styles.clearConfirmIcon}>🔒</div>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>ใส่ PIN เพื่อยืนยัน</div>
            <div style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 10 }}>ข้อมูลจะถูกลบทันทีหลังยืนยัน PIN ถูกต้อง</div>
            <input type="password" inputMode="numeric" maxLength={6} placeholder="กรอก PIN" value={clearPin}
              onChange={(e) => setClearPin(e.target.value.replace(/\D/g, ""))}
              style={{ ...styles.input, letterSpacing: 8, fontSize: 22, textAlign: "center", marginBottom: 10 }}
              autoFocus
            />
            {clearErr && <div style={styles.errBox}>{clearErr}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button style={styles.btnGhostBig} onClick={() => { setClearStep("idle"); setClearPin(""); setClearErr(""); }}>ยกเลิก</button>
              <button style={styles.btnDanger} onClick={submitClearPin}>ยืนยันลบข้อมูล</button>
            </div>
          </div>
        )}

        <div style={styles.sheetActions}>
          <button style={styles.btnPrimary} onClick={() => { onSave({ ...settings, lockPin: currentPin, rate: Number(r) || 0 }); onClose(); }}>บันทึกการตั้งค่า</button>
        </div>
      </div>
    </div>
  );
}

/* ============================ EMPTY ============================ */
function EmptyState({ onAdd, compact }) {
  return (
    <div style={{ ...styles.empty, paddingTop: compact ? 24 : 48 }}>
      <div style={styles.emptyBolt}><BoltIcon big /></div>
      <div style={styles.emptyTitle}>ยังไม่มีบันทึกการชาร์จ</div>
      <div style={styles.emptyText}>กด "จดบันทึก" แล้วแอปจะคำนวณค่าไฟ ระยะทาง ประสิทธิภาพ และต้นทุนต่อกิโลเมตรให้อัตโนมัติ</div>
      <button style={styles.addWide} onClick={onAdd}><PlusIcon /> จดบันทึกครั้งแรก</button>
    </div>
  );
}

/* ============================ TOOLTIPS ============================ */
const Tip = (fmt) => ({ active, payload, label }) => (!active || !payload || !payload.length) ? null :
  (<div style={styles.tip}><div style={styles.tipLabel}>{label}</div><div style={styles.tipVal}>{fmt(payload[0].value)}</div></div>);
const TipKwh = Tip((v) => `${fmtNum(v, 2)} kWh`);
const TipEff = Tip((v) => `${fmtNum(v, 1)} kWh/100km`);
const TipBaht = Tip((v) => fmtBaht(v));
const TipCpk = Tip((v) => `${fmtNum(v, 2)} บ./กม.`);
const TipWallEff = Tip((v) => `${fmtNum(v, 1)} kWh/100km`);
const TipKwhPct = Tip((v) => `${fmtNum(v, 3)} kWh/1%`);
const TipKmKwh = Tip((v) => `${fmtNum(v, 2)} กม./kWh`);
function TipEffCompare({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const wall = payload.find((p) => p.dataKey === "มิเตอร์");
  const car = payload.find((p) => p.dataKey === "รถบอก");
  const loss = wall && car ? ((wall.value - car.value) / wall.value * 100) : null;
  return (
    <div style={{ background: "#11201A", borderRadius: 10, padding: "8px 12px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 4 }}>{label}</div>
      {wall && <div style={{ fontSize: 13, color: "#7BE3A6", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>มิเตอร์: {fmtNum(wall.value, 1)}</div>}
      {car && <div style={{ fontSize: 13, color: "#3DA9FC", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>รถบอก: {fmtNum(car.value, 1)}</div>}
      {loss != null && <div style={{ fontSize: 11, color: "#F2A93B", marginTop: 4, fontWeight: 600 }}>Charging Loss ≈ {fmtNum(loss, 1)}%</div>}
    </div>
  );
}

/* ============================ ICONS ============================ */
function BoltIcon({ big }) { const s = big ? 30 : 18; return <svg width={s} height={s} viewBox="0 0 24 24" fill="none"><path d="M13 2L4.5 13.5H11L10 22L19.5 10H13L13 2Z" fill="currentColor" /></svg>; }
function GearIcon() { return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" strokeLinecap="round" /></svg>); }
function PlusIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>; }
function CarIcon() { return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11l1.5-4.5A2 2 0 018.4 5h7.2a2 2 0 011.9 1.5L19 11" /><path d="M3 11h18v5H3z" /><circle cx="7.5" cy="16.5" r="1.5" /><circle cx="16.5" cy="16.5" r="1.5" /></svg>); }
function CarsIcon() { return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 13l1-3a2 2 0 011.9-1.4h6.2A2 2 0 0113 10l1 3" /><path d="M1 13h14v4H1z" /><circle cx="4.5" cy="17.5" r="1.3" /><circle cx="11.5" cy="17.5" r="1.3" /><path d="M16 9h4.5a2 2 0 011.9 1.4l1 3v3.6H18" /></svg>); }
function ChevronIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>; }
function TripIcon() { return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={COLORS.teal} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17s2-9 8-9 8 9 8 9" /><path d="M4 17a2 2 0 104 0 2 2 0 10-4 0M16 17a2 2 0 104 0 2 2 0 10-4 0" /></svg>); }

/* ============================ FONTS ============================ */
function Fonts() {
  return (<style>{`
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
    * { box-sizing: border-box; }
    body, input, select { font-family: 'IBM Plex Sans Thai', sans-serif; }
    input:focus, select:focus { outline: 2px solid ${COLORS.teal}; outline-offset: -1px; }
    ::-webkit-scrollbar { width: 0; }
    @keyframes pulseGlow { 0%, 100% { opacity: 0.85; } 50% { opacity: 1; } }
  `}</style>);
}

/* ============================ STYLES ============================ */
const card = { background: COLORS.surface, borderRadius: 18, border: `1px solid ${COLORS.line}` };
const styles = {
  page: { minHeight: "100vh", background: COLORS.bg, fontFamily: "'IBM Plex Sans Thai', sans-serif", color: COLORS.ink },
  shell: { maxWidth: 480, margin: "0 auto", padding: "0 16px" },

  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 2px 14px" },
  vehiclePick: { display: "flex", alignItems: "center", gap: 8, border: `1px solid ${COLORS.line}`, background: COLORS.surface, borderRadius: 999, padding: "7px 14px 7px 8px", cursor: "pointer", color: COLORS.ink, maxWidth: "72%" },
  carDot: { width: 30, height: 30, borderRadius: 999, background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.green})`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  carDotSm: { width: 26, height: 26, borderRadius: 999, background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.green})`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  vehicleName: { fontFamily: "'IBM Plex Sans Thai', sans-serif", fontWeight: 600, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  gear: { width: 40, height: 40, borderRadius: 12, border: `1px solid ${COLORS.line}`, background: COLORS.surface, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },

  segment: { display: "flex", background: "#E2E7DF", borderRadius: 12, padding: 4, marginBottom: 16 },
  segBtn: { flex: 1, border: "none", background: "transparent", padding: "9px 0", borderRadius: 9, fontSize: 14, fontWeight: 600, color: COLORS.muted, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },
  segActive: { background: COLORS.surface, color: COLORS.ink, boxShadow: "0 2px 6px rgba(16,36,29,0.08)" },

  /* period */
  periodWrap: { ...card, padding: "14px 16px", marginBottom: 14 },
  periodTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  periodTitle: { fontFamily: "'IBM Plex Sans Thai', sans-serif", fontWeight: 700, fontSize: 15, color: COLORS.tealDeep },
  selRow: { display: "flex", gap: 6 },
  sel: { border: `1px solid ${COLORS.line}`, borderRadius: 9, padding: "7px 8px", fontSize: 13.5, fontWeight: 600, color: COLORS.ink, background: "#FBFCFB", cursor: "pointer" },
  selDis: { opacity: 0.4, cursor: "not-allowed" },
  modeRow: { display: "flex", gap: 8, marginTop: 12 },
  modeBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, border: `1px solid ${COLORS.teal}`, background: COLORS.surface, color: COLORS.tealDeep, borderRadius: 12, padding: "7px 0", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace" },
  modeOn: { background: COLORS.teal, color: COLORS.tealDeep },
  modeSub: { fontSize: 9.5, fontWeight: 600, opacity: 0.85, fontFamily: "'IBM Plex Sans Thai', sans-serif" },
  periodHint: { fontSize: 11.5, color: COLORS.faint, marginTop: 10, lineHeight: 1.4 },

  hero: { position: "relative", overflow: "hidden", borderRadius: 22, padding: "22px 22px 20px", background: `linear-gradient(155deg, ${COLORS.tealDeep} 0%, ${COLORS.clusterAlt} 55%, #1C4A30 100%)`, color: "#fff", marginBottom: 14, boxShadow: "0 16px 34px rgba(11,24,18,0.35)" },
  heroScan: { position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(0deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 1px, transparent 1px, transparent 3px)", pointerEvents: "none" },
  heroGlow: { position: "absolute", top: -60, right: -40, width: 200, height: 200, borderRadius: "50%", background: `radial-gradient(circle, ${COLORS.teal}55, transparent 70%)`, filter: "blur(8px)" },
  heroLabel: { fontSize: 12.5, color: "rgba(255,255,255,0.7)", fontWeight: 500 },
  heroValue: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 44, fontWeight: 700, lineHeight: 1.05, marginTop: 4, letterSpacing: -1 },
  odoChip: { display: "inline-block", marginTop: 10, fontSize: 12.5, fontWeight: 600, color: "rgba(255,255,255,0.92)", background: "rgba(255,255,255,0.14)", borderRadius: 999, padding: "5px 12px" },
  heroFlow: { height: 5, borderRadius: 999, background: "rgba(255,255,255,0.12)", margin: "16px 0", overflow: "hidden" },
  heroFlowFill: { height: "100%", width: "100%", background: `linear-gradient(90deg, ${COLORS.teal}, ${COLORS.green})`, borderRadius: 999, boxShadow: `0 0 10px ${COLORS.teal}99`, animation: "pulseGlow 2.6s ease-in-out infinite" },
  heroRow: { display: "flex", gap: 10 },
  heroStatVal: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 17, fontWeight: 600 },
  heroStatLabel: { fontSize: 11, color: "rgba(255,255,255,0.6)", marginTop: 2 },

  splitCard: { ...card, padding: "14px 16px", marginBottom: 14 },
  splitHead: { fontSize: 13, fontWeight: 700, marginBottom: 10 },
  splitBar: { display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: "#E7EBE5" },
  splitLegend: { display: "flex", flexDirection: "column", gap: 5, marginTop: 10, fontSize: 12, color: COLORS.muted, fontWeight: 500 },
  legDot: { display: "inline-block", width: 9, height: 9, borderRadius: 999, marginRight: 7 },

  usageCard: { ...card, padding: "16px 14px 14px", marginBottom: 14, background: "linear-gradient(135deg, #EAF6EF, #FFFFFF)", border: "1px solid #CFE6D7" },

  lossCard: { ...card, padding: "14px 16px 12px", marginBottom: 14, background: "linear-gradient(135deg, #EBF3FF, #FFFFFF)", border: "1px solid #CCDFF5" },
  lossHead: { fontFamily: "'IBM Plex Sans Thai', sans-serif", fontWeight: 700, fontSize: 13, color: COLORS.ink, marginBottom: 12 },
  lossRow: { display: "flex", alignItems: "center", gap: 6 },
  lossItem: { flex: 1, textAlign: "center" },
  lossVal: { fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: COLORS.ink, letterSpacing: -0.5 },
  lossLabel: { fontSize: 10.5, fontWeight: 700, color: COLORS.blue, marginTop: 2 },
  lossSub: { fontSize: 10, color: COLORS.faint, marginTop: 1 },
  lossArrow: { color: COLORS.faint, fontWeight: 700, fontSize: 16, flexShrink: 0 },
  lossHint: { fontSize: 11.5, color: COLORS.muted, marginTop: 10, fontWeight: 500 },

  /* session detail sheet */
  detHero: { display: "flex", alignItems: "center", background: `linear-gradient(135deg, ${COLORS.tealDeep}, #1A3B2A)`, borderRadius: 16, padding: "14px 6px", marginBottom: 16 },
  detHeroVal: { fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: -0.5 },
  detHeroLabel: { fontSize: 10.5, color: "rgba(255,255,255,0.55)", marginTop: 3, fontWeight: 500 },
  detHeroDivider: { width: 1, height: 36, background: "rgba(255,255,255,0.12)", flexShrink: 0 },
  detGrp: { marginBottom: 16, borderRadius: 14, border: `1px solid ${COLORS.line}`, overflow: "hidden" },
  detGrpTitle: { fontSize: 12, fontWeight: 700, color: COLORS.muted, background: "#F4F7F4", padding: "8px 14px", letterSpacing: 0.2 },
  detRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderTop: `1px solid ${COLORS.line}` },
  detLabel: { fontSize: 13, color: COLORS.muted, fontWeight: 500, flex: 1 },
  detVal: { fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 700, color: COLORS.ink, textAlign: "right" },
  detUnit: { fontSize: 11, color: COLORS.faint, fontWeight: 500, fontFamily: "'IBM Plex Sans Thai', sans-serif" },
  usageHead: { fontFamily: "'IBM Plex Sans Thai', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.tealDeepDeep, marginBottom: 10, paddingLeft: 2 },
  usageGrid: { display: "flex", alignItems: "center" },
  usageItem: { flex: 1, textAlign: "center", padding: "4px 2px" },
  usageDiv: { width: 1, height: 38, background: COLORS.line },
  usageVal: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 21, fontWeight: 700, color: COLORS.ink, letterSpacing: -0.5 },
  usageLabel: { fontSize: 11, fontWeight: 700, color: COLORS.tealDeep, marginTop: 3 },
  usageSub: { fontSize: 9.5, color: COLORS.faint, marginTop: 1 },
  noDataBanner: { textAlign: "center", fontSize: 12.5, color: COLORS.muted, background: "#FFF6E6", border: "1px solid #F5DCAD", borderRadius: 12, padding: "12px 14px", marginBottom: 14, fontWeight: 500 },

  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 },
  miniCard: { ...card, padding: "14px 14px 13px", position: "relative" },
  miniDot: { width: 8, height: 8, borderRadius: 999, position: "absolute", top: 15, right: 14 },
  miniLabel: { fontSize: 11.5, color: COLORS.muted, fontWeight: 500, marginBottom: 8, paddingRight: 14, lineHeight: 1.3 },
  miniValueRow: { display: "flex", alignItems: "baseline", gap: 5 },
  miniValue: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 25, fontWeight: 700, letterSpacing: -0.5, color: COLORS.ink },
  miniUnit: { fontSize: 11, color: COLORS.faint, fontWeight: 500 },
  miniHint: { fontSize: 10.5, color: COLORS.faint, marginTop: 5 },

  chartCard: { ...card, padding: "16px 14px 10px", marginBottom: 14 },
  chartHead: { marginBottom: 6, paddingLeft: 4 },
  chartTitle: { fontSize: 14.5, fontWeight: 700, color: COLORS.ink },
  chartSub: { fontSize: 11.5, color: COLORS.faint, marginTop: 2 },

  addWide: { width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px", borderRadius: 14, border: "none", background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.green})`, color: COLORS.tealDeep, fontSize: 15, fontWeight: 700, cursor: "pointer", marginTop: 6, fontFamily: "'IBM Plex Sans Thai', sans-serif", boxShadow: "0 8px 20px rgba(39,193,111,0.35)" },

  monthHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "20px 4px 10px" },
  monthName: { fontFamily: "'IBM Plex Sans Thai', sans-serif", fontSize: 15, fontWeight: 600 },
  monthMeta: { fontSize: 12.5, color: COLORS.muted, fontWeight: 500 },

  sessionCard: { ...card, padding: 16, marginBottom: 10 },
  badgeRow: { display: "flex", gap: 6, marginBottom: 7, flexWrap: "wrap" },
  badge: { fontSize: 11, fontWeight: 700, borderRadius: 7, padding: "3px 9px" },
  locBadge: { fontSize: 11, fontWeight: 600, borderRadius: 7, padding: "3px 9px", background: "#E7EBE5", color: COLORS.muted },
  sessDate: { fontSize: 12.5, color: COLORS.muted, fontWeight: 500 },
  sessKwh: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 24, fontWeight: 700, color: COLORS.ink, marginTop: 2, letterSpacing: -0.5 },
  sessCost: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 19, fontWeight: 600, color: COLORS.tealDeep },
  sessRate: { fontSize: 10.5, color: COLORS.faint, marginTop: 2 },

  battTrack: { position: "relative", height: 9, borderRadius: 999, background: "#E7EBE5", overflow: "hidden" },
  battStart: { position: "absolute", left: 0, top: 0, height: "100%", background: "#D7DDD3" },
  battFill: { position: "absolute", top: 0, height: "100%", background: `linear-gradient(90deg, ${COLORS.green}, ${COLORS.tealDeep})` },
  battLabel: { fontSize: 11.5, color: COLORS.muted, marginTop: 6 },

  cpkBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, padding: "10px 14px", borderRadius: 12, background: "linear-gradient(135deg, #FFF6E6, #FFEDD2)", border: "1px solid #F5DCAD" },
  cpkLabel: { fontSize: 10.5, color: COLORS.muted, fontWeight: 500 },
  cpkBig: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 21, fontWeight: 700, color: "#A8690A", marginTop: 1, letterSpacing: -0.3 },
  cpkSub: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 15, fontWeight: 600, color: COLORS.ink, marginTop: 1 },

  sessMetaRow: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 },
  tag: { fontSize: 11.5, color: COLORS.muted, background: "#E7EBE5", borderRadius: 8, padding: "4px 9px", fontWeight: 500 },
  sessNote: { fontSize: 12.5, color: COLORS.muted, marginTop: 10, fontStyle: "italic" },
  sessActions: { display: "flex", gap: 8, marginTop: 12, alignItems: "center", justifyContent: "flex-end" },

  btnGhost: { border: `1px solid ${COLORS.line}`, background: COLORS.surface, color: COLORS.muted, borderRadius: 9, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },
  btnGhostBig: { flex: 1, border: `1px solid ${COLORS.line}`, background: COLORS.surface, color: COLORS.ink, borderRadius: 12, padding: "13px", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },
  btnDanger: { border: "none", background: "#FCE3E3", color: "#CC3A3A", borderRadius: 9, padding: "6px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },
  btnDangerWide: { width: "100%", border: "1px solid #F1CCCC", background: "#FDF2F2", color: "#CC3A3A", borderRadius: 12, padding: "13px", fontSize: 14.5, fontWeight: 600, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },

  pinStatusRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", borderRadius: 12, border: `1px solid ${COLORS.line}`, background: "#FAFBFA", marginBottom: 14 },
  pinBox: { border: `1.5px solid ${COLORS.line}`, borderRadius: 14, padding: 14, marginBottom: 14, background: "#FAFBFA" },
  clearConfirmBox: { border: "1.5px solid #F1CCCC", borderRadius: 14, padding: 16, marginBottom: 14, background: "#FDF5F5", textAlign: "center" },
  clearConfirmIcon: { fontSize: 28, marginBottom: 8 },
  btnPrimary: { flex: 1, border: "none", background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.green})`, color: COLORS.tealDeep, borderRadius: 12, padding: "13px", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },
  btnPrimarySm: { border: "none", background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.green})`, color: COLORS.tealDeep, borderRadius: 9, padding: "6px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },

  overlay: { position: "fixed", inset: 0, background: "rgba(16,36,29,0.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 },
  sheet: { background: COLORS.surface, width: "100%", maxWidth: 480, borderRadius: "24px 24px 0 0", padding: "10px 20px 24px", maxHeight: "92vh", overflowY: "auto", boxShadow: "0 -10px 40px rgba(0,0,0,0.2)" },
  sheetGrab: { width: 40, height: 4, borderRadius: 999, background: "#D7DDD3", margin: "4px auto 14px" },
  sheetTitle: { fontFamily: "'IBM Plex Sans Thai', sans-serif", fontSize: 19, fontWeight: 700, marginBottom: 18 },
  sheetActions: { display: "flex", gap: 10, marginTop: 18 },

  acdcRow: { display: "flex", gap: 10, marginBottom: 16 },
  acdcBtn: { flex: 1, border: `1px solid ${COLORS.line}`, background: COLORS.surface, color: COLORS.muted, borderRadius: 12, padding: "13px 0", fontSize: 14.5, fontWeight: 700, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },
  acdcAC: { background: "#E3F1FD", color: "#1D6FB8", borderColor: "#BBD7F4" },
  acdcDC: { background: "#FDEFDC", color: "#A8690A", borderColor: "#F4DCB0" },

  chipRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  chip: { border: `1px solid ${COLORS.line}`, background: COLORS.surface, color: COLORS.muted, borderRadius: 999, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },
  chipOn: { background: COLORS.ink, color: "#fff", borderColor: COLORS.ink },

  fieldLabel: { display: "block", fontSize: 12.5, color: COLORS.muted, fontWeight: 600, marginBottom: 6 },
  requiredNote: { fontSize: 11.5, color: COLORS.tealDeep, fontWeight: 600, marginBottom: 12, background: "#E5F5EC", borderRadius: 9, padding: "8px 12px" },
  formDivider: { fontSize: 11, fontWeight: 700, color: COLORS.faint, letterSpacing: 0.3, margin: "16px 0 12px", paddingTop: 14, borderTop: `1px dashed ${COLORS.line}` },
  input: { width: "100%", border: `1px solid ${COLORS.line}`, borderRadius: 11, padding: "12px 13px", fontSize: 15, color: COLORS.ink, background: "#FBFCFB" },
  row2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  hintGood: { fontSize: 12, color: COLORS.green, fontWeight: 600, marginTop: 6 },

  previewBox: { background: "#E6F5EC", border: "1px solid #C8E6D5", borderRadius: 12, padding: "11px 14px", fontSize: 13, color: COLORS.muted, marginTop: 4 },
  errBox: { background: "#FDF2F2", border: "1px solid #F1CCCC", borderRadius: 12, padding: "11px 14px", fontSize: 13, color: "#CC3A3A", marginTop: 10, fontWeight: 500 },

  vRow: { display: "flex", alignItems: "center", gap: 8, padding: 8, borderRadius: 12, border: `1px solid ${COLORS.line}`, marginBottom: 8, background: COLORS.surface },
  vRowOn: { borderColor: COLORS.teal, background: "#E5F5EC" },
  vSelect: { flex: 1, display: "flex", alignItems: "center", gap: 10, border: "none", background: "transparent", cursor: "pointer", fontSize: 15, color: COLORS.ink, fontFamily: "'IBM Plex Sans Thai', sans-serif", padding: "4px 2px", textAlign: "left" },
  vActive: { marginLeft: "auto", fontSize: 11, fontWeight: 700, color: COLORS.tealDeep, background: "#D2EDE0", borderRadius: 999, padding: "3px 10px", flexShrink: 0 },
  delConfirm: { display: "flex", gap: 8, alignItems: "center", background: "#FDF2F2", border: "1px solid #F1CCCC", borderRadius: 12, padding: "10px 12px", fontSize: 12.5, color: "#CC3A3A", fontWeight: 500, margin: "-2px 0 10px" },
  tripBtn: { width: 38, height: 38, borderRadius: 10, border: `1px solid ${COLORS.line}`, background: COLORS.surface, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  addVehicleBtn: { width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px", borderRadius: 12, border: `1.5px dashed ${COLORS.teal}`, background: "#EAF6EF", color: COLORS.tealDeep, fontSize: 14.5, fontWeight: 700, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif", marginTop: 4 },
  addBox: { border: `1px solid ${COLORS.line}`, borderRadius: 14, padding: 14, marginTop: 4, background: "#FBFCFB" },
  editBox: { border: `1.5px solid ${COLORS.teal}`, borderRadius: 14, padding: 14, marginTop: 0, marginBottom: 8, background: "#EAF6EF" },
  addBoxTitle: { fontWeight: 700, fontSize: 14.5, marginBottom: 10 },
  addHint: { fontSize: 11.5, color: COLORS.faint, marginTop: 6, lineHeight: 1.4 },

  /* trip */
  tripCard: { border: `1.5px solid ${COLORS.teal}`, borderRadius: 16, padding: 16, marginBottom: 12 },
  tripHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 },
  tripLabel: { fontFamily: "'IBM Plex Sans Thai', sans-serif", fontWeight: 700, fontSize: 16 },
  tripSince: { fontSize: 11, color: COLORS.faint },
  tripDistBig: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 34, fontWeight: 700, letterSpacing: -1, color: COLORS.ink },
  tripGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginTop: 12, marginBottom: 12 },
  tripV: { fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace", fontSize: 15, fontWeight: 700, color: COLORS.ink },
  tripK: { fontSize: 10, color: COLORS.faint, marginTop: 1 },
  tripReset: { width: "100%", border: `1px solid ${COLORS.line}`, background: COLORS.surface, borderRadius: 10, padding: "9px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'IBM Plex Sans Thai', sans-serif" },

  empty: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "48px 20px" },
  emptyBolt: { width: 72, height: 72, borderRadius: 22, background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.green})`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 18, boxShadow: "0 12px 26px rgba(14,124,102,0.3)" },
  emptyTitle: { fontFamily: "'IBM Plex Sans Thai', sans-serif", fontSize: 19, fontWeight: 700, marginBottom: 8 },
  emptyText: { fontSize: 13.5, color: COLORS.muted, lineHeight: 1.6, maxWidth: 300, marginBottom: 22 },

  tip: { background: COLORS.ink, borderRadius: 10, padding: "8px 11px" },
  tipLabel: { fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 2 },
  tipVal: { fontSize: 14, color: "#fff", fontWeight: 700, fontFamily: "'JetBrains Mono', 'IBM Plex Sans Thai', monospace" },
};
