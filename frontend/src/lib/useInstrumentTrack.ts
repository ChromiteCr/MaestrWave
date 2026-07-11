import { useEffect, useState } from "react";
import { sharedAudioEngine } from "./audioEngine";
import { computePeaks } from "./waveform";
import type { Take } from "./api";

/** 把某个乐器当前 take 加载进共享的 AudioEngine，并算出波形峰值。 */
export function useInstrumentTrack(trackId: string, take: Take | null, pan: number) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setReady(false);

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
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, take?.take_id, take?.url]);

  return { peaks, ready, duration: sharedAudioEngine.duration(trackId) };
}
