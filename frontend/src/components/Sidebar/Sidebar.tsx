import { PAGE_SECTION, SECTION_HOME, useAppStore, type PageId, type Section } from "../../state/store";
import {
  BrowseIcon,
  ExamIcon,
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
/** `also` 是「停在这些页面时本项也算选中」—— 课程详情页没有自己的侧栏入口。 */
type Item = { id: PageId; label: string; icon: Icon; also?: PageId[] };

/** 一级：两条并列的路径，不是父子关系 —— 想学的进教学，想玩的进体验。 */
const SECTIONS: { id: Exclude<Section, "global">; label: string; hint: string; icon: Icon }[] = [
  { id: "teach", label: "指挥教学", hint: "从零学指挥", icon: TeachIcon },
  { id: "perform", label: "指挥体验", hint: "生成并指挥", icon: PerformIcon },
];

/** 二级：按各自一级下的实际流程顺序排。 */
const PAGES: Record<Exclude<Section, "global">, Item[]> = {
  teach: [
    { id: "teach", label: "课程", icon: LessonIcon, also: ["teach-lesson"] },
    { id: "teach-exam", label: "考试", icon: ExamIcon },
  ],
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

  /**
   * 首页什么都不选中。
   *
   * `navSection` 一直记着上次展开的那一级（这是对的：从「输出」点「设置」再看侧栏，
   * 二级列表还应该是指挥体验那五项，否则回不去）。但首页在两条路径**之上** ——
   * 一进来就把「指挥体验」描上高亮，等于告诉用户他已经在那条路上了，而他还什么
   * 都没选。二级列表跟着一起收起来：一列没有归属的子项比高亮本身更让人犯嘀咕。
   */
  const onHome = activePage === "home";

  const renderItem = (item: Item) => {
    const on = activePage === item.id || (item.also?.includes(activePage) ?? false);
    return (
      <button
        key={item.id}
        type="button"
        aria-current={on}
        className={`${styles.item} ${on ? styles.itemActive : ""}`}
        onClick={() => setActivePage(item.id)}
      >
        <item.icon />
        <span className={styles.itemLabel}>{item.label}</span>
      </button>
    );
  };

  return (
    <nav className={styles.rail}>
      {/*
        品牌区就是回首页的入口 —— 点 logo 回首页是通用约定，比在侧栏里多加一行
        「首页」更省地方，也不会让两条一级路径变成三条。
      */}
      <button
        type="button"
        className={`${styles.brand} ${activePage === "home" ? styles.brandActive : ""}`}
        aria-current={activePage === "home"}
        title="回到首页"
        onClick={() => setActivePage("home")}
      >
        <Logo size={26} />
        <span className={styles.brandName}>MaestrWave</span>
      </button>

      <div className={styles.group}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            // 停在训练/设置这种 global 页时，两个一级都不算「当前所在」，只保留 navSection 的展开态
            aria-current={PAGE_SECTION[activePage] === s.id}
            className={`${styles.section} ${!onHome && navSection === s.id ? styles.sectionOpen : ""}`}
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

      {!onHome && (
        <>
          <div className={styles.divider} />
          <div className={styles.group}>{PAGES[navSection].map(renderItem)}</div>
        </>
      )}

      <div className={styles.spacer} />
      <div className={styles.divider} />
      <div className={styles.group}>{GLOBAL.map(renderItem)}</div>
    </nav>
  );
}
