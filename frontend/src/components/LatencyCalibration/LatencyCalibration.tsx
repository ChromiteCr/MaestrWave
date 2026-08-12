import { useCallback, useEffect, useRef, useState } from "react";
import {
  CALIBRATION_TAPS, LatencyCalibrator, clearLatency, getLatencyMs, setLatencyMs,
  type CalibrationResult,
} from "../../lib/teaching/latency";
import { Button } from "../Button/Button";
import styles from "./LatencyCalibration.module.css";

/**
 * 音画延迟校准的界面：跟着咔哒声敲十下，把「你 + 这套设备」的固定偏移量出来。
 *
 * 为什么值得做成一个专门的步骤：戴蓝牙耳机的人不校准的话，每一拍都会被判成
 * 拖了两百毫秒 —— 分数低得莫名其妙，而且怎么练都不会好。理由详见
 * `lib/teaching/latency.ts` 的文件头。
 */

/** 敲得比这还散，说明这一轮没敲准，值不可信。 */
const UNRELIABLE_SPREAD_MS = 60;

export function LatencyCalibration({ compact = false }: { compact?: boolean }) {
  const [saved, setSaved] = useState(() => getLatencyMs());
  const [running, setRunning] = useState(false);
  const [taps, setTaps] = useState(0);
  const [last, setLast] = useState<number | null>(null);
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState("");
  const ref = useRef<LatencyCalibrator | null>(null);

  const finish = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    const r = c.result();
    c.stop();
    ref.current = null;
    setRunning(false);
    setResult(r);
    if (!r) setError("有效的敲击太少，再来一次。");
  }, []);

  const tap = useCallback(() => {
    const c = ref.current;
    if (!c?.running) return;
    // 时刻要在这里立刻取：等 React 重渲染完再取就晚了十几毫秒，
    // 而这个组件量的正是十几毫秒级的东西
    const off = c.tap(performance.now());
    if (off !== null) setLast(off);
    setTaps(c.taps);
    if (c.done) finish();
  }, [finish]);

  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault(); // 空格默认会滚动页面
      tap();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, tap]);

  useEffect(() => () => ref.current?.stop(), []);

  const start = async () => {
    setError("");
    setResult(null);
    setLast(null);
    setTaps(0);
    const c = new LatencyCalibrator();
    ref.current = c;
    try {
      await c.start();
      setRunning(true);
    } catch (e) {
      ref.current = null;
      setError(`节拍器启动失败：${e instanceof Error ? e.message : e}`);
    }
  };

  const apply = () => {
    if (!result) return;
    setLatencyMs(result.offsetMs);
    setSaved(result.offsetMs);
    setResult(null);
  };

  const reset = () => {
    clearLatency();
    setSaved(0);
    setResult(null);
  };

  return (
    <div className={compact ? styles.compact : styles.wrap}>
      {!compact && (
        <p className={styles.intro}>
          评分要拿你的拍点和音乐的拍点相减，所以必须知道声音<strong>真正到达你耳朵</strong>的时刻。
          浏览器报的输出延迟不含蓝牙那一段（无线耳机通常还有 150~250ms），不校准的话
          你每一拍都会被判成拖拍。
        </p>
      )}

      <div className={styles.statusRow}>
        <span className="mono-chip">
          {saved === 0 ? "未校准" : `已校准 ${saved > 0 ? "+" : ""}${saved}ms`}
        </span>
        {saved !== 0 && (
          <button type="button" className={styles.link} onClick={reset}>
            清除
          </button>
        )}
      </div>

      {running ? (
        <>
          <button type="button" className={styles.tapPad} onClick={tap}>
            <span className={styles.tapBig}>{taps} / {CALIBRATION_TAPS}</span>
            <span className={styles.tapHint}>跟着咔哒声敲这里（或按空格）</span>
            {last !== null && (
              <span className={styles.tapLast}>
                这一下{last > 0 ? "晚" : "早"} {Math.abs(last).toFixed(0)}ms
              </span>
            )}
          </button>
          <div className={styles.actions}>
            <Button onClick={finish}>就到这里</Button>
          </div>
        </>
      ) : result ? (
        <div className={styles.result}>
          <p className={styles.resultLine}>
            测到的固定偏移是 <strong>{result.offsetMs > 0 ? "+" : ""}{result.offsetMs}ms</strong>
            （{result.taps} 下，彼此相差 {result.spreadMs}ms）。
          </p>
          <p className={styles.resultNote}>
            {result.spreadMs > UNRELIABLE_SPREAD_MS
              ? "这几下自己就差得挺多，这个值不太可信。建议重来一次，跟着咔哒声放松地敲。"
              : Math.abs(result.offsetMs) > 120
                ? "偏移这么大，基本可以确定是无线耳机或外接音箱的延迟。用上它，分数才反映你真实的水平。"
                : "偏移不大，属于正常范围。用不用都行，用上会更准一点。"}
          </p>
          <div className={styles.actions}>
            <Button variant="primary" onClick={apply}>用这个值</Button>
            <Button onClick={start}>再测一次</Button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <Button variant="primary" onClick={start}>
            {saved === 0 ? "开始校准" : "重新校准"}
          </Button>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
