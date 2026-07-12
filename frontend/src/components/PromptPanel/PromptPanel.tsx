import { useState } from "react";
import type { Project } from "../../lib/api";
import styles from "./PromptPanel.module.css";

interface PromptPanelProps {
  project: Project;
  onCommit: (patch: Partial<Project>) => void;
}

const KEY_OPTIONS = ["C", "G", "D", "A", "E", "F", "Bb", "Eb"].flatMap((k) => [`${k} major`, `${k} minor`]);

export function PromptPanel({ project, onCommit }: PromptPanelProps) {
  const [mode, setMode] = useState<"basic" | "advanced">("basic");
  const [desc, setDesc] = useState(project.style_description);

  return (
    <div className={styles.panel}>
      <div className={styles.toggleRow}>
        <div className={styles.toggle}>
          <button type="button" className={`${styles.toggleBtn} ${mode === "basic" ? styles.toggleActive : ""}`} onClick={() => setMode("basic")}>
            基础
          </button>
          <button type="button" className={`${styles.toggleBtn} ${mode === "advanced" ? styles.toggleActive : ""}`} onClick={() => setMode("advanced")}>
            高级
          </button>
        </div>
      </div>

      <textarea
        rows={2}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={() => desc !== project.style_description && onCommit({ style_description: desc })}
      />

      {mode === "advanced" && (
        <div className={styles.advancedRow}>
          <div className={styles.field}>
            <span className="field-label">调性</span>
            <select value={project.key} onChange={(e) => onCommit({ key: e.target.value })}>
              {KEY_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <span className="field-label">拍号</span>
            <select value={project.time_signature} onChange={(e) => onCommit({ time_signature: e.target.value })}>
              {["4/4", "3/4", "6/8", "2/4"].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <span className="field-label">BPM</span>
            <input
              type="number"
              min={40}
              max={200}
              defaultValue={project.bpm}
              onBlur={(e) => onCommit({ bpm: Number(e.target.value) })}
            />
          </div>
          <div className={styles.field}>
            <span className="field-label">乐曲总时长（秒）</span>
            <input
              type="number"
              min={4}
              max={60}
              defaultValue={project.segment_duration}
              onBlur={(e) => onCommit({ segment_duration: Number(e.target.value) })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
