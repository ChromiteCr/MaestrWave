import { useRef, useState } from "react";
import type { Project } from "./api";
import { sharedAudioEngine } from "./audioEngine";
import { mixIntent, type GestureParams, type InstrumentRole } from "./gesture";
import { VOLUME_GAMMA } from "./gestureConstants";
import type { IntentSource } from "./intentSource";
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
  /** 相对项目基准速度的倍率。指挥台把它乘回 bpm 显示成「你现在打的速度」。 */
  const [tempo, setTempo] = useState(1);
  /**
   * 用户打完的拍数，每确认一个拍点 +1。
   *
   * 给界面当**事件**用：值本身没有意义，变了才有意义（指挥台靠它闪一下）。
   * 不直接把 `beatPulse` 交出去 —— 那是个每帧都在衰减的连续量，界面拿它去判
   * 「是不是新的一拍」只能设阈值，而一拍之内它会在阈值上停留好几帧。
   */
  const [beatCount, setBeatCount] = useState(0);
  const sourceRef = useRef<IntentSource | null>(null);
  const noDataTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gotSampleRef = useRef(false);
  const prevPulseRef = useRef(0);
  /**
   * 第几次启动。`stop()` 把它 +1，在飞的那次 `start()` 就此作废。
   *
   * **不能只靠 `sourceRef` 判断**：`start()` 从头到尾全是 await —— 十四条音轨串行
   * 下载解码，再是 `getUserMedia`（权限弹窗，用户不点就一直等），再是 MediaPipe 的
   * wasm 与模型（一到三秒）。这整段时间里按钮已经显示「停止」了（`status` 一进门就
   * 变成 requesting），而用户这时点停止，`start()` 并不会因此中断：它会继续走到
   * `playAll()`，摄像头亮灯、音乐起播 —— 如果人已经切去别的页，`OutputPage` 连同
   * 它持有的 `cameraRef` 一起卸载了，就再也没有任何东西能停下这台摄像头。
   */
  const runIdRef = useRef(0);

  /**
   * M4b：每个乐器每帧只写一次音量。
   *
   * 原实现先按 activation*dynamics 写一遍，density 条件成立时又对部分乐器写第二次 0，
   * 同帧两次调用各自触发一段 gain ramp、互相打断，是"乱响"里那层咔哒声的来源。
   * 现在先把最终值算出来再统一写。
   *
   * cutoff 也不再在这里动主音量：原来是 setMasterVolume(0) 之后 100ms 无条件拉回 1，
   * 既不管用户是不是还在指挥、也不管当前该是什么音量，和每帧持续写入的 trackVolume
   * 直接冲突 —— 这就是"完全停止之后又直接没有声音了"。收势现在由 GestureInterpreter
   * 自己走 dynamics 的 release 曲线，全系统只有那一套衰减机制。
   *
   * M4c：删掉了原来"density<0.3 时按当前帧四个角色的相对大小排序、把最低的两个强制
   * 静音"那段。排序逐帧重算，稍有抖动名次就翻转，刚静音的声部下一帧又起播 —— 这是
   * "乐器乱响"最直接的来源。声部音量现在由 mixIntent 各自独立算出，不比名次、不关声部。
   */
  const applyToAudio = (project: Project, params: GestureParams) => {
    for (const inst of project.instruments) {
      if (!inst.current_take_id) continue;
      const activation = params.roles[inst.role] ?? 0;
      // 响度曲线：只抬中间，顶不动。理由和实测数字见 VOLUME_GAMMA。
      sharedAudioEngine.setTrackVolume(inst.id, (activation * params.dynamics) ** VOLUME_GAMMA);
    }
    sharedAudioEngine.setPlaybackRate(params.tempo);
  };

  const start = async (project: Project, source: IntentSource) => {
    // 这一轮的编号。每个 await 之后都要问一次「我还是当前这一轮吗」，不是了就
    // 收摊走人：既不能再 setStatus（会把界面从 idle 拽回 active），也不能起播。
    const runId = ++runIdRef.current;
    const cancelled = () => runIdRef.current !== runId;

    setStatus("requesting");
    await sharedAudioEngine.init();
    await sharedAudioEngine.resume();
    if (cancelled()) return;

    // 一条声部加载不出来**不能拖垮整场指挥**。原来这里是裸的 await，任何一条抛出
    // （解码偶发失败、文件被删）都会让 start() 整个挂掉，用户看到的是「点了开始指挥
    // 没反应」，而真实交响乐有十四条轨、撞上的概率是单条的十四倍。
    // 逐条串行加载不改：十几条同时解码正是解码器最容易失手的时候。
    const failed: string[] = [];
    for (const inst of project.instruments) {
      const take = currentTake(inst);
      if (!take) continue;
      try {
        await sharedAudioEngine.loadTrack(inst.id, take.url, ROLE_PAN[inst.role] ?? 0);
      } catch (e) {
        failed.push(inst.display_name || inst.id);
        console.error("指挥前加载音轨失败", inst.id, e);
      }
      // 十四条轨串行下载解码，是整个启动流程里最长的一段等待
      if (cancelled()) return;
    }
    if (failed.length && sharedAudioEngine.trackIds().length === 0) {
      setStatus("error");
      throw new Error(`没有一条音轨加载得出来（${failed.join("、")}）`);
    }

    source.setBaseBpm(project.bpm);
    // **先挂上再启动。** `stop()` 唯一够得着源的手段就是 `sourceRef`，晚一步挂，
    // 就等于 `source.start()` 那几秒里怎么点停止都没用。两种源的 `stop()` 都只是
    // 清 listener、对 null 做空操作，没启动就停是安全的。
    sourceRef.current = source;
    try {
      await source.start();
    } catch (e) {
      if (sourceRef.current === source) sourceRef.current = null;
      // 已经被叫停就不要再报错：用户主动取消不是失败，弹一句「启动失败」是在说谎
      if (cancelled()) return;
      setStatus("error");
      throw e;
    }
    /*
     * 到这里摄像头已经真的打开了。若这期间用户点过停止，`stop()` 那一次
     * `source.stop()` 很可能什么都没关掉 —— HandTracker 的 stream 与 landmarker
     * 都是 await 之后才赋值的，停的时候它们还是 null。所以必须在这里再收一次，
     * 这一次才真的关得掉设备；并且绝不能往下走到 `playAll()`。
     */
    if (cancelled()) {
      source.stop();
      if (sourceRef.current === source) sourceRef.current = null;
      return;
    }

    setStatus("waiting");
    sharedAudioEngine.playAll();

    // legacy 版本里有这个「5 秒无数据」检测，M2 移植时漏掉了，导致桌面端
    // 点了开始后音乐在放、界面却永远停在「等待手势…」。这里补回来。
    gotSampleRef.current = false;
    prevPulseRef.current = 0;
    if (noDataTimerRef.current) clearTimeout(noDataTimerRef.current);
    noDataTimerRef.current = setTimeout(() => {
      if (!gotSampleRef.current) setStatus("nodata");
    }, NO_DATA_TIMEOUT_MS);

    source.onIntent((intent) => {
      gotSampleRef.current = true;
      const params = mixIntent(intent);
      setStatus("active");
      setRoleActivation(params.roles);
      setDynamics(params.dynamics);
      setTempo(params.tempo);
      // 拍点 = beatPulse 的**上升沿**。它平时只会随时间指数衰减，唯一会变大的
      // 时刻就是解析器把它打回 1 的那一帧（gesture.ts / conductingModel.ts），
      // 所以严格大于就是「刚刚打了一拍」，不需要任何阈值。
      if (intent.beatPulse > prevPulseRef.current) setBeatCount((n) => n + 1);
      prevPulseRef.current = intent.beatPulse;
      applyToAudio(project, params);
    });
  };

  const stop = () => {
    // 先作废在飞的那次 start()，再收摊。顺序反了的话，它还能走完剩下的 await 起播。
    runIdRef.current++;
    if (noDataTimerRef.current) {
      clearTimeout(noDataTimerRef.current);
      noDataTimerRef.current = null;
    }
    sourceRef.current?.stop();
    sourceRef.current = null;
    sharedAudioEngine.stop();
    setRoleActivation({ melody: 0, harmony: 0, bass: 0, rhythm: 0 });
    setDynamics(0);
    setTempo(1);
    setStatus("idle");
  };

  return { status, roleActivation, dynamics, tempo, beatCount, start, stop };
}
