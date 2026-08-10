import { useAppStore, type PageId } from "../../state/store";
import { BrowseIcon, FileIcon, FormationIcon, GenerateIcon, OutputIcon, SettingsIcon, TrainIcon } from "../icons";
import { Logo } from "../Logo";
import styles from "./Sidebar.module.css";

const TOP: { id: PageId; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { id: "file", label: "文件", icon: FileIcon },
  { id: "formation", label: "构型", icon: FormationIcon },
  { id: "generate", label: "生成", icon: GenerateIcon },
  { id: "browse", label: "浏览", icon: BrowseIcon },
  { id: "output", label: "输出", icon: OutputIcon },
];

const BOTTOM: { id: PageId; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { id: "train", label: "训练", icon: TrainIcon },
  { id: "settings", label: "设置", icon: SettingsIcon },
];

export function Sidebar() {
  const activePage = useAppStore((s) => s.activePage);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const renderItem = (item: (typeof TOP)[number]) => (
    <button
      key={item.id}
      type="button"
      title={item.label}
      aria-label={item.label}
      aria-current={activePage === item.id}
      className={`${styles.item} ${activePage === item.id ? styles.itemActive : ""}`}
      onClick={() => setActivePage(item.id)}
    >
      <item.icon />
    </button>
  );

  return (
    <nav className={styles.rail}>
      <div className={styles.mark} title="MaestrWave">
        <Logo />
      </div>
      <div className={styles.group}>{TOP.map(renderItem)}</div>
      <div className={styles.spacer} />
      <div className={styles.divider} />
      <div className={styles.group}>{BOTTOM.map(renderItem)}</div>
    </nav>
  );
}
