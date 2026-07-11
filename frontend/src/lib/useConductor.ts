import { useRef, useState } from "react";
import type { Project } from "./api";
import { sharedAudioEngine } from "./audioEngine";
import { SensorInput } from "./sensor";
import { GestureInterpreter, type GestureParams, type InstrumentRole } from "./gesture";
import { currentTake } from "../state/store";

export type ConductorStatus = "idle" | "requesting" | "waiting" | "active" | "error";

const ROLE_PAN: Record<InstrumentRole, number> = { melody: -0.7, harmony: 0.7, bass: -0.3, rhythm: 0.3 };

/**
 * 移植自 legacy/js/app.js 里的 startConducting/_applyToAudio + stage2.js，
 * 把「按乐器名硬编码」改成「按角色（melody/harmony/bass/rhythm）」，
 * 因为新架构下项目乐器是任意的。手势解析/传感器采集本身不变
 * （见 lib/sensor.ts、lib/gesture.ts）。
 */
export function useConductor() {
  const [status, setStatus] = useState<ConductorStatus>("idle");
  const [roleActivation, setRoleActivation] = useState<Record<InstrumentRole, number>>({
    melody: 0, harmony: 0, bass: 0, rhythm: 0,
  });
  const [dynamics, setDynamics] = useState(0);
  const gestureRef = useRef<GestureInterpreter | null>(null);

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

  const start = async (project: Project) => {
    setStatus("requesting");
    await sharedAudioEngine.init();
    await sharedAudioEngine.resume();

    for (const inst of project.instruments) {
      const take = currentTake(inst);
      if (take) await sharedAudioEngine.loadTrack(inst.id, take.url, ROLE_PAN[inst.role] ?? 0);
    }

    const sensor = new SensorInput();
    try {
      await sensor.requestPermission();
    } catch (e) {
      setStatus("error");
      throw e;
    }

    const gesture = new GestureInterpreter();
    gesture.baseBpm = project.bpm;
    gestureRef.current = gesture;

    sensor.start();
    setStatus("waiting");
    sharedAudioEngine.playAll();

    sensor.onUpdate((sample) => {
      const params = gesture.process(sample);
      setStatus("active");
      setRoleActivation(params.roles);
      setDynamics(params.dynamics);
      applyToAudio(project, params);
    });
  };

  const stop = () => {
    sharedAudioEngine.stop();
    setStatus("idle");
  };

  return { status, roleActivation, dynamics, start, stop, sensorAvailable: SensorInput.isAvailable() };
}
