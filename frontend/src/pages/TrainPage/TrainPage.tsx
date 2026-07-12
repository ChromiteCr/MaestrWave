import { useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { Button } from "../../components/Button/Button";
import styles from "./TrainPage.module.css";

export function TrainPage() {
  const [method, setMethod] = useState<"lora" | "lokr">("lokr");
  const [datasetPath, setDatasetPath] = useState("");
  const [epochs, setEpochs] = useState(500);
  const [batchSize, setBatchSize] = useState(1);

  return (
    <div>
      <PageHeader eyebrow="MaestrWave" title="训练" meta={<span className="mono-chip">{method.toUpperCase()}</span>} />

      <div className={styles.body}>
        <div className={styles.card}>
          <div className={styles.field}>
            <span className="field-label">数据集目录</span>
            <input
              value={datasetPath}
              onChange={(e) => setDatasetPath(e.target.value)}
              placeholder="song.mp3 + song.lyrics.txt + song.caption.txt …"
            />
          </div>

          <div className={styles.row2}>
            <div className={styles.field}>
              <span className="field-label">方法</span>
              <select value={method} onChange={(e) => setMethod(e.target.value as "lora" | "lokr")}>
                <option value="lokr">LoKr（推荐，更快）</option>
                <option value="lora">LoRA</option>
              </select>
            </div>
            <div className={styles.field}>
              <span className="field-label">Epochs</span>
              <input type="number" min={50} max={2000} value={epochs} onChange={(e) => setEpochs(Number(e.target.value))} />
            </div>
          </div>

          <div className={styles.field}>
            <span className="field-label">Batch Size</span>
            <input type="number" min={1} max={8} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} />
          </div>

          <Button variant="primary" disabled title="训练任务编排（M3）还未接入——需要先确认训练机器上用 Gradio LoRA Training 标签页还是 Side-Step CLI">
            开始训练
          </Button>
          <span className={styles.pendingNote}>训练任务编排还没接入（M3），这里先把参数面板和显存提示做好。</span>
        </div>

        <div className={styles.vramCard}>
          <span className={styles.vramCaption}>显存需求 · ACE-Step 1.5</span>
          <div>
            <div className={styles.vramFigure}>
              <span className={styles.vramNumber}>16</span>
              <span className={styles.vramUnit}>GB 起步</span>
            </div>
            <p className={styles.vramNote}>短曲目可跑；长曲目预处理阶段容易 OOM。</p>
          </div>
          <div>
            <div className={styles.vramFigure}>
              <span className={styles.vramNumber}>20+</span>
              <span className={styles.vramUnit}>GB 推荐</span>
            </div>
            <p className={styles.vramNote}>完整曲长稳定训练，实测常驻占用约 17GB。LoKr 比 LoRA 快一个数量级（约 5 分钟 vs 1 小时）。</p>
          </div>
        </div>
      </div>
    </div>
  );
}
