import { PAGE_SECTION, SECTION_HOME, useAppStore, type PageId, type Section } from "../../state/store";
import {
  BrowseIcon,
  FileIcon,
  FormationIcon,
  GenerateIcon,
  LessonIcon,
  OutputIcon,
  PerformIcon,
  SettingsIcon,
  TeachIcon,
  TrainIcon,
} from "../icons";
import { Logo } from "../Logo";
import styles from "./Sidebar.module.css";

type Icon = (props: { size?: number }) => JSX.Element;
type Item = { id: PageId; label: string; hint?: string; icon: Icon };

/** 一级：两条并列的路径，不是父子关系 —— 想学的进教学，想玩的进体验。 */
const SECTIONS: { id: Exclude<Section, "global">; label: string; hint: string; icon: Icon }[] = [
  { id: "teach", label: "指挥教学", hint: "从零学指挥", icon: TeachIcon },
  { id: "perform", label: "指挥体验", hint: "生成并指挥", icon: PerformIcon },
];

/** 二级：按各自一级下的实际流程顺序排。 */
const PAGES: Record<Exclude<Section, "global">, Item[]> = {
  teach: [{ id: "teach", label: "课程", icon: LessonIcon }],
  perform: [
    { id: "file", label: "文件", icon: FileIcon },
    { id: "formation", label: "构型", icon: FormationIcon },
    { id: "generate", label: "生成", icon: GenerateIcon },
    { id: "browse", label: "浏览", icon: BrowseIcon },
    { id: "output", label: "输出", icon: OutputIcon },
  ],
};

/** 不属于任何一级的工具页，固定在底部，切一级时不动。 */
const GLOBAL: Item[] = [
  { id: "train", label: "训练", icon: TrainIcon },
  { id: "settings", label: "设置", icon: SettingsIcon },
];

export function Sidebar() {
  const activePage = useAppStore((s) => s.activePage);
  const navSection = useAppStore((s) => s.navSection);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const renderItem = (item: Item) => (
    <button
      key={item.id}
      type="button"
      aria-current={activePage === item.id}
      className={`${styles.item} ${activePage === item.id ? styles.itemActive : ""}`}
      onClick={() => setActivePage(item.id)}
    >
      <item.icon />
      <span className={styles.itemLabel}>{item.label}</span>
    </button>
  );

  return (
    <nav className={styles.rail}>
      <div className={styles.brand}>
        <Logo size={26} />
        <span className={styles.brandName}>MaestrWave</span>
      </div>

      <div className={styles.group}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            // 停在训练/设置这种 global 页时，两个一级都不算「当前所在」，只保留 navSection 的展开态
            aria-current={PAGE_SECTION[activePage] === s.id}
            className={`${styles.section} ${navSection === s.id ? styles.sectionOpen : ""}`}
            onClick={() => setActivePage(SECTION_HOME[s.id])}
          >
            <s.icon />
            <span className={styles.sectionText}>
              <span className={styles.sectionLabel}>{s.label}</span>
              <span className={styles.sectionHint}>{s.hint}</span>
            </span>
          </button>
        ))}
      </div>

      <div className={styles.divider} />
      <div className={styles.group}>{PAGES[navSection].map(renderItem)}</div>

      <div className={styles.spacer} />
      <div className={styles.divider} />
      <div className={styles.group}>{GLOBAL.map(renderItem)}</div>
    </nav>
  );
}
