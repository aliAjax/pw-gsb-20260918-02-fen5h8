import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";

/* ------------------------------------------------------------------ */
/* 基础常量与类型                                                       */
/* ------------------------------------------------------------------ */

const SHIFTS = ["00-04班", "04-08班", "08-12班", "12-16班", "16-20班", "20-24班"] as const;
const EQUIPMENTS = ["主机", "发电机", "泵组", "舱底水"] as const;
const FILTERS = ["全部", ...EQUIPMENTS];

// 无异常记录允许的处理状态；异常记录保存时强制为「待处理」
const NORMAL_STATUSES = ["正常", "已处理", "转交"] as const;

const RECORDS_KEY = "hxyfront-62001:records:v1";
const SHIFT_KEY = "hxyfront-62001:active-shift:v1";
const HANDOVER_KEY = "hxyfront-62001:handovers:v1";

// 看板指标从「参数读数」文本中提取最新一条匹配值
const METRICS = [
  { name: "主机转速", unit: "rpm", test: /转速\D{0,6}(\d+(?:\.\d+)?)/ },
  { name: "滑油压力", unit: "MPa", test: /(?:滑油压力|油压)\D{0,6}(\d+(?:\.\d+)?)/ },
  { name: "冷却水温", unit: "°C", test: /(?:冷却水温|水温)\D{0,6}(\d+(?:\.\d+)?)/ },
  { name: "燃油消耗", unit: "L/h", test: /(?:燃油消耗|油耗|燃油)\D{0,6}(\d+(?:\.\d+)?)/ },
];

type Status = "正常" | "待处理" | "已处理" | "转交";
const STATUS_CLASS: Record<Status, string> = {
  正常: "normal",
  待处理: "pending",
  已处理: "resolved",
  转交: "transfer",
};

interface DutyRecord {
  id: string;
  shift: string; // 值班班次
  equipment: string; // 设备名称
  reading: string; // 参数读数
  anomaly: string; // 异常描述（空 = 正常巡检）
  status: Status; // 处理状态
  handoverNote: string; // 交接备注
  createdAt: number;
  updatedAt: number;
}

interface Handover {
  id: string;
  fromShift: string;
  toShift: string;
  at: number;
  recordCount: number;
  anomalyCount: number;
}

interface FormState {
  shift: string;
  equipment: string;
  reading: string;
  anomaly: string;
  status: Status | "";
  note: string;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const pad = (n: number) => String(n).padStart(2, "0");

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shiftFromHour(hour: number) {
  return SHIFTS[Math.floor(hour / 4) % SHIFTS.length];
}

function nextShift(shift: string) {
  const idx = SHIFTS.indexOf(shift as (typeof SHIFTS)[number]);
  return SHIFTS[(idx + 1) % SHIFTS.length];
}

/* ------------------------------------------------------------------ */
/* 本地持久化                                                           */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is DutyRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.shift === "string" &&
    typeof r.equipment === "string" &&
    typeof r.reading === "string" &&
    typeof r.anomaly === "string" &&
    typeof r.status === "string" &&
    typeof r.handoverNote === "string" &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number"
  );
}

function isHandover(v: unknown): v is Handover {
  if (!v || typeof v !== "object") return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === "string" &&
    typeof h.fromShift === "string" &&
    typeof h.toShift === "string" &&
    typeof h.at === "number" &&
    typeof h.recordCount === "number" &&
    typeof h.anomalyCount === "number"
  );
}

function createSeedRecords(): DutyRecord[] {
  const now = Date.now();
  return [
    {
      id: uid(),
      shift: "08-12班",
      equipment: "主机",
      reading: "转速82rpm，滑油压力0.42MPa",
      anomaly: "",
      status: "正常",
      handoverNote: "主机运转平稳，各项参数正常，无渗漏。",
      createdAt: now - 1000 * 60 * 60 * 7,
      updatedAt: now - 1000 * 60 * 60 * 7,
    },
    {
      id: uid(),
      shift: "12-16班",
      equipment: "发电机",
      reading: "发电机#2 冷却水温82℃",
      anomaly: "发电机#2 冷却水温偏高，较定值高约4℃",
      status: "待处理",
      handoverNote: "已安排复查，请下班持续跟踪水温，必要时降低负荷并转交轮机长。",
      createdAt: now - 1000 * 60 * 60 * 3,
      updatedAt: now - 1000 * 60 * 60 * 3,
    },
    {
      id: uid(),
      shift: "16-20班",
      equipment: "舱底水",
      reading: "舱底水井液位接近警戒线",
      anomaly: "舱底水井液位偏高",
      status: "转交",
      handoverNote: "已转交当班机匠复查，必要时启动舱底泵排水。",
      createdAt: now - 1000 * 60 * 40,
      updatedAt: now - 1000 * 60 * 20,
    },
  ];
}

function loadRecords(): DutyRecord[] {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    if (raw) {
      const data: unknown = JSON.parse(raw);
      if (Array.isArray(data) && data.every(isRecord)) return data;
    }
  } catch {
    /* 本地数据损坏时回退到示例数据 */
  }
  return createSeedRecords();
}

function loadActiveShift(): string {
  try {
    const s = localStorage.getItem(SHIFT_KEY);
    if (s && (SHIFTS as readonly string[]).includes(s)) return s;
  } catch {
    /* ignore */
  }
  return shiftFromHour(new Date().getHours());
}

function loadHandovers(): Handover[] {
  try {
    const raw = localStorage.getItem(HANDOVER_KEY);
    if (raw) {
      const data: unknown = JSON.parse(raw);
      if (Array.isArray(data) && data.every(isHandover)) return data;
    }
  } catch {
    /* ignore */
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* 记录卡片（时间线与历史列表共用）                                      */
/* ------------------------------------------------------------------ */

interface RecordCardProps {
  record: DutyRecord;
  timeline?: boolean;
  onStatus: (id: string, status: Status) => void;
  onSaveNote: (id: string, note: string) => boolean;
}

function RecordCard({ record, timeline = false, onStatus, onSaveNote }: RecordCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.handoverNote);
  const [noteError, setNoteError] = useState("");
  const pending = record.status === "待处理";

  useEffect(() => {
    if (!editing) setDraft(record.handoverNote);
  }, [editing, record.handoverNote]);

  const commitNote = () => {
    if (!draft.trim()) {
      setNoteError("交接备注不能为空，无法保存");
      return;
    }
    if (onSaveNote(record.id, draft.trim())) {
      setNoteError("");
      setEditing(false);
    }
  };

  return (
    <article
      className={[
        timeline ? "timeline-item" : "record-card",
        pending ? "is-pending" : "",
        `status-${STATUS_CLASS[record.status]}`,
      ].join(" ")}
    >
      <div className="record-head">
        <span className="shift-tag">{record.shift}</span>
        <span className="equip-tag">{record.equipment}</span>
        {pending && <span className="pin-tag">📌 待处理 · 置顶</span>}
        <span className={`status-badge badge-${STATUS_CLASS[record.status]}`}>{record.status}</span>
        <time className="record-time">{fmtTime(record.updatedAt)}</time>
      </div>

      {record.reading && <p className="record-line reading">参数读数：{record.reading}</p>}
      {record.anomaly && <p className="record-line anomaly">异常描述：{record.anomaly}</p>}

      {editing ? (
        <div className="note-edit">
          <textarea
            value={draft}
            rows={2}
            onChange={(e) => {
              setDraft(e.target.value);
              if (noteError) setNoteError("");
            }}
            placeholder="填写交接备注（必填）"
          />
          {noteError && <small className="error-text">{noteError}</small>}
          <div className="record-actions">
            <button className="btn-primary-sm" onClick={commitNote}>
              保存备注
            </button>
            <button className="btn-ghost-sm" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="record-line note">交接备注：{record.handoverNote}</p>
          <div className="record-actions">
            {pending ? (
              <>
                <button className="btn-resolve" onClick={() => onStatus(record.id, "已处理")}>
                  ✓ 标记已处理
                </button>
                <button className="btn-transfer" onClick={() => onStatus(record.id, "转交")}>
                  ⇢ 转交下一班
                </button>
              </>
            ) : (
              record.anomaly && (
                <button className="btn-ghost-sm" onClick={() => onStatus(record.id, "待处理")}>
                  重新打开
                </button>
              )
            )}
            <button className="btn-ghost-sm" onClick={() => setEditing(true)}>
              编辑备注
            </button>
          </div>
        </>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* 主应用                                                               */
/* ------------------------------------------------------------------ */

function App() {
  const [records, setRecords] = useState<DutyRecord[]>(loadRecords);
  const [activeShift, setActiveShift] = useState<string>(loadActiveShift);
  const [handovers, setHandovers] = useState<Handover[]>(loadHandovers);
  const [filter, setFilter] = useState<string>("全部");

  const [form, setForm] = useState<FormState>(() => ({
    shift: loadActiveShift(),
    equipment: "",
    reading: "",
    anomaly: "",
    status: "",
    note: "",
  }));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [flash, setFlash] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const flashTimer = useRef<number | null>(null);

  /* ---------------- 持久化：任何变更同步写入浏览器本地 ---------------- */
  useEffect(() => {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
    } catch {
      /* 存储不可用时仅保留内存状态 */
    }
  }, [records]);

  useEffect(() => {
    try {
      localStorage.setItem(SHIFT_KEY, activeShift);
    } catch {
      /* ignore */
    }
  }, [activeShift]);

  useEffect(() => {
    try {
      localStorage.setItem(HANDOVER_KEY, JSON.stringify(handovers));
    } catch {
      /* ignore */
    }
  }, [handovers]);

  // 多标签页打开时同步本地变更
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      try {
        if (e.key === RECORDS_KEY && e.newValue) {
          const data: unknown = JSON.parse(e.newValue);
          if (Array.isArray(data) && data.every(isRecord)) setRecords(data);
        } else if (e.key === SHIFT_KEY && e.newValue) {
          setActiveShift(e.newValue);
        } else if (e.key === HANDOVER_KEY && e.newValue) {
          const data: unknown = JSON.parse(e.newValue);
          if (Array.isArray(data) && data.every(isHandover)) setHandovers(data);
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const showFlash = (text: string, type: "ok" | "err" = "ok") => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    setFlash({ type, text });
    flashTimer.current = window.setTimeout(() => setFlash(null), 3000);
  };

  /* ---------------- 派生数据：置顶排序、阻塞设备、统计 --------------- */

  // 待处理记录全局置顶（异常描述非空保存时自动进入待处理），其余按时间倒序
  const sortedRecords = useMemo(
    () =>
      [...records].sort((a, b) => {
        const ap = a.status === "待处理" ? 0 : 1;
        const bp = b.status === "待处理" ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return b.createdAt - a.createdAt;
      }),
    [records]
  );

  // 只要存在待处理记录，交接班即被阻塞，按设备聚合
  const blockers = useMemo(() => {
    const map = new Map<string, number>();
    records
      .filter((r) => r.status === "待处理")
      .forEach((r) => map.set(r.equipment, (map.get(r.equipment) ?? 0) + 1));
    return Array.from(map, ([equipment, count]) => ({ equipment, count }));
  }, [records]);

  const counts = useMemo(
    () => ({
      total: records.length,
      pending: records.filter((r) => r.status === "待处理").length,
      resolved: records.filter((r) => r.status === "已处理").length,
      transferred: records.filter((r) => r.status === "转交").length,
      normal: records.filter((r) => r.status === "正常").length,
    }),
    [records]
  );

  // 看板统计：取每个指标最新一条读数
  const metricCards = useMemo(
    () =>
      METRICS.map((m) => {
        const latest = [...records]
          .sort((a, b) => b.createdAt - a.createdAt)
          .find((r) => m.test.test(r.reading));
        const match = latest ? m.test.exec(latest.reading) : null;
        return {
          name: m.name,
          unit: m.unit,
          value: match ? match[1] : "",
          source: latest ? `${latest.equipment} · ${latest.shift}` : "暂无读数",
        };
      }),
    [records]
  );

  const visibleRecords = useMemo(
    () => (filter === "全部" ? sortedRecords : sortedRecords.filter((r) => r.equipment === filter)),
    [sortedRecords, filter]
  );
  const visibleAnomalies = useMemo(
    () => visibleRecords.filter((r) => r.anomaly.trim() !== ""),
    [visibleRecords]
  );

  const shiftRecordList = records.filter((r) => r.shift === activeShift);
  const shiftAnomalyCount = shiftRecordList.filter((r) => r.anomaly.trim() !== "").length;
  const handoverBlocked = blockers.length > 0;
  const incomingShift = nextShift(activeShift);

  /* ---------------- 行为：保存 / 状态流转 / 交接 --------------------- */

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const saveRecord = () => {
    const nextErrors: Partial<Record<keyof FormState, string>> = {};
    if (!form.equipment) nextErrors.equipment = "请选择设备";

    // 异常描述非空 → 处理状态自动锁定为「待处理」；否则必须显式选择
    const status: Status = form.anomaly.trim() ? "待处理" : (form.status as Status);
    if (!status) nextErrors.status = "请选择处理状态（填写异常描述后将自动设为待处理）";

    // 处理状态或交接备注为空，一律不得保存
    if (!form.note.trim()) nextErrors.note = "交接备注不能为空，异常与处理意见必须写入交接备注";

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      showFlash("处理状态或交接备注为空（或设备未选择），记录不得保存", "err");
      return;
    }

    const now = Date.now();
    const record: DutyRecord = {
      id: uid(),
      shift: form.shift,
      equipment: form.equipment,
      reading: form.reading.trim(),
      anomaly: form.anomaly.trim(),
      status,
      handoverNote: form.note.trim(),
      createdAt: now,
      updatedAt: now,
    };
    setRecords((prev) => [record, ...prev]);
    setForm({ shift: activeShift, equipment: "", reading: "", anomaly: "", status: "", note: "" });
    showFlash(
      record.anomaly
        ? "记录已保存：异常已自动进入「待处理」并置顶，处理闭环前将阻塞交接班"
        : "记录已保存"
    );
  };

  const changeStatus = (id: string, status: Status) => {
    const target = records.find((r) => r.id === id);
    // 闭环校验：处理状态或交接备注缺失不得落库
    if (!target || !status || !target.handoverNote.trim()) return;
    setRecords((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status, updatedAt: Date.now() } : r))
    );
    showFlash(
      status === "待处理"
        ? "异常已重新打开，恢复置顶并重新阻塞交接班"
        : `已更新为「${status}」，待处理清零后方可完成交接`
    );
  };

  const saveNote = (id: string, note: string) => {
    if (!note.trim()) return false;
    setRecords((prev) =>
      prev.map((r) => (r.id === id ? { ...r, handoverNote: note, updatedAt: Date.now() } : r))
    );
    return true;
  };

  const switchShift = (shift: string) => {
    setActiveShift(shift);
    setForm((prev) => ({ ...prev, shift }));
  };

  const completeHandover = () => {
    if (handoverBlocked) {
      showFlash("仍有待处理记录，交接班不可提交", "err");
      return;
    }
    const handover: Handover = {
      id: uid(),
      fromShift: activeShift,
      toShift: incomingShift,
      at: Date.now(),
      recordCount: shiftRecordList.length,
      anomalyCount: shiftAnomalyCount,
    };
    setHandovers((prev) => [handover, ...prev]);
    showFlash(`${activeShift} 交接完成，已自动切换至 ${incomingShift}`);
    setActiveShift(incomingShift);
    setForm((prev) => ({ ...prev, shift: incomingShift }));
  };

  /* ---------------- 渲染 -------------------------------------------- */

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62001 · 船舶轮机 · 值班交接闭环</p>
        <h1>船舶轮机值班记录</h1>
        <span>
          记录主机转速、滑油压力、冷却水温、燃油消耗、舱底水状态与异常巡检项；异常自动进入待处理并置顶，
          全部处理或转交后才能完成交接班，数据保存在浏览器本地。
        </span>
        <div className="shift-bar">
          <span className="shift-bar-label">值班班次切换（当前交班班次）</span>
          <div className="chips">
            {SHIFTS.map((s) => (
              <button
                key={s}
                className={s === activeShift ? "active" : ""}
                onClick={() => switchShift(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </section>

      {flash && (
        <div className={`flash flash-${flash.type}`} role="status">
          {flash.text}
        </div>
      )}

      {/* 机舱参数看板：随记录实时更新 */}
      <section className="metrics">
        {metricCards.map((m) => (
          <article key={m.name}>
            <small>{m.name}</small>
            <strong>
              {m.value || "—"}
              {m.value && <em className="metric-unit">{m.unit}</em>}
            </strong>
            <span className="metric-source">{m.source}</span>
          </article>
        ))}
      </section>

      <section className="workspace">
        {/* 设备筛选与实时统计 */}
        <aside className="panel">
          <h2>设备筛选</h2>
          <div className="chips filter-chips">
            {FILTERS.map((item) => (
              <button
                key={item}
                className={item === filter ? "active" : ""}
                onClick={() => setFilter(item)}
              >
                {item}
              </button>
            ))}
          </div>

          <h2 className="stat-title">看板统计</h2>
          <ul className="stat-list">
            <li>
              <span>记录总数</span>
              <b>{counts.total}</b>
            </li>
            <li className={counts.pending > 0 ? "stat-pending" : ""}>
              <span>待处理（阻塞交接）</span>
              <b>{counts.pending}</b>
            </li>
            <li>
              <span>已处理</span>
              <b>{counts.resolved}</b>
            </li>
            <li>
              <span>已转交</span>
              <b>{counts.transferred}</b>
            </li>
            <li>
              <span>正常巡检</span>
              <b>{counts.normal}</b>
            </li>
          </ul>
        </aside>

        {/* 新增记录表单 */}
        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增值班记录</h2>
            </div>
          </div>
          <div className="field-grid">
            <label>
              <span>值班班次</span>
              <select value={form.shift} onChange={(e) => updateField("shift", e.target.value)}>
                {SHIFTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>设备名称</span>
              <select
                className={errors.equipment ? "invalid" : ""}
                value={form.equipment}
                onChange={(e) => updateField("equipment", e.target.value)}
              >
                <option value="">请选择设备</option>
                {EQUIPMENTS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              {errors.equipment && <small className="error-text">{errors.equipment}</small>}
            </label>

            <label className="field-wide">
              <span>参数读数</span>
              <input
                placeholder="如：转速82rpm，滑油压力0.42MPa，冷却水温78℃"
                value={form.reading}
                onChange={(e) => updateField("reading", e.target.value)}
              />
            </label>

            <label className="field-wide">
              <span>异常描述（留空表示正常巡检）</span>
              <input
                placeholder="如：发电机#2 冷却水温偏高"
                value={form.anomaly}
                onChange={(e) => updateField("anomaly", e.target.value)}
              />
              {form.anomaly.trim() && <small className="hint hint-warn">检测到异常：处理状态将自动设为「待处理」，记录保存后置顶并阻塞交接</small>}
            </label>

            <label>
              <span>处理状态</span>
              <select
                className={errors.status ? "invalid" : ""}
                value={form.anomaly.trim() ? "待处理" : form.status}
                disabled={!!form.anomaly.trim()}
                onChange={(e) => updateField("status", e.target.value as Status)}
              >
                <option value="">请选择处理状态</option>
                {form.anomaly.trim() ? (
                  <option value="待处理">待处理（异常自动进入）</option>
                ) : (
                  NORMAL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))
                )}
              </select>
              {errors.status && <small className="error-text">{errors.status}</small>}
            </label>

            <label>
              <span>交接备注（必填）</span>
              <textarea
                className={errors.note ? "invalid" : ""}
                rows={2}
                placeholder="处理意见 / 下班注意事项，不能为空"
                value={form.note}
                onChange={(e) => updateField("note", e.target.value)}
              />
              {errors.note && <small className="error-text">{errors.note}</small>}
            </label>
          </div>
          <div className="form-footer">
            <button className="primary" onClick={saveRecord}>
              保存记录
            </button>
            <span className="form-rule">闭环规则：异常描述非空自动待处理并置顶；处理状态或交接备注为空不得保存。</span>
          </div>
        </section>
      </section>

      {/* 交接班摘要 */}
      <section className="panel handover-panel">
        <div className="heading">
          <div>
            <p>交接班闭环</p>
            <h2>交接班摘要</h2>
          </div>
          <div className="handover-actions">
            {handoverBlocked ? (
              <span className="blockers" role="alert">
                <b>⛔ 阻塞设备：</b>
                {blockers.map((b) => (
                  <span key={b.equipment} className="block-chip">
                    {b.equipment}
                    <em>×{b.count}</em>
                  </span>
                ))}
              </span>
            ) : (
              <span className="blockers-clear">✅ 待处理已清零，满足交接条件</span>
            )}
            <button
              className="primary handover-btn"
              disabled={handoverBlocked}
              title={handoverBlocked ? "仍有待处理记录，全部处理或转交后方可交接" : "完成交接班并切换至下一班"}
              onClick={completeHandover}
            >
              完成交接班
            </button>
          </div>
        </div>

        <div className="handover-grid">
          <div>
            <small>交班班次</small>
            <strong>{activeShift}</strong>
          </div>
          <div>
            <small>接班班次</small>
            <strong>{incomingShift}</strong>
          </div>
          <div>
            <small>本班记录</small>
            <strong>{shiftRecordList.length} 条</strong>
          </div>
          <div>
            <small>本班异常</small>
            <strong>{shiftAnomalyCount} 条</strong>
          </div>
          <div className={handoverBlocked ? "cell-blocked" : "cell-clear"}>
            <small>待处理阻塞</small>
            <strong>
              {counts.pending} 条{handoverBlocked ? "（不可提交）" : "（可交接）"}
            </strong>
          </div>
        </div>

        {handovers.length > 0 && (
          <div className="handover-history">
            <h3>交接记录（本地持久化）</h3>
            <ul>
              {handovers.map((h) => (
                <li key={h.id}>
                  <time>{fmtTime(h.at)}</time>
                  <span>
                    {h.fromShift} → {h.toShift}
                  </span>
                  <span>记录 {h.recordCount} 条</span>
                  <span>异常 {h.anomalyCount} 条</span>
                  <span className="handover-ok">✓ 交接完成</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* 异常记录时间线：待处理始终置顶 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>异常闭环</p>
            <h2>异常记录时间线{filter !== "全部" ? `（${filter}）` : ""}</h2>
          </div>
          <span className="heading-side">待处理异常置顶显示，共 {visibleAnomalies.length} 条</span>
        </div>
        {visibleAnomalies.length === 0 ? (
          <p className="empty">当前筛选下暂无异常记录。</p>
        ) : (
          <div className="timeline">
            {visibleAnomalies.map((r) => (
              <RecordCard key={r.id} record={r} timeline onStatus={changeStatus} onSaveNote={saveNote} />
            ))}
          </div>
        )}
      </section>

      {/* 历史记录：按设备筛选 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>值班工作台{filter !== "全部" ? `（筛选：${filter}）` : ""}</h2>
          </div>
          <span className="heading-side">显示 {visibleRecords.length} / {records.length} 条</span>
        </div>
        {visibleRecords.length === 0 ? (
          <p className="empty">当前筛选下暂无记录。</p>
        ) : (
          <div className="record-list">
            {visibleRecords.map((r) => (
              <RecordCard key={r.id} record={r} onStatus={changeStatus} onSaveNote={saveNote} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
