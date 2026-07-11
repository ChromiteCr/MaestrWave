import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { Button } from "../../components/Button/Button";
import { api, type Project } from "../../lib/api";
import { useAppStore } from "../../state/store";
import styles from "./FilePage.module.css";

// 调性交给「生成」页的高级面板去调，新建项目时先用默认值，避免和那边重复。
const DEFAULT_KEY = "D major";

export function FilePage() {
  const setProject = useAppStore((s) => s.setProject);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [styleDesc, setStyleDesc] = useState("Lush cinematic orchestral, heroic brass");
  const [bpm, setBpm] = useState(92);
  const [timeSig, setTimeSig] = useState("4/4");
  const [segDuration, setSegDuration] = useState(16);

  const loadProjects = async () => {
    setLoading(true);
    try {
      const { projects } = await api.listProjects();
      setProjects(projects);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const openProject = (project: Project) => {
    setProject(project);
    setActivePage("generate");
  };

  const handleCreate = async () => {
    if (!styleDesc.trim()) return;
    setCreating(true);
    try {
      const project = await api.createProject({
        style_description: styleDesc.trim(),
        key: DEFAULT_KEY,
        bpm,
        time_signature: timeSig,
        segment_duration: segDuration,
      });
      openProject(project);
    } catch (e) {
      console.error(e);
      alert("创建失败：" + (e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <PageHeader eyebrow="MaestrWave" title="文件" />
      <div className={styles.body}>
        <div className={styles.formCard}>
          <p className={styles.sectionTitle}>新建项目</p>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>风格描述</span>
            <textarea rows={3} value={styleDesc} onChange={(e) => setStyleDesc(e.target.value)} />
          </div>

          <div className={styles.row2}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>拍号</span>
              <select value={timeSig} onChange={(e) => setTimeSig(e.target.value)}>
                {["4/4", "3/4", "6/8", "2/4"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>BPM</span>
              <input type="number" min={40} max={200} value={bpm} onChange={(e) => setBpm(Number(e.target.value))} />
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>单段时长（秒）</span>
            <input type="number" min={4} max={60} value={segDuration} onChange={(e) => setSegDuration(Number(e.target.value))} />
          </div>

          <Button variant="primary" disabled={creating} onClick={handleCreate}>
            {creating ? "创建中…" : "创建项目"}
          </Button>
        </div>

        <div>
          <p className={styles.sectionTitle}>已有项目</p>
          {loading ? (
            <div className={styles.empty}>加载中…</div>
          ) : projects.length === 0 ? (
            <div className={styles.empty}>还没有项目，从左侧创建第一个。</div>
          ) : (
            <div className={styles.grid}>
              {projects.map((p) => (
                <div key={p.project_id} className={styles.card} onClick={() => openProject(p)}>
                  <h3 className={styles.cardTitle}>{p.name || p.project_id}</h3>
                  <p className={styles.cardDesc}>{p.style_description}</p>
                  <div className={styles.cardChips}>
                    <span className="mono-chip">{p.key}</span>
                    <span className="mono-chip">{p.bpm} bpm</span>
                    <span className="mono-chip">{p.time_signature}</span>
                  </div>
                  <div className={styles.cardFooter}>
                    <span className="label">{p.instruments.length} 件乐器</span>
                    <Button
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(api.exportProjectUrl(p.project_id), "_blank");
                      }}
                    >
                      导出
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
