import { useAppStore } from "../../state/store";
import { AgentChat } from "../AgentChat/AgentChat";
import { AgentIcon, CloseIcon } from "../icons";
import styles from "./AgentPanel.module.css";

/**
 * 右侧可折叠的问答侧栏 —— 只是 `AgentChat` 的外壳（折叠条 + 标题栏）。
 *
 * 常驻在 App 层：要能在任何页面随手问一句，切页时对话不该丢。也因此它不属于
 * 左侧任何一个一级导航。课程页里还内嵌了同一段对话的第二个入口，两处共享
 * store 里的 `agentMessages`。
 */

const SUGGESTIONS = [
  "四拍的拍型怎么打？",
  "渐强和渐弱怎么用手表达？",
  "「构型」页是做什么的？",
  "怎么用摄像头指挥？",
];

export function AgentPanel() {
  const open = useAppStore((s) => s.agentOpen);
  const setOpen = useAppStore((s) => s.setAgentOpen);
  const hasMessages = useAppStore((s) => s.agentMessages.length > 0);
  const clearAgent = useAppStore((s) => s.clearAgent);

  if (!open) {
    return (
      <button
        type="button"
        className={styles.rail}
        title="问问助手"
        aria-label="打开助手"
        onClick={() => setOpen(true)}
      >
        <AgentIcon />
        <span className={styles.railText}>助手</span>
      </button>
    );
  }

  return (
    <aside className={styles.panel}>
      <header className={styles.head}>
        <div>
          <p className="eyebrow">助手</p>
          <p className={styles.sub}>指挥知识与软件操作</p>
        </div>
        <div className={styles.headActions}>
          {hasMessages && (
            <button type="button" className={styles.textBtn} onClick={clearAgent}>
              清空
            </button>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="收起"
            onClick={() => setOpen(false)}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </header>

      <AgentChat suggestions={SUGGESTIONS} emptyHint="问我指挥怎么打，或者这个软件怎么用。" />
    </aside>
  );
}
