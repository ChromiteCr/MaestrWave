import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { InstrumentTabs } from "../../components/InstrumentTabs/InstrumentTabs";
import { PromptPanel } from "../../components/PromptPanel/PromptPanel";
import { Waveform } from "../../components/Waveform/Waveform";
import { PianoRoll } from "../../components/PianoRoll/PianoRoll";
import { Button } from "../../components/Button/Button";
import { PlayIcon, StopIcon } from "../../components/icons";
import { api, type FormationWarning, type Project, type ProjectScore } from "../../lib/api";
import { sharedAudioEngine } from "../../lib/audioEngine";
import { useInstrumentTrack } from "../../lib/useInstrumentTrack";
import { currentTake, findInstrument, useAppStore } from "../../state/store";
import styles from "./GeneratePage.module.css";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 见 backend/composer.py 与 backend/render.py。名字要和「设置」页那几个按钮一致。 */
const COMPOSER_NAMES: Record<string, string> = {
  llm: "大模型写谱",
  remote: "外部符号模型",
  algorithmic: "规则作曲",
};
const RENDERER_NAMES: Record<string, string> = {
  sf2: "内置采样音源",
  fluidsynth: "FluidSynth",
  builtin: "内置合成",
};

/** take.params 是 `Record<string, unknown>`，取字段时逐个收窄，不整包 as 掉。 */
function repairsOf(params: Record<string, unknown> | undefined): FormationWarning[] {
  const raw = params?.repairs;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (w): w is FormationWarning =>
      !!w && typeof (w as FormationWarning).message === "string",
  );
}

export function GeneratePage() {
  const project = useAppStore((s) => s.project);
  const setProject = useAppStore((s) => s.setProject);
  const refreshProject = useAppStore((s) => s.refreshProject);
  const selectedInstrumentId = useAppStore((s) => s.selectedInstrumentId);
  const setSelectedInstrumentId = useAppStore((s) => s.setSelectedInstrumentId);
  const library = useAppStore((s) => s.instrumentLibrary);
  const loadInstrumentLibrary = useAppStore((s) => s.loadInstrumentLibrary);
  const pendingInstruments = useAppStore((s) => s.pendingInstruments);
  const beginPending = useAppStore((s) => s.beginPending);
  const endPending = useAppStore((s) => s.endPending);
  const loraPath = useAppStore((s) => s.loraPath);
  const health = useAppStore((s) => s.health);
  const refreshHealth = useAppStore((s) => s.refreshHealth);

  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [repaintOpen, setRepaintOpen] = useState(false);
  const [repaintPrompt, setRepaintPrompt] = useState("");
  const [repaintStart, setRepaintStart] = useState(0);
  const [repaintEnd, setRepaintEnd] = useState(4);
  const [score, setScore] = useState<ProjectScore | null>(null);

  useEffect(() => {
    loadInstrumentLibrary();
    refreshHealth();
  }, [loadInstrumentLibrary, refreshHealth]);

  const isScoreMode = project?.generation_mode === "score";
  // 后端能力未知时默认按"支持"处理，避免健康检查还没回来就把按钮藏了。
  // `capabilities` 描述的是 ACE-Step 那条链路（天琴没有 repaint）；写谱模式重绘是
  // 后端自己按小节重写音符再整轨重渲染，和那个能力位无关，恒为可用。
  const repaintSupported = isScoreMode || (health?.capabilities ? health.capabilities.repaint : true);

  // 谱面跟着项目走：每次生成/重绘之后 project 会被 refreshProject 换掉，
  // 这里跟着重取一次，卷帘就不会停在上一版的音符上。
  const projectId = project?.project_id;
  const takeStamp = project?.instruments.map((i) => i.current_take_id ?? "-").join("|");
  useEffect(() => {
    if (!projectId || !isScoreMode) {
      setScore(null);
      return;
    }
    let alive = true;
    api
      .projectScore(projectId)
      .then((s) => alive && setScore(s))
      // 谱面只是「看得见」，取不到不该挡住生成本身
      .catch(() => alive && setScore(null));
    return () => {
      alive = false;
    };
  }, [projectId, isScoreMode, takeStamp]);

  useEffect(() => {
    setIsPlaying(false);
    sharedAudioEngine.stop();
  }, [selectedInstrumentId]);

  // 只驱动"时间"这行文字的刷新（波形播放头自己在 canvas 内部用 rAF 画，不受影响）。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, [isPlaying]);

  const instrument = findInstrument(project, selectedInstrumentId);
  const take = currentTake(instrument);
  const trackId = instrument?.id ?? "__none__";
  const { peaks, error: trackError, retry: retryTrack } = useInstrumentTrack(trackId, take, 0);
  const isPending = instrument ? pendingInstruments.has(instrument.id) : false;
  const duration = take ? sharedAudioEngine.duration(trackId) : project?.segment_duration ?? 0;

  // 写谱模式下这一轨有什么需要交代的：修过的音符、作曲降级、按旧蓝图写的、重绘范围。
  // 都从 take.params 读 —— 后端已经如实记在那里了（见 score_gen.py）。
  const scoreNotices: string[] = [];
  if (isScoreMode && take) {
    const p = take.params;
    const repairs = repairsOf(p);
    if (repairs.length) {
      scoreNotices.push(`${repairs.length} 处被修正：${repairs.map((r) => r.message).join("；")}`);
    }
    if (typeof p.fallback_reason === "string" && p.fallback_reason) {
      scoreNotices.push(`作曲退回了规则作曲：${p.fallback_reason}`);
    }
    const rev = p.blueprint_revision;
    const cur = score?.blueprint?.revision;
    if (typeof rev === "number" && typeof cur === "number" && rev < cur) {
      scoreNotices.push(`这一轨是按第 ${rev} 版蓝图写的，当前已是第 ${cur} 版，重新生成才会跟上。`);
    }
    const bars = p.repainted_bars;
    if (Array.isArray(bars) && bars.length === 2) {
      scoreNotices.push(`上次重绘实际改的是第 ${bars[0]}–${bars[1]} 小节（按小节边界向外吸附）。`);
    }
  }

  // 生成耗时正计时：云端生成动辄一两分钟，没有反馈的话用户会以为卡死了。
  useEffect(() => {
    if (!isPending) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(id);
  }, [isPending]);

  if (!project) {
    return (
      <div>
        <PageHeader eyebrow="MaestrWave" title="生成" />
        <div className={styles.emptyState}>先在「文件」页新建或打开一个项目。</div>
      </div>
    );
  }

  const commitProject = async (patch: Partial<Project>) => {
    const updated = await api.updateProject(project.project_id, patch);
    setProject(updated);
  };

  const handleAdd = async (libraryKey: string) => {
    const inst = await api.addInstrument(project.project_id, { library_key: libraryKey });
    await refreshProject();
    setSelectedInstrumentId(inst.id);
  };

  const handleClose = async (id: string) => {
    await api.removeInstrument(project.project_id, id);
    sharedAudioEngine.unload(id);
    await refreshProject();
    if (selectedInstrumentId === id) {
      const remaining = project.instruments.filter((i) => i.id !== id);
      setSelectedInstrumentId(remaining[0]?.id ?? null);
    }
  };

  const handleGenerate = async () => {
    if (!instrument) return;
    beginPending(instrument.id);
    try {
      await api.generateInstrument(project.project_id, instrument.id, loraPath);
      await refreshProject();
    } catch (e) {
      alert("生成失败：" + (e as Error).message);
    } finally {
      endPending(instrument.id);
    }
  };

  const handleRepaint = async () => {
    if (!instrument || !repaintPrompt.trim()) return;
    beginPending(instrument.id);
    try {
      await api.repaintInstrument(project.project_id, instrument.id, {
        prompt: repaintPrompt.trim(),
        start_time: repaintStart,
        end_time: repaintEnd,
        lora_path: loraPath,
      });
      await refreshProject();
      setRepaintOpen(false);
    } catch (e) {
      alert("Repaint 失败：" + (e as Error).message);
    } finally {
      endPending(instrument.id);
    }
  };

  const togglePlay = () => {
    if (!take) return;
    if (isPlaying) {
      sharedAudioEngine.stop();
      setIsPlaying(false);
    } else {
      sharedAudioEngine.playOne(trackId);
      setIsPlaying(true);
    }
  };

  return (
    <div>
      <PageHeader eyebrow={project.name || "MaestrWave"} title="生成" />

      <div className={styles.body}>
        <div className={styles.panelCard}>
          <PromptPanel project={project} onCommit={commitProject} />
        </div>

        {/* 当前用哪种方式生成——本机 ACE-Step 还是云端 API，直接摆在生成区里，
            省得用户去「设置」页确认。写谱模式走的是另一条链路（作曲器 + 采样器），
            那个后端就绪与否和这里毫无关系，所以整条换掉而不是并排显示。 */}
        {isScoreMode ? (
          <div className={styles.backendBar}>
            <span className={`${styles.backendDot} ${styles.backendOk}`} />
            <span className={styles.backendLabel}>写谱</span>
            <span className={styles.backendName}>
              {health?.score ? COMPOSER_NAMES[health.score.composer] : "检测中…"}
            </span>
            <span className={styles.backendLabel}>音源</span>
            <span className={styles.backendName}>
              {health?.score ? RENDERER_NAMES[health.score.renderer] : "检测中…"}
            </span>
          </div>
        ) : (
          <div className={styles.backendBar}>
            <span className={`${styles.backendDot} ${health?.generation_backend_ready ? styles.backendOk : styles.backendOff}`} />
            <span className={styles.backendLabel}>生成方式</span>
            <span className={styles.backendName}>{health?.capabilities?.display_name ?? "检测中…"}</span>
            {health && !health.generation_backend_ready && (
              <span className={styles.backendWarn}>
                {health.synth_fallback_enabled ? "未就绪，将回退到占位音频" : "未就绪"}
              </span>
            )}
          </div>
        )}

        <div className={styles.tabsCard}>
          <InstrumentTabs
            instruments={project.instruments}
            selectedId={selectedInstrumentId}
            pendingIds={pendingInstruments}
            library={library}
            onSelect={setSelectedInstrumentId}
            onAdd={handleAdd}
            onClose={handleClose}
          />
        </div>

        {instrument ? (
          <div className={styles.trackCard}>
            <Waveform
              peaks={peaks}
              state={isPending ? "pending" : take && !trackError ? "ready" : "empty"}
              isPlaying={isPlaying}
              getProgress={() => (duration ? sharedAudioEngine.playheadSeconds(trackId) / duration : 0)}
              onClick={take && !isPending ? togglePlay : undefined}
              height={140}
            />

            {/* 音轨加载失败得说出来。只写进控制台的话，波形会永远停在呼吸动画上，
                而那个动画的意思是「在加载」—— 用户只会一直等下去 */}
            {trackError && (
              <p className={styles.trackError}>
                这条音轨没加载出来（{trackError}）。
                <button type="button" className={styles.trackRetry} onClick={retryTrack}>
                  重试
                </button>
              </p>
            )}

            <div className={styles.transportRow}>
              <button className={styles.playBtn} disabled={!take || isPending} onClick={togglePlay}>
                {isPlaying ? <StopIcon /> : <PlayIcon />}
              </button>
              {isPending ? (
                <span className={styles.waving}>
                  <span className={styles.wavingText}>Waving…</span>
                  <span className={styles.wavingTimer}>{formatTime(elapsed)}</span>
                </span>
              ) : (
                <span className={styles.timeLabel}>
                  {formatTime(take ? sharedAudioEngine.playheadSeconds(trackId) : 0)} / {formatTime(duration)}
                </span>
              )}
              <div className={styles.actions}>
                {/* 谱子在后端，导出走链接而不是按钮：浏览器自己下载，不用先读进内存 */}
                {isScoreMode && score?.blueprint && (
                  <a className={styles.midiLink} href={api.scoreMidiUrl(project.project_id)} download>
                    导出 MIDI
                  </a>
                )}
                {/* 天琴等纯文生乐后端没有局部重绘能力，藏起来而不是让用户点了才报错 */}
                {take && repaintSupported && (
                  <Button variant="ghost" disabled={isPending} onClick={() => setRepaintOpen((v) => !v)}>
                    Repaint
                  </Button>
                )}
                <Button variant="primary" disabled={isPending} onClick={handleGenerate}>
                  {isPending ? `生成中 ${formatTime(elapsed)}` : take ? "重新生成" : "生成"}
                </Button>
              </div>
            </div>

            {isScoreMode && (
              <div className={styles.scoreBlock}>
                <div className={styles.scoreHead}>
                  <span className="eyebrow">谱面</span>
                  <span className={styles.scoreLegend}>
                    <span className={styles.legendMine} />
                    {instrument.display_name}
                    <span className={styles.legendOther} />
                    其它声部
                  </span>
                  {score?.blueprint && (
                    <span className={styles.scoreMeta}>
                      {score.blueprint.bars} 小节 · {score.blueprint.key} · {score.blueprint.time_signature} ·{" "}
                      {score.blueprint.bpm} BPM
                    </span>
                  )}
                </div>

                <PianoRoll
                  score={score}
                  instrumentId={instrument.id}
                  isPlaying={isPlaying}
                  getProgress={() => (duration ? sharedAudioEngine.playheadSeconds(trackId) / duration : 0)}
                />

                {/* 修了什么要说出来，不能悄悄改掉：模型写越界了、写重叠了，
                    用户有权知道听到的和模型给的不是同一份 */}
                {scoreNotices.map((n) => (
                  <p key={n} className={styles.scoreNotice}>
                    {n}
                  </p>
                ))}
              </div>
            )}

            {repaintOpen && take && (
              <div className={styles.repaintForm}>
                <div className={styles.repaintRow}>
                  <div className={styles.field}>
                    <span className="field-label">Repaint 描述</span>
                    <input value={repaintPrompt} onChange={(e) => setRepaintPrompt(e.target.value)} placeholder="更明亮的起音、更清晰的力度…" />
                  </div>
                  <div className={styles.field}>
                    <span className="field-label">起始秒</span>
                    <input type="number" min={0} value={repaintStart} onChange={(e) => setRepaintStart(Number(e.target.value))} />
                  </div>
                  <div className={styles.field}>
                    <span className="field-label">结束秒</span>
                    <input type="number" min={0} value={repaintEnd} onChange={(e) => setRepaintEnd(Number(e.target.value))} />
                  </div>
                  <Button variant="primary" disabled={isPending} onClick={handleRepaint}>
                    执行
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.emptyState}>从上方添加一件乐器开始。</div>
        )}
      </div>
    </div>
  );
}
