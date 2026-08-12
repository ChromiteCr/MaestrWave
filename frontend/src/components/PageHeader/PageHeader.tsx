import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  /**
   * 返回键。放在 eyebrow **上面**，不放右边的 actions 里 —— 返回是「从哪儿来」，
   * 属于标题的上文；右边那一列是「在这儿能做什么」。混在一起的话，返回会和
   * 「开始跟练」这类操作排成一行，而它们不是一类东西。
   */
  back?: ReactNode;
}

/** 每个页面共用的标题区：巨大标题 + 极小 mono 元信息，撑起标题/正文的尺度对比。 */
export function PageHeader({ eyebrow, title, meta, actions, back }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        {back}
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
