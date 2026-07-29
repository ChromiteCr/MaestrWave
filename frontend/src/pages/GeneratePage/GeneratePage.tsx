import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { InstrumentTabs } from "../../components/InstrumentTabs/InstrumentTabs";
import { PromptPanel } from "../../components/PromptPanel/PromptPanel";
import { Waveform } from "../../components/Waveform/Waveform";
import { Button } from "../../components/Button/Button";
import { PlayIcon, StopIcon } from "../../components/icons";
import { api, type Project } from "../../lib/api";
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

  useEffect(() => {
    loadInstrumentLibrary();
    refreshHealth();
  }, [loadInstrumentLibrary, refreshHealth]);

  // 后端能力未知时默认按"支持"处理，避免健康检查还没回来就把按钮藏了
  const repaintSupported = health?.capabilities ? health.capabilities.repaint : true;

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
  const { peaks } = useInstrumentTrack(trackId, take, 0);
  const isPending = instrument ? pendingInstruments.has(instrument.id) : false;
  const duration = take ? sharedAudioEngine.duration(trackId) : project?.segment_duration ?? 0;

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
            省得用户去「设置」页确认 */}
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
              state={isPending ? "pending" : take ? "ready" : "empty"}
              isPlaying={isPlaying}
              getProgress={() => (duration ? sharedAudioEngine.playheadSeconds(trackId) / duration : 0)}
              onClick={take && !isPending ? togglePlay : undefined}
              height={140}
            />

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
