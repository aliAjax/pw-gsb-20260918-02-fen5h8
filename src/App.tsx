import { useEffect, useMemo, useState } from "react";
import "./styles.css";

/* ========== 基础配置 ========== */

const PROJECT = {
  id: "hxyfront-62001",
  sourceNo: 1,
  port: 62001,
  title: "船舶轮机值班记录",
  domain: "船舶轮机",
};

const SHIFTS = ["00-04班", "04-08班", "08-12班", "12-16班", "16-20班", "20-24班"];

const DEVICES = ["主机", "发电机", "泵组", "舱底水"];

// 处理状态：前两项为未闭环状态（阻塞交接），后两项为终态（闭环）
const OPEN_STATUSES = ["待处理", "处理中"] as const;
const DONE_STATUSES = ["已处理", "已转交"] as const;
const STATUSES = [...OPEN_STATUSES, ...DONE_STATUSES] as const;

type Status = (typeof STATUSES)[number];

interface WatchRecord {
  id: string;
  shift: string;
  device: string;
  reading: string;
  anomaly: string;
  status: Status | "正常";
  note: string;
  createdAt: number;
}

interface HandoverLog {
  shift: string;
  at: number;
  recordCount: number;
  closedCount: number;
}

interface PersistShape {
  records: WatchRecord[];
  handovers: HandoverLog[];
}

const STORAGE_KEY = "hxyfront-62001-watch-v1";
const DEFAULT_SHIFT = "12-16班";

const STATUS_LABEL: Record<Status | "正常", string> = {
  待处理: "待处理",
  处理中: "处理中",
  已处理: "已处理",
  已转交: "已转交",
  正常: "正常",
};

const isOpenStatus = (s: WatchRecord["status"]) =>
  (OPEN_STATUSES as readonly string[]).includes(s);
const isDoneStatus = (s: WatchRecord["status"]) =>
  (DONE_STATUSES as readonly string[]).includes(s);

/* ========== 种子数据（仅首次访问写入本地） ========== */

function seedData(): PersistShape {
  const now = Date.now();
  const mk = (
    i: number,
    shift: string,
    device: string,
    reading: string,
    anomaly: string,
    status: WatchRecord["status"],
    note: string,
    gapMin = 0
  ): WatchRecord => ({
    id: `seed-${i}`,
    shift,
    device,
    reading,
    anomaly,
    status,
    note,
    createdAt: now - gapMin * 60_000,
  });
  return {
    records: [
      mk(1, "08-12班", "主机", "转速82rpm，滑油压力0.42MPa", "", "正常", "运行参数正常，无异常。", 180),
      mk(2, "12-16班", "发电机", "发电机#2 冷却水温86℃", "冷却水温偏高，超过80℃报警阈值。", "待处理", "等待电机员复查冷却器。", 120),
      mk(3, "12-16班", "主机", "转速78rpm，排温略有波动", "增压器喘振疑似，降速5rpm观察。", "处理中", "已降速运行，需持续观察排温。", 70),
      mk(4, "12-16班", "泵组", "舱底水泵#1 出口压力0.28MPa", "", "正常", "泵压稳定，运转声音正常。", 40),
      mk(5, "16-20班", "舱底水", "液位距警戒线0.3m", "液位接近警戒线。", "已转交", "已通知下一班重点复查并安排排水。", 10),
    ],
    handovers: [],
  };
}

/* ========== 本地持久化 ========== */

function loadData(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.records) && Array.isArray(parsed.handovers)) {
        return parsed;
      }
    }
  } catch {
    // 本地数据损坏时回退到种子数据
  }
  return seedData();
}

/* ========== 组件 ========== */

type FormState = {
  device: string;
  reading: string;
  anomaly: string;
  status: Status;
  note: string;
};

const EMPTY_FORM: FormState = {
  device: DEVICES[0],
  reading: "",
  anomaly: "",
  status: "待处理",
  note: "",
};

function App() {
  const [data, setData] = useState<PersistShape>(loadData);
  const [activeShift, setActiveShift] = useState(DEFAULT_SHIFT);
  const [deviceFilter, setDeviceFilter] = useState<string>("全部");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string>("");
  const [handoverError, setHandoverError] = useState<string>("");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // 存储不可用时仅保留内存状态
    }
  }, [data]);

  const isShiftHandedOver = (shift: string) =>
    data.handovers.some((h) => h.shift === shift);
  const shiftHandedOver = isShiftHandedOver(activeShift);

  /* ----- 派生数据 ----- */

  const shiftRecords = useMemo(
    () =>
      data.records
        .filter((r) => r.shift === activeShift)
        .sort((a, b) => b.createdAt - a.createdAt),
    [data.records, activeShift]
  );

  // 待处理记录自动置顶：待处理 > 处理中/其他 > 正常；同级新记录在前
  const sortedRecords = useMemo(() => {
    const rank = (r: WatchRecord) =>
      r.status === "待处理" ? 0 : isOpenStatus(r.status) ? 1 : 2;
    return [...shiftRecords]
      .filter((r) => deviceFilter === "全部" || r.device === deviceFilter)
      .sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
  }, [shiftRecords, deviceFilter]);

  // 阻塞设备：当前班次存在未闭环（待处理/处理中）记录的设备，去重
  const blockerDevices = useMemo(() => {
    const set = new Set<string>();
    shiftRecords.forEach((r) => {
      if (isOpenStatus(r.status)) set.add(r.device);
    });
    return [...set];
  }, [shiftRecords]);

  const canHandover = !shiftHandedOver && blockerDevices.length === 0;

  // 看板统计（跟随设备筛选与班次切换同步）
  const stats = useMemo(() => {
    const list = shiftRecords.filter(
      (r) => deviceFilter === "全部" || r.device === deviceFilter
    );
    const pending = list.filter((r) => r.status === "待处理").length;
    const processing = list.filter((r) => r.status === "处理中").length;
    const closed = list.filter((r) => isDoneStatus(r.status)).length;
    const blockingSet = new Set<string>();
    list.forEach((r) => {
      if (isOpenStatus(r.status)) blockingSet.add(r.device);
    });
    return { total: list.length, pending, processing, closed, blocking: blockingSet.size };
  }, [shiftRecords, deviceFilter]);

  /* ----- 表单：异常描述非空 -> 自动待处理 ----- */

  const anomalyActive = form.anomaly.trim().length > 0;

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "anomaly") {
        const hasAnomaly = String(value).trim().length > 0;
        if (hasAnomaly) {
          // 异常描述非空时自动进入待处理
          next.status = "待处理";
        } else if (prev.status !== "正常") {
          next.status = "待处理";
        }
      }
      return next;
    });
    setFormError("");
  };

  // 保存校验：处理状态或交接备注为空不得保存
  const handleSave = () => {
    if (shiftHandedOver) {
      setFormError("本班次已完成交接，不能再新增记录。");
      return;
    }
    if (!form.reading.trim()) {
      setFormError("参数读数不能为空。");
      return;
    }
    if (anomalyActive && !form.status.trim()) {
      setFormError("存在异常描述时，处理状态不能为空。");
      return;
    }
    if (!form.note.trim()) {
      setFormError("交接备注不能为空，闭环交接必须留痕。");
      return;
    }
    const record: WatchRecord = {
      id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      shift: activeShift,
      device: form.device,
      reading: form.reading.trim(),
      anomaly: form.anomaly.trim(),
      status: anomalyActive ? form.status : "正常",
      note: form.note.trim(),
      createdAt: Date.now(),
    };
    setData((prev) => ({ ...prev, records: [...prev.records, record] }));
    setForm(EMPTY_FORM);
    setFormError("");
  };

  /* ----- 记录处置：状态更新 / 删除 ----- */

  const updateStatus = (id: string, status: WatchRecord["status"]) => {
    if (shiftHandedOver) return;
    setData((prev) => ({
      ...prev,
      records: prev.records.map((r) => (r.id === id ? { ...r, status } : r)),
    }));
  };

  const removeRecord = (id: string) => {
    if (shiftHandedOver) return;
    setData((prev) => ({ ...prev, records: prev.records.filter((r) => r.id !== id) }));
  };

  /* ----- 交接班闭环 ----- */

  const handleHandover = () => {
    if (blockerDevices.length > 0) {
      setHandoverError(`仍有未闭环设备：${blockerDevices.join("、")}，交接被阻塞。`);
      return;
    }
    setData((prev) => ({
      ...prev,
      handovers: [
        ...prev.handovers,
        {
          shift: activeShift,
          at: Date.now(),
          recordCount: shiftRecords.length,
          closedCount: shiftRecords.filter((r) => !isOpenStatus(r.status)).length,
        },
      ],
    }));
    setHandoverError("");
    // 交接完成后切到下一个未交接班次
    const idx = SHIFTS.indexOf(activeShift);
    const next = SHIFTS.slice(idx + 1).find((s) => !isShiftHandedOver(s));
    if (next) setActiveShift(next);
  };

  const handoverTime = data.handovers.find((h) => h.shift === activeShift)?.at;

  /* ========== 渲染 ========== */

  return (
    <main className="app">
      <section className="hero">
        <p>
          {PROJECT.id} · 源提示词{PROJECT.sourceNo} · Port {PROJECT.port}
        </p>
        <h1>{PROJECT.title}</h1>
        <span>
          轮机值班记录交接闭环：异常描述非空自动进入「待处理」并置顶；处理状态或交接备注为空不得保存；存在待处理记录时交接班被阻塞，全部处理或转交后方可完成交接。数据仅保存在本浏览器。
        </span>
      </section>

      {/* 值班班次切换 */}
      <section className="panel shift-bar">
        <div className="heading">
          <div>
            <p>值班班次</p>
            <h2>班次切换</h2>
          </div>
        </div>
        <div className="chips shift-chips">
          {SHIFTS.map((s) => {
            const handed = isShiftHandedOver(s);
            return (
              <button
                key={s}
                className={[
                  "shift-chip",
                  s === activeShift ? "active" : "",
                  handed ? "handed" : "",
                ].join(" ")}
                onClick={() => {
                  setActiveShift(s);
                  setFormError("");
                  setHandoverError("");
                }}
              >
                {s}
                {handed ? " ✓已交接" : ""}
              </button>
            );
          })}
        </div>
      </section>

      {/* 机舱参数看板（统计随筛选/班次同步） */}
      <section className="metrics">
        <MetricCard label="本班记录总数" value={stats.total} tone="secondary" />
        <MetricCard label="待处理异常" value={stats.pending} tone="accent" pin />
        <MetricCard label="处理中" value={stats.processing} tone="secondary" />
        <MetricCard label="闭环 / 阻塞设备" value={`${stats.closed} / ${stats.blocking}`} tone="primary" />
      </section>

      <section className="workspace">
        {/* 设备筛选 */}
        <aside className="panel">
          <h2>设备筛选</h2>
          <div className="chips">
            <button
              className={deviceFilter === "全部" ? "active" : ""}
              onClick={() => setDeviceFilter("全部")}
            >
              全部
            </button>
            {DEVICES.map((item) => (
              <button
                key={item}
                className={deviceFilter === item ? "active" : ""}
                onClick={() => setDeviceFilter(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <p className="filter-hint">
            当前筛选：{deviceFilter}；阻塞设备判定始终覆盖整个班次，不受筛选影响。
          </p>
        </aside>

        {/* 新增记录表单 */}
        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录{shiftHandedOver ? "（本班已交接，只读）" : ""}</h2>
            </div>
            <button
              className="primary"
              onClick={handleSave}
              disabled={shiftHandedOver}
            >
              保存记录
            </button>
          </div>
          <div className="field-grid">
            <label>
              <span>值班班次</span>
              <input value={activeShift} readOnly />
            </label>
            <label>
              <span>设备名称 *</span>
              <select
                value={form.device}
                disabled={shiftHandedOver}
                onChange={(e) => updateForm("device", e.target.value)}
              >
                {DEVICES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="span-2">
              <span>参数读数 *（主机转速 / 滑油压力 / 冷却水温 / 燃油消耗 / 舱底水液位等）</span>
              <input
                placeholder="例如：转速82rpm，滑油压力0.42MPa，冷却水温76℃"
                value={form.reading}
                disabled={shiftHandedOver}
                onChange={(e) => updateForm("reading", e.target.value)}
              />
            </label>
            <label className="span-2">
              <span>异常描述（非空将自动置为「待处理」并在时间线置顶）</span>
              <textarea
                rows={2}
                placeholder="无异常可留空；填写后该记录必须闭环（已处理 / 已转交）才能交接"
                value={form.anomaly}
                disabled={shiftHandedOver}
                onChange={(e) => updateForm("anomaly", e.target.value)}
              />
            </label>
            <label>
              <span>处理状态 *</span>
              <select
                value={anomalyActive ? form.status : "正常"}
                disabled={shiftHandedOver || !anomalyActive}
                onChange={(e) => updateForm("status", e.target.value as Status)}
              >
                {!anomalyActive && <option value="正常">正常</option>}
                {STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {STATUS_LABEL[st]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>交接备注 *（为空不得保存）</span>
              <input
                placeholder="本班处置情况与下班注意事项"
                value={form.note}
                disabled={shiftHandedOver}
                onChange={(e) => updateForm("note", e.target.value)}
              />
            </label>
          </div>
          {formError && <p className="form-error">⚠ {formError}</p>}
          {anomalyActive && (
            <p className="form-tip">
              已检测到异常描述，记录状态自动锁定为待处理类，保存后将在时间线置顶，闭环前本班无法交接。
            </p>
          )}
        </section>
      </section>

      {/* 交接班摘要 + 闭环按钮 */}
      <section className="panel handover-panel">
        <div className="heading">
          <div>
            <p>交接班摘要</p>
            <h2>
              {activeShift}
              {shiftHandedOver && handoverTime
                ? ` · 已于 ${new Date(handoverTime).toLocaleString("zh-CN")} 完成交接`
                : " · 交接闭环"}
            </h2>
          </div>
          <div className="handover-action">
            <button
              className="primary handover-btn"
              disabled={!canHandover}
              onClick={handleHandover}
              title={canHandover ? "全部异常已闭环，可以交接" : "仍有未闭环异常，交接被阻塞"}
            >
              完成交接班
            </button>
            {/* 按钮旁列出阻塞设备，存在待处理时保持不可提交 */}
            {!shiftHandedOver && blockerDevices.length > 0 && (
              <span className="blockers">
                <b>阻塞设备：</b>
                {blockerDevices.map((d) => (
                  <em key={d} className="blocker-tag">
                    {d}
                  </em>
                ))}
              </span>
            )}
            {!shiftHandedOver && blockerDevices.length === 0 && (
              <span className="blockers ok">无阻塞设备，可提交交接</span>
            )}
          </div>
        </div>
        <div className="handover-summary">
          <span>记录 {shiftRecords.length} 条</span>
          <span>待处理 {shiftRecords.filter((r) => r.status === "待处理").length} 条</span>
          <span>处理中 {shiftRecords.filter((r) => r.status === "处理中").length} 条</span>
          <span>已处理 {shiftRecords.filter((r) => r.status === "已处理").length} 条</span>
          <span>已转交 {shiftRecords.filter((r) => r.status === "已转交").length} 条</span>
        </div>
        {handoverError && <p className="form-error">⚠ {handoverError}</p>}
      </section>

      {/* 异常记录时间线（待处理置顶）+ 历史记录 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录 / 异常时间线</p>
            <h2>
              {activeShift} · {deviceFilter}
            </h2>
          </div>
        </div>
        <div className="records">
          {sortedRecords.length === 0 && (
            <p className="empty-tip">当前班次与筛选条件下暂无记录。</p>
          )}
          {sortedRecords.map((record, index) => (
            <article
              key={record.id}
              className={[
                "record-card",
                record.status === "待处理" ? "pinned" : "",
                isOpenStatus(record.status) ? "open" : "",
              ].join(" ")}
            >
              <b>{String(index + 1).padStart(2, "0")}</b>
              <div className="record-body">
                <div className="record-meta">
                  <h3>
                    {record.device}
                    {record.status === "待处理" && <span className="pin-flag">📌 置顶 · 待处理</span>}
                    {record.status === "处理中" && <span className="pin-flag processing">处理中</span>}
                    {record.status === "已转交" && <span className="pin-flag done">已转交下一班</span>}
                    {record.status === "已处理" && <span className="pin-flag done">已处理闭环</span>}
                  </h3>
                  <small>{new Date(record.createdAt).toLocaleString("zh-CN")}</small>
                </div>
                <p className="reading">📊 {record.reading}</p>
                {record.anomaly && <p className="anomaly">⚠ 异常：{record.anomaly}</p>}
                <p className="note">📝 交接备注：{record.note}</p>
                <div className="record-actions">
                  <label className="inline-select">
                    <span>处置：</span>
                    <select
                      value={record.status}
                      disabled={shiftHandedOver}
                      onChange={(e) =>
                        updateStatus(record.id, e.target.value as WatchRecord["status"])
                      }
                    >
                      {record.anomaly === "" && <option value="正常">正常</option>}
                      {STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {STATUS_LABEL[st]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="ghost-danger"
                    disabled={shiftHandedOver}
                    onClick={() => removeRecord(record.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function MetricCard({
  label,
  value,
  tone,
  pin,
}: {
  label: string;
  value: number | string;
  tone: "primary" | "secondary" | "accent";
  pin?: boolean;
}) {
  return (
    <article className={`metric-${tone}`}>
      <small>{label}</small>
      <strong>
        {value}
        {pin && Number(value) > 0 ? <em className="pulse">待闭环</em> : null}
      </strong>
    </article>
  );
}

export default App;
