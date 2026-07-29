import { useEffect, useMemo, useRef, useState } from "react";
import { GestureInterpreter, type GestureParams, type InstrumentRole } from "../../lib/gesture";
import type { SensorSample } from "../../lib/sensor";
import styles from "./DebugConductPage.module.css";

/**
 * 手势解析的调试回放页（仅开发环境，见 App.tsx 的 ?debug=conduct 分支）。
 *
 * 存在的理由：指挥手感的问题——乱响、小动作没声音、停手后死寂——光读代码看不出来，
 * 得看信号。真机测又要手机、要 HTTPS、还没法复现同一个动作。这里用合成序列驱动
 * 真正的 GestureInterpreter（它是纯数值输入输出，不依赖 DeviceMotion），把力度和
 * 四个声部的音量画出来，同一段动作可以反复跑、改完参数立刻对比。
 */

const FRAME_MS = 1000 / 60;
const ROLES: InstrumentRole[] = ["melody", "harmony", "bass", "rhythm"];
const ROLE_LABEL: Record<InstrumentRole, string> = {
  melody: "主旋律",
  harmony: "和声",
  bass: "低音",
  rhythm: "节奏",
};
const ROLE_COLOR: Record<InstrumentRole, string> = {
  melody: "#2f6fed",
  harmony: "#18a999",
  bass: "#8a5cf6",
  rhythm: "#e2803c",
};

interface Preset {
  id: string;
  name: string;
  /** 这段序列想验证什么。 */
  purpose: string;
  durationMs: number;
  sample(tMs: number): SensorSample;
}

/** 构造一帧挥拍：幅度 amp，每拍 beatMs 走一个完整周期。z 含重力，y 用于拍点过零点。 */
function wave(tMs: number, amp: number, beatMs: number, gamma = 0, beta = 0): SensorSample {
  const theta = (2 * Math.PI * tMs) / beatMs;
  return {
    orientation: { alpha: 0, beta, gamma },
    acceleration: { x: 0, y: amp * Math.sin(theta), z: 9.81 + amp * Math.cos(theta) },
    rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    timestamp: tMs,
  };
}

const still = (tMs: number, gamma = 0, beta = 0): SensorSample => ({
  orientation: { alpha: 0, beta, gamma },
  acceleration: { x: 0, y: 0, z: 9.81 },
  rotationRate: { alpha: 0, beta: 0, gamma: 0 },
  timestamp: tMs,
});

const PRESETS: Preset[] = [
  {
    id: "steady",
    name: "① 稳定挥拍",
    purpose: "力度应平稳，不随每一拍上下脉动；节奏声部则应有清晰的逐拍起落。",
    durationMs: 4000,
    sample: (t) => wave(t, 8, 500),
  },
  {
    id: "fading",
    name: "② 幅度由大渐小",
    purpose: "原来「动作稍微小一点就没有声音」。力度应随幅度平滑下降，但不归零。",
    durationMs: 5000,
    sample: (t) => wave(t, 12 - (9 * t) / 5000, 500),
  },
  {
    id: "jitter",
    name: "③ 挥拍中夹抖动",
    purpose: "每 20 帧插一帧静止。力度不应被单帧噪声拽下去，也不该触发收势。",
    durationMs: 4000,
    sample: (t) => (t > 500 && Math.round(t / FRAME_MS) % 20 === 0 ? still(t) : wave(t, 8, 500)),
  },
  {
    id: "cutoff",
    name: "④ 收势后完全静止",
    purpose: "原来「完全停止之后又直接没有声音了」。应约 1 秒平滑衰减到保持音量并维持，不归零、不跳回。",
    durationMs: 5000,
    sample: (t) => (t < 1500 ? wave(t, 9, 500) : still(t)),
  },
  {
    id: "wobble",
    name: "⑤ 朝向在临界值附近微抖",
    purpose: "原来声部会反复开关。四条声部曲线都应平滑，不出现开关式跳变。",
    durationMs: 4000,
    sample: (t) => wave(t, 8, 500, Math.sin(t / 120) * 3),
  },
  {
    id: "emphasis",
    name: "⑥ 左倾强调主旋律",
    purpose: "主旋律应明显突出，其余声部退到背景但仍清晰可闻（绝不静音）。",
    durationMs: 4000,
    sample: (t) => wave(t, 8, 500, t < 1500 ? 0 : -35),
  },
];

interface Frame {
  t: number;
  params: GestureParams;
}

/** 离线跑完整段序列。GestureInterpreter 内部用 performance.now()，这里临时接管它。 */
function runPreset(preset: Preset, baseBpm: number): Frame[] {
  const realNow = performance.now.bind(performance);
  let virtual = 0;
  (performance as { now: () => number }).now = () => virtual;
  try {
    const interp = new GestureInterpreter();
    interp.baseBpm = baseBpm;
    const frames: Frame[] = [];
    for (let t = 0; t <= preset.durationMs; t += FRAME_MS) {
      virtual = t;
      frames.push({ t, params: interp.process(preset.sample(t)) });
    }
    return frames;
  } finally {
    (performance as { now: () => number }).now = realNow;
  }
}

function Chart({ frames }: { frames: Frame[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 用 ResizeObserver 而不是在 effect 里量一次：首次 effect 触发时容器宽度还可能是 0
    // （高度是 CSS 固定值所以量得到，宽度是 100% 要等父级布局），那样画布会是空的。
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();

    function draw() {
      if (!canvas || frames.length === 0) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const total = frames[frames.length - 1].t || 1;
      const x = (t: number) => (t / total) * w;
      const y = (v: number) => h - v * h;

      // 横向刻度：0 / 0.5 / 1.0
      ctx.strokeStyle = "#e3e8f0";
      ctx.lineWidth = 1;
      ctx.fillStyle = "#9aa6b8";
      ctx.font = "11px system-ui, sans-serif";
      for (const v of [0, 0.5, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, y(v));
        ctx.lineTo(w, y(v));
        ctx.stroke();
        ctx.fillText(v.toFixed(1), 2, y(v) - 3);
      }

      // 收势触发点
      for (const f of frames) {
        if (f.params.expression === "cutoff") {
          ctx.strokeStyle = "#d94a4a";
          ctx.beginPath();
          ctx.moveTo(x(f.t), 0);
          ctx.lineTo(x(f.t), h);
          ctx.stroke();
        }
      }

      const line = (get: (f: Frame) => number, color: string, width: number, dashed = false) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dashed ? [4, 3] : []);
        ctx.beginPath();
        frames.forEach((f, i) => {
          const px = x(f.t);
          const py = y(get(f));
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      };

      for (const role of ROLES) line((f) => f.params.roles[role], ROLE_COLOR[role], 1.5);
      // 力度用粗黑线，最终音量 = 声部值 × 力度
      line((f) => f.params.dynamics, "#1b2430", 2.5);
      line((f) => f.params.density, "#c3cad6", 1, true);
    }
  }, [frames]);

  return <canvas ref={canvasRef} className={styles.canvas} />;
}

export function DebugConductPage() {
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [baseBpm, setBaseBpm] = useState(120);
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const frames = useMemo(() => runPreset(preset, baseBpm), [preset, baseBpm]);

  const tail = frames.slice(Math.floor(frames.length * 0.6));
  const summary = useMemo(() => {
    const pick = (get: (f: Frame) => number) => {
      const vs = tail.map(get);
      return { min: Math.min(...vs), max: Math.max(...vs), avg: vs.reduce((a, b) => a + b, 0) / vs.length };
    };
    return {
      dynamics: pick((f) => f.params.dynamics),
      roles: Object.fromEntries(ROLES.map((r) => [r, pick((f) => f.params.roles[r])])) as Record<
        InstrumentRole,
        { min: number; max: number; avg: number }
      >,
      cutoffs: frames.filter((f) => f.params.expression === "cutoff").length,
    };
  }, [frames, tail]);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>手势解析调试</h1>
      <p className={styles.lead}>
        用合成传感器序列驱动真正的 <code>GestureInterpreter</code>，看力度与四个声部的音量曲线。
        改完 <code>lib/gestureConstants.ts</code> 里的参数刷新即可对比。
      </p>

      <div className={styles.controls}>
        <div className={styles.presetRow}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPresetId(p.id)}
              className={`${styles.presetBtn} ${p.id === presetId ? styles.presetActive : ""}`}
            >
              {p.name}
            </button>
          ))}
        </div>
        <label className={styles.bpm}>
          项目 BPM
          <input
            type="number"
            value={baseBpm}
            min={40}
            max={220}
            onChange={(e) => setBaseBpm(Number(e.target.value) || 120)}
          />
        </label>
      </div>

      <p className={styles.purpose}>{preset.purpose}</p>

      <Chart frames={frames} />

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <i style={{ background: "#1b2430", height: 3 }} />
          力度
        </span>
        {ROLES.map((r) => (
          <span key={r} className={styles.legendItem}>
            <i style={{ background: ROLE_COLOR[r] }} />
            {ROLE_LABEL[r]}
          </span>
        ))}
        <span className={styles.legendItem}>
          <i style={{ background: "#c3cad6" }} />
          密度
        </span>
        <span className={styles.legendItem}>
          <i style={{ background: "#d94a4a" }} />
          收势触发
        </span>
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>信号</th>
            <th>最小</th>
            <th>平均</th>
            <th>最大</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>力度</td>
            <td>{summary.dynamics.min.toFixed(3)}</td>
            <td>{summary.dynamics.avg.toFixed(3)}</td>
            <td>{summary.dynamics.max.toFixed(3)}</td>
          </tr>
          {ROLES.map((r) => (
            <tr key={r}>
              <td>{ROLE_LABEL[r]}</td>
              <td>{summary.roles[r].min.toFixed(3)}</td>
              <td>{summary.roles[r].avg.toFixed(3)}</td>
              <td>{summary.roles[r].max.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.note}>
        统计取序列后 40%（跳过启动瞬态）。收势触发 {summary.cutoffs} 次。
      </p>
    </div>
  );
}
