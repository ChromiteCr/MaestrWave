import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { Button } from "../../components/Button/Button";
import { api, type GenerationMode, type Project, type RepertoireItem } from "../../lib/api";
import { useAppStore } from "../../state/store";
import styles from "./FilePage.module.css";

// 新建项目只问"叫什么、多长、怎么生成"；风格描述/调性/拍号/BPM 都交给「生成」
// 页去调，这里用合理的默认值创建，避免和那边的表单重复。
const DEFAULT_KEY = "D major";
const DEFAULT_BPM = 92;
const DEFAULT_TIME_SIGNATURE = "4/4";

/**
 * 生成方式是**建项目时就定死的**，之后不能改 —— 三种模式的产物结构不一样
 * （模式二有 master + stems，模式三有乐谱），中途换等于把已生成的东西全作废。
 */
const MODES: { id: GenerationMode; label: string; hint: string }[] = [
  {
    id: "multitrack",
    label: "分轨生成",
    hint: "每件乐器单独调音乐模型生成一条音轨。音色真实，但各声部只能靠调性和速度对齐。",
  },
  {
    id: "score",
    label: "写谱演奏",
    hint: "AI 先写出每件乐器的谱子，再由采样器演奏。速度和拍点精确，声部之间真正配合；音色取决于音源。",
  },
];

export function FilePage() {
  const setProject = useAppStore((s) => s.setProject);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // 随程序附带的真实曲目。和「已有项目」并列摆，卡片样式一样 —— 对用户来说
  // 两者都是「可以打开来指挥的东西」，没必要让他先理解「这是内置的那是我的」。
  const [repertoire, setRepertoire] = useState<RepertoireItem[]>([]);
  const [importing, setImporting] = useState("");

  const [name, setName] = useState("");
  const [totalDuration, setTotalDuration] = useState(16);
  const [mode, setMode] = useState<GenerationMode>("multitrack");
  const health = useAppStore((s) => s.health);
  const refreshHealth = useAppStore((s) => s.refreshHealth);

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
    refreshHealth();
    // 曲目清单拿不到不算错：后端版本旧一点就没这个端点，页面其余部分照常用
    api.repertoireList().then((r) => setRepertoire(r.items)).catch(() => setRepertoire([]));
  }, [refreshHealth]);

  /**
   * 打开一首内置曲目：后端把 MIDI 逐轨渲染成 take，造出一个正常的项目。
   *
   * 首次要等十几秒到一分多钟（取决于渲染器），之后这个项目就存在了，
   * 和自己建的项目没有区别 —— 所以这里造完直接进「生成」页，不做特殊对待。
   */
  const openRepertoire = async (item: RepertoireItem) => {
    if (importing) return;
    setImporting(item.id);
    try {
      const { project } = await api.repertoireProject(item.id);
      await loadProjects();
      openProject(project);
    } catch (e) {
      console.error(e);
      alert(`打开《${item.title}》失败：` + (e as Error).message);
    } finally {
      setImporting("");
    }
  };

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
        generation_mode: mode,
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

          {/* 生成方式建完就锁死，所以放在这里而不是「生成」页 */}
          <div className={styles.field}>
            <span className="field-label">生成方式</span>
            <div className={styles.modes}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`${styles.mode} ${mode === m.id ? styles.modeActive : ""}`}
                  aria-pressed={mode === m.id}
                  onClick={() => setMode(m.id)}
                >
                  <span className={styles.modeLabel}>{m.label}</span>
                  <span className={styles.modeHint}>{m.hint}</span>
                </button>
              ))}
            </div>
            {mode === "score" && health?.score && (
              <p className={styles.modeNote}>
                当前会用
                <strong>
                  {health.score.composer === "llm" ? "语言模型" :
                    health.score.composer === "remote" ? "外部符号模型" : "内置规则"}
                </strong>
                作曲、
                <strong>{health.score.renderer === "fluidsynth" ? "采样音源" : "内置合成"}</strong>
                演奏。
                {health.score.renderer !== "fluidsynth" && (
                  <> 装上 fluidsynth 并把 SoundFont 放进 {health.score.soundfont_dir} 可换成采样音源。</>
                )}
              </p>
            )}
          </div>

          <Button variant="primary" disabled={creating} onClick={handleCreate}>
            {creating ? "创建中…" : "创建项目"}
          </Button>
        </div>

        <div>
          {repertoire.length > 0 && (
            <>
              <p className={styles.sectionTitle}>内置曲目</p>
              <p className={styles.sectionHint}>
                随程序附带的真实交响乐作品，公有领域。点开会把每个声部渲染成独立音轨，
                之后和你自己建的项目完全一样 —— 一样能改配器、一样能用身体指挥。
              </p>
              <div className={styles.grid}>
                {repertoire.map((item) => (
                  <div
                    key={item.id}
                    className={`${styles.card} ${importing === item.id ? styles.cardBusy : ""}`}
                    onClick={() => openRepertoire(item)}
                  >
                    <h3 className={styles.cardTitle}>{item.title}</h3>
                    <p className={styles.cardDesc}>{item.blurb}</p>
                    <div className={styles.cardChips}>
                      <span className="mono-chip">{item.composer}</span>
                      <span className="mono-chip">{item.license}</span>
                      {!item.ready && <span className="mono-chip">首次要渲染</span>}
                    </div>
                    <div className={styles.cardFooter}>
                      <span className="label">
                        {importing === item.id ? "正在渲染各声部…" : "点开即可指挥"}
                      </span>
                      <Button
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(api.repertoireSourceUrl(item.id), "_blank");
                        }}
                      >
                        原始 MIDI
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <p className={styles.sectionTitle} style={{ marginTop: repertoire.length ? 30 : 0 }}>
            已有项目
          </p>
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
