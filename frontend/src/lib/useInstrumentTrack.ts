import { useEffect, useState } from "react";
import { sharedAudioEngine } from "./audioEngine";
import { computePeaks } from "./waveform";
import type { Take } from "./api";

/** 把某个乐器当前 take 加载进共享的 AudioEngine，并算出波形峰值。 */
export function useInstrumentTrack(trackId: string, take: Take | null, pan: number) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setReady(false);
    setError("");

    if (!take) {
      sharedAudioEngine.unload(trackId);
      return;
    }

    (async () => {
      await sharedAudioEngine.init();
      const buffer = await sharedAudioEngine.loadTrack(trackId, take.url, pan);
      if (cancelled) return;
      setPeaks(computePeaks(buffer, 200));
      setReady(true);
    })().catch((err) => {
      console.error("加载音轨失败", trackId, err);
      // 只写进控制台的话，界面会永远停在波形的呼吸动画上 —— 那个动画的意思是
      // 「在加载」，而此刻已经不加载了。得说出来，并且给一条能自己走出去的路。
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, take?.take_id, take?.url, attempt]);

  return { peaks, ready, error, retry: () => setAttempt((n) => n + 1), duration: sharedAudioEngine.duration(trackId) };
}
