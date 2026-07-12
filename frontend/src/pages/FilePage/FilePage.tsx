import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { Button } from "../../components/Button/Button";
import { api, type Project } from "../../lib/api";
import { useAppStore } from "../../state/store";
import styles from "./FilePage.module.css";

// 新建项目只问"叫什么、多长"；风格描述/调性/拍号/BPM 都交给「生成」页去调，
// 这里用合理的默认值创建，避免和那边的表单重复。
const DEFAULT_KEY = "D major";
const DEFAULT_BPM = 92;
const DEFAULT_TIME_SIGNATURE = "4/4";

export function FilePage() {
  const setProject = useAppStore((s) => s.setProject);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState("");
  const [totalDuration, setTotalDuration] = useState(16);

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
    setCreating(true);
    try {
      const project = await api.createProject({
        name: name.trim(),
        style_description: "",
        key: DEFAULT_KEY,
        bpm: DEFAULT_BPM,
        time_signature: DEFAULT_TIME_SIGNATURE,
        segment_duration: totalDuration,
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
            <span className="field-label">项目名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：英雄的凯旋" />
          </div>

          <div className={styles.field}>
            <span className="field-label">乐曲总时长（秒）</span>
            <input
              type="number"
              min={4}
              max={120}
              value={totalDuration}
              onChange={(e) => setTotalDuration(Number(e.target.value))}
            />
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
                  <p className={styles.cardDesc}>{p.style_description || "还没有风格描述"}</p>
                  <div className={styles.cardChips}>
                    <span className="mono-chip">{p.segment_duration}s</span>
                    <span className="mono-chip">{p.key}</span>
                    <span className="mono-chip">{p.bpm} bpm</span>
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
