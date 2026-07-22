import { useRef, useState } from "react";
import type { Project } from "./api";
import { sharedAudioEngine } from "./audioEngine";
import { GestureInterpreter, type GestureParams, type InstrumentRole } from "./gesture";
import type { SensorSource } from "./sensorSource";
import { currentTake } from "../state/store";

export type ConductorStatus = "idle" | "requesting" | "waiting" | "active" | "nodata" | "error";

const ROLE_PAN: Record<InstrumentRole, number> = { melody: -0.7, harmony: 0.7, bass: -0.3, rhythm: 0.3 };

/** 起播后多久还没收到任何采样，就认为这台设备没有传感器（或手机还没连上）。 */
const NO_DATA_TIMEOUT_MS = 5000;

/**
 * 指挥编排（移植自 legacy/js/app.js 的 startConducting/_applyToAudio + stage2.js）。
 *
 * M4 起「传感器从哪来」由调用方通过 SensorSource 注入（见 lib/sensorSource.ts），
 * 因此单机模式和电脑模式共用这一份逻辑：这里只负责装载音轨、解析手势、
 * 把参数写进音频引擎，不关心采样是本机采的还是手机发来的。
 *
 * 手势解析始终跑在这一侧，因为节拍检测依赖 60 帧历史窗口和项目 baseBpm。
 */
export function useConductor() {
  const [status, setStatus] = useState<ConductorStatus>("idle");
  const [roleActivation, setRoleActivation] = useState<Record<InstrumentRole, number>>({
    melody: 0, harmony: 0, bass: 0, rhythm: 0,
  });
  const [dynamics, setDynamics] = useState(0);
  const gestureRef = useRef<GestureInterpreter | null>(null);
  const sourceRef = useRef<SensorSource | null>(null);
  const noDataTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gotSampleRef = useRef(false);

  const applyToAudio = (project: Project, params: GestureParams) => {
    for (const inst of project.instruments) {
      if (!inst.current_take_id) continue;
      const activation = params.roles[inst.role] ?? 0;
      sharedAudioEngine.setTrackVolume(inst.id, activation * params.dynamics);
    }
    sharedAudioEngine.setPlaybackRate(params.tempo);

    if (params.density < 0.3) {
      const sorted = (Object.entries(params.roles) as [InstrumentRole, number][]).sort((a, b) => b[1] - a[1]);
      const quietRoles = new Set(sorted.slice(2).map(([role]) => role));
      for (const inst of project.instruments) {
        if (quietRoles.has(inst.role)) sharedAudioEngine.setTrackVolume(inst.id, 0);
      }
    }
    if (params.expression === "cutoff") {
      sharedAudioEngine.setMasterVolume(0);
      setTimeout(() => sharedAudioEngine.setMasterVolume(1), 100);
    }
  };

  const start = async (project: Project, source: SensorSource) => {
    setStatus("requesting");
    await sharedAudioEngine.init();
    await sharedAudioEngine.resume();

    for (const inst of project.instruments) {
      const take = currentTake(inst);
      if (take) await sharedAudioEngine.loadTrack(inst.id, take.url, ROLE_PAN[inst.role] ?? 0);
    }

    try {
      await source.start();
    } catch (e) {
      setStatus("error");
      throw e;
    }
    sourceRef.current = source;

    const gesture = new GestureInterpreter();
    gesture.baseBpm = project.bpm;
    gestureRef.current = gesture;

    setStatus("waiting");
    sharedAudioEngine.playAll();

    // legacy 版本里有这个「5 秒无数据」检测，M2 移植时漏掉了，导致桌面端
    // 点了开始后音乐在放、界面却永远停在「等待手势…」。这里补回来。
    gotSampleRef.current = false;
    if (noDataTimerRef.current) clearTimeout(noDataTimerRef.current);
    noDataTimerRef.current = setTimeout(() => {
      if (!gotSampleRef.current) setStatus("nodata");
    }, NO_DATA_TIMEOUT_MS);

    source.onSample((sample) => {
      gotSampleRef.current = true;
      const params = gesture.process(sample);
      setStatus("active");
      setRoleActivation(params.roles);
      setDynamics(params.dynamics);
      applyToAudio(project, params);
    });
  };

  const stop = () => {
    if (noDataTimerRef.current) {
      clearTimeout(noDataTimerRef.current);
      noDataTimerRef.current = null;
    }
    sourceRef.current?.stop();
    sourceRef.current = null;
    sharedAudioEngine.stop();
    setRoleActivation({ melody: 0, harmony: 0, bass: 0, rhythm: 0 });
    setDynamics(0);
    setStatus("idle");
  };

  return { status, roleActivation, dynamics, start, stop };
}
