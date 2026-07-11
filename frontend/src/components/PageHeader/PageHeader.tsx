import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}

/** 每个页面共用的标题区：巨大标题 + 极小 mono 元信息，撑起标题/正文的尺度对比。 */
export function PageHeader({ eyebrow, title, meta, actions }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="display-1">{title}</h1>
      </div>
      <div className={styles.meta}>
        {meta}
        {actions}
      </div>
    </header>
  );
}
