import { useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { Waveform } from "../../components/Waveform/Waveform";
import { Button } from "../../components/Button/Button";
import { PlayIcon, StopIcon } from "../../components/icons";
import type { Instrument } from "../../lib/api";
import { sharedAudioEngine } from "../../lib/audioEngine";
import { useInstrumentTrack } from "../../lib/useInstrumentTrack";
import { currentTake, useAppStore } from "../../state/store";
import styles from "./BrowsePage.module.css";

type PlayingMode = "all" | string | null;

function InstrumentRow({ instrument, playing, onToggleSolo, onEdit }: {
  instrument: Instrument;
  playing: PlayingMode;
  onToggleSolo: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const take = currentTake(instrument);
  const { peaks } = useInstrumentTrack(instrument.id, take, 0);
  const isPlayingThis = playing === instrument.id || playing === "all";

  return (
    <div className={styles.row}>
      <div className={styles.rowInfo}>
        <span className={styles.rowTitle}>{instrument.display_name}</span>
        <span className={styles.rowRole}>{instrument.role}</span>
      </div>

      <Waveform
        peaks={peaks}
        state={take ? "ready" : "empty"}
        isPlaying={isPlayingThis}
        height={48}
        getProgress={() => {
          const dur = sharedAudioEngine.duration(instrument.id);
          return dur ? sharedAudioEngine.playheadSeconds(instrument.id) / dur : 0;
        }}
        onClick={take ? () => onToggleSolo(instrument.id) : undefined}
      />

      <div className={styles.rowActions}>
        <button
          className={`${styles.playDot} ${isPlayingThis ? styles.playDotActive : ""}`}
          disabled={!take}
          onClick={() => onToggleSolo(instrument.id)}
          title="单独试听"
        >
          {isPlayingThis ? <StopIcon size={14} /> : <PlayIcon size={14} />}
        </button>
        <Button variant="ghost" onClick={() => onEdit(instrument.id)}>
          编辑
        </Button>
      </div>
    </div>
  );
}

export function BrowsePage() {
  const project = useAppStore((s) => s.project);
  const setSelectedInstrumentId = useAppStore((s) => s.setSelectedInstrumentId);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const [playing, setPlaying] = useState<PlayingMode>(null);

  if (!project) {
    return (
      <div>
        <PageHeader eyebrow="MaestrWave" title="浏览" />
        <div className={styles.emptyState}>先在「文件」页新建或打开一个项目。</div>
      </div>
    );
  }

  const playableCount = project.instruments.filter((i) => i.current_take_id).length;

  const toggleAll = () => {
    if (playing === "all") {
      sharedAudioEngine.stop();
      setPlaying(null);
    } else {
      sharedAudioEngine.playAll();
      setPlaying("all");
    }
  };

  const toggleSolo = (id: string) => {
    if (playing === id) {
      sharedAudioEngine.stop();
      setPlaying(null);
    } else {
      sharedAudioEngine.playOne(id);
      setPlaying(id);
    }
  };

  const editInstrument = (id: string) => {
    setSelectedInstrumentId(id);
    setActivePage("generate");
  };

  return (
    <div>
      <PageHeader
        eyebrow={project.name || "浏览"}
        title="浏览"
        meta={<span className="mono-chip">{project.instruments.length} 件乐器</span>}
        actions={
          <Button variant="primary" disabled={playableCount === 0} onClick={toggleAll}>
            {playing === "all" ? <StopIcon /> : <PlayIcon />}
            {playing === "all" ? "停止" : "播放全部"}
          </Button>
        }
      />
      <div className={styles.body}>
        {project.instruments.length === 0 ? (
          <div className={styles.emptyState}>项目里还没有乐器，去「生成」页添加一个。</div>
        ) : (
          project.instruments.map((inst) => (
            <InstrumentRow key={inst.id} instrument={inst} playing={playing} onToggleSolo={toggleSolo} onEdit={editInstrument} />
          ))
        )}
      </div>
    </div>
  );
}
