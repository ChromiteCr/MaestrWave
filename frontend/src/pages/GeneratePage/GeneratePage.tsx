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

  const [isPlaying, setIsPlaying] = useState(false);
  const [repaintOpen, setRepaintOpen] = useState(false);
  const [repaintPrompt, setRepaintPrompt] = useState("");
  const [repaintStart, setRepaintStart] = useState(0);
  const [repaintEnd, setRepaintEnd] = useState(4);

  useEffect(() => {
    loadInstrumentLibrary();
  }, [loadInstrumentLibrary]);

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
              <span className={styles.timeLabel}>
                {formatTime(take ? sharedAudioEngine.playheadSeconds(trackId) : 0)} / {formatTime(duration)}
              </span>
              <div className={styles.actions}>
                {take && (
                  <Button variant="ghost" disabled={isPending} onClick={() => setRepaintOpen((v) => !v)}>
                    Repaint
                  </Button>
                )}
                <Button variant="primary" disabled={isPending} onClick={handleGenerate}>
                  {isPending ? "生成中…" : take ? "重新生成" : "生成"}
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
