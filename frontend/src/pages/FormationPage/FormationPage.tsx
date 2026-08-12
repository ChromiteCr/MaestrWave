import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../components/PageHeader/PageHeader";
import { Button } from "../../components/Button/Button";
import { EmotionChart } from "../../components/EmotionChart/EmotionChart";
import { api, type FormationTemplate, type MusicFormation, type InstrumentRole } from "../../lib/api";
import { climaxWindow, rescaleSections, sectionStarts, totalDuration } from "../../lib/formation";
import { useAppStore } from "../../state/store";
import styles from "./FormationPage.module.css";

/**
 * 「构型」页：在「生成」页之前确定乐曲的全局属性与情绪曲线。
 *
 * 交互范式是**骨架 → 一次成型 → 局部重问**，明确不做多轮对话。多轮对话有个致命问题：
 * 用户在柱状图上拖过、删过乐器，对话历史里没有这件事，下一轮模型基于旧上下文回答会
 * 无声覆盖用户的修改。这里的自然语言输入框是**单次无状态改写** —— 每次都把当前完整
 * 构型送进去、返回新构型，没有历史就没有双真源。
 *
 * 页面定位是「编辑器为主，AI 是编辑器顶部的一个加速器」，而不是「AI 向导，编辑器负责
 * 善后」。没配 key 时模版、段落编辑、拖拽、乐器增删全部照常可用。
 */

const ROLE_LABEL: Record<InstrumentRole, string> = {
  melody: "主旋律", harmony: "和声", bass: "低音", rhythm: "节奏",
};
const TIER_LABEL: Record<string, string> = {
  core: "贯穿", climax: "高潮", accent: "点缀",
};

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function FormationPage() {
  const project = useAppStore((s) => s.project);
  const setProject = useAppStore((s) => s.setProject);
  const refreshProject = useAppStore((s) => s.refreshProject);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const [templates, setTemplates] = useState<FormationTemplate[]>([]);
  const [formation, setFormation] = useState<MusicFormation | null>(null);
  const [llmReady, setLlmReady] = useState(false);
  const [tunnelRunning, setTunnelRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  // 骨架表单
  const [style, setStyle] = useState("");
  const [moods, setMoods] = useState("");
  const [ensemble, setEnsemble] = useState("orchestral");
  const [climaxHint, setClimaxHint] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [refineText, setRefineText] = useState("");

  useEffect(() => {
    api.formationTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
    api.llmConfig()
      .then((s) => { setLlmReady(s.ready); setTunnelRunning(!!s.tunnel_running); })
      .catch(() => setLlmReady(false));
  }, []);

  useEffect(() => {
    setFormation(project?.formation ?? null);
    setStyle(project?.style_description ?? "");
  }, [project?.project_id]);

  const total = project ? totalDuration(project) : 0;
  const starts = useMemo(() => sectionStarts(formation?.sections ?? []), [formation]);
  const climax = useMemo(
    () => (formation ? climaxWindow(formation.sections) : null),
    [formation],
  );

  if (!project) {
    return (
      <>
        <PageHeader eyebrow="MAESTRWAVE" title="构型" />
        <div className={styles.body}>
          <p className={styles.empty}>先在「文件」页打开一个项目。</p>
        </div>
      </>
    );
  }

  const token = localStorage.getItem("mw_llm_token") || undefined;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const useTemplate = (id: string) =>
    run("模版", async () => {
      setTemplateId(id);
      const fm = await api.applyFormationTemplate(project.project_id, id);
      setFormation(fm);
      await refreshProject();
    });

  const generate = () =>
    run("AI", async () => {
      const fm = await api.generateFormation(project.project_id, {
        style_description: style || undefined,
        mood_tags: moods ? moods.split(/[、,，\s]+/).filter(Boolean) : undefined,
        ensemble_size: ensemble,
        climax_hint: climaxHint || undefined,
        template_id: templateId || undefined,
      }, token);
      setFormation(fm);
      await refreshProject();
    });

  const refine = () =>
    run("局部重问", async () => {
      const scope = selected != null && formation ? `section:${formation.sections[selected].id}` : undefined;
      const fm = await api.refineFormation(project.project_id, refineText, scope, token);
      setFormation(fm);
      setRefineText("");
      await refreshProject();
    });

  const persist = (next: MusicFormation) => {
    setFormation(next);
    api.saveFormation(project.project_id, next).catch(() => {});
  };

  const onIntensity = (idx: number, v: number) => {
    if (!formation) return;
    const sections = formation.sections.map((s, i) => (i === idx ? { ...s, intensity: v } : s));
    setFormation({ ...formation, sections, dirty: true });
  };

  const onBoundary = (idx: number, seconds: number) => {
    if (!formation) return;
    const sections = formation.sections.map((s) => ({ ...s }));
    const prevEnd = starts[idx - 1];
    const nextEnd = starts[idx] + sections[idx].duration;
    const clamped = Math.max(prevEnd + 0.5, Math.min(nextEnd - 0.5, seconds));
    sections[idx - 1].duration = clamped - prevEnd;
    sections[idx].duration = nextEnd - clamped;
    setFormation({ ...formation, sections, dirty: true });
  };

  const toggleClimax = (idx: number) => {
    if (!formation) return;
    const sections = formation.sections.map((s, i) =>
      i === idx ? { ...s, is_climax: !s.is_climax } : s,
    );
    persist({ ...formation, sections, dirty: true });
  };

  const applyToGenerate = () =>
    run("应用", async () => {
      if (formation) await api.saveFormation(project.project_id, formation);
      const r = await api.applyFormation(project.project_id);
      setProject(r.project);
      setApplied(
        `已创建 ${r.created} 个乐器 tab` +
        (r.unmatched.length ? `，另有 ${r.unmatched.length} 件不在构型里（未删除）` : ""),
      );
      setActivePage("generate");
    });

  return (
    <>
      <PageHeader eyebrow="MAESTRWAVE" title="构型" meta={`${fmt(total)} · ${project.name}`} />
      <div className={styles.body}>

        {/* ---- AI 加速器（可选）---- */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>用 AI 生成构型</h2>
            {!llmReady && (
              <button className={styles.link} onClick={() => setActivePage("settings")}>
                还没配置语言模型 · 去设置
              </button>
            )}
          </div>
          <p className={styles.lead}>
            管弦乐编配是专业知识，这一步让语言模型把你的意图翻译成段落结构与乐器编配。
            <strong>没配也没关系</strong> 。下面的模版和编辑器不需要联网。
          </p>

          <label className={styles.field}>
            <span>想要什么感觉</span>
            <textarea rows={2} value={style} onChange={(e) => setStyle(e.target.value)}
              placeholder="例如：庄严悲壮的电影配乐，铜管在后段爆发" />
          </label>
          <div className={styles.grid3}>
            <label className={styles.field}>
              <span>情绪关键词</span>
              <input value={moods} onChange={(e) => setMoods(e.target.value)} placeholder="庄严、希望" />
            </label>
            <label className={styles.field}>
              <span>编制规模</span>
              <select value={ensemble} onChange={(e) => setEnsemble(e.target.value)}>
                <option value="solo">独奏</option>
                <option value="chamber">室内乐</option>
                <option value="orchestral">管弦乐</option>
                <option value="cinematic">电影配乐</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>高潮位置</span>
              <select value={climaxHint} onChange={(e) => setClimaxHint(e.target.value)}>
                <option value="">不指定</option>
                <option value="前段">前段</option>
                <option value="中段">中段</option>
                <option value="后段">后段</option>
                <option value="没有明显高潮">没有明显高潮</option>
              </select>
            </label>
          </div>
          <div className={styles.actions}>
            <Button variant="primary" onClick={generate} disabled={!llmReady || !!busy}>
              {busy === "AI" ? "生成中…" : "生成构型"}
            </Button>
            {tunnelRunning && (
              <span className={styles.warn}>隧道运行中，调用需要本机令牌（在「设置」页填）</span>
            )}
          </div>
        </section>

        {/* ---- 模版（保底路径）---- */}
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>从模版开始</h2>
          <p className={styles.lead}>模版存的是比例不是秒数，同一个模版对 16 秒和 4 分钟都适用。</p>
          <div className={styles.templates}>
            {templates.map((t) => (
              <button key={t.id} onClick={() => useTemplate(t.id)} disabled={!!busy}
                className={`${styles.template} ${templateId === t.id ? styles.templateActive : ""}`}>
                <strong>{t.name}</strong>
                <span className={styles.templateMeta}>
                  {t.key} · {t.bpm}bpm · {t.time_signature} · {t.instrument_count} 件
                  {t.has_climax ? "" : " · 无高潮"}
                </span>
                <span className={styles.templateDesc}>{t.description}</span>
              </button>
            ))}
          </div>
        </section>

        {error && <div className={styles.error}>{error}</div>}
        {applied && <div className={styles.ok}>{applied}</div>}

        {formation && (
          <>
            {/* ---- 情绪柱状图 ---- */}
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle}>乐曲情绪</h2>
                <span className={styles.meta}>
                  {climax ? `高潮 ${fmt(climax.start)} – ${fmt(climax.end)}` : "没有标记高潮"}
                </span>
              </div>
              <EmotionChart
                sections={formation.sections}
                bpm={formation.global.bpm}
                timeSignature={formation.global.time_signature}
                selectedSection={selected}
                onSelectSection={setSelected}
                onIntensityChange={onIntensity}
                onBoundaryChange={onBoundary}
              />
              {formation.warnings.length > 0 && (
                <ul className={styles.warnings}>
                  {formation.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
                </ul>
              )}
            </section>

            {/* ---- 段落 ---- */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>段落</h2>
              <table className={styles.table}>
                <thead>
                  <tr><th>段落</th><th>起止</th><th>强度</th><th>走向</th><th>高潮</th></tr>
                </thead>
                <tbody>
                  {formation.sections.map((s, i) => (
                    <tr key={s.id} className={selected === i ? styles.rowSel : ""}
                        onClick={() => setSelected(i)}>
                      <td>{s.label}</td>
                      <td className={styles.mono}>{fmt(starts[i])} – {fmt(starts[i] + s.duration)}</td>
                      <td className={styles.mono}>{s.intensity.toFixed(2)}</td>
                      <td>{s.shape}</td>
                      <td>
                        <button className={styles.toggle} onClick={(e) => { e.stopPropagation(); toggleClimax(i); }}>
                          {s.is_climax ? "是" : "—"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* ---- 编配 ---- */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>编配</h2>
              <p className={styles.lead}>
                参与度决定每件乐器在各段落的音量占比。0 表示该段不出声。这会在指挥时以增益包络的形式真正生效。
              </p>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>乐器</th><th>声部</th><th>定位</th>
                    {formation.sections.map((s) => <th key={s.id} className={styles.num}>{s.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {formation.instruments.map((inst) => (
                    <tr key={inst.id}>
                      <td>
                        {inst.display_name}
                        {inst.resolution?.matched === "custom" && <span className={styles.tag}>自定义</span>}
                      </td>
                      <td>{ROLE_LABEL[inst.role]}</td>
                      <td>{TIER_LABEL[inst.tier] ?? inst.tier}</td>
                      {inst.participation.map((w, i) => (
                        <td key={i} className={styles.num}>
                          <span className={w <= 0.05 ? styles.mute : ""}>{w.toFixed(2)}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* ---- 局部重问 ---- */}
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>让 AI 改一处</h2>
              <p className={styles.lead}>
                {selected != null
                  ? `只会改动「${formation.sections[selected].label}」这一段，其余保持不变。`
                  : "没有选中段落时会整体改写。点上面的柱子或表格行可以先选一段。"}
              </p>
              <div className={styles.refineRow}>
                <input value={refineText} onChange={(e) => setRefineText(e.target.value)}
                  placeholder="例如：高潮再猛一点 / 去掉打击乐 / 换成更悲的" />
                <Button onClick={refine} disabled={!llmReady || !refineText.trim() || !!busy}>
                  {busy === "局部重问" ? "改写中…" : "改写"}
                </Button>
              </div>
            </section>

            <div className={styles.footer}>
              <Button variant="primary" onClick={applyToGenerate} disabled={!!busy}>
                {busy === "应用" ? "应用中…" : "应用到生成页"}
              </Button>
              <span className={styles.meta}>
                会写回调性/拍号/BPM/总时长与全局提示词，并按构型创建乐器 tab
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
