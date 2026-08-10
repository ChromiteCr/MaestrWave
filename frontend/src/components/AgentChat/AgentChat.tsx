import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../state/store";
import styles from "./AgentChat.module.css";

/**
 * 对话本体：消息列表 + 输入框 + 建议问题。
 *
 * 只管展示与输入，**对话状态在 store 里**（`agentMessages` / `askAgent`）。
 * 这样右侧侧栏和课程页里内嵌的这一块是同一段对话 —— 各存一份的话，用户会想不起来
 * 刚才那句是在哪儿问的，「清空」也只会清掉一半。
 */

interface Props {
  /** 空对话时显示的建议问题。课程页会传和本课有关的。 */
  suggestions: string[];
  /** 消息区最大高度。侧栏是撑满剩余空间，内嵌那块要限高免得把页面顶飞。 */
  maxHeight?: number;
  emptyHint?: string;
}

export function AgentChat({ suggestions, maxHeight, emptyHint }: Props) {
  const messages = useAppStore((s) => s.agentMessages);
  const busy = useAppStore((s) => s.agentBusy);
  const error = useAppStore((s) => s.agentError);
  const askAgent = useAppStore((s) => s.askAgent);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const [input, setInput] = useState("");
  const [needKey, setNeedKey] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // 先问一下有没有配 key，别等用户打完一段字才报错
  useEffect(() => {
    api.llmConfig()
      .then((s) => setNeedKey(!s.ready))
      .catch(() => setNeedKey(false));
  }, []);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    const ok = await askAgent(q);
    // 失败时把原文放回去 —— 打了一长段字结果被清空是最气人的
    if (!ok) setInput(q);
  };

  return (
    <div className={styles.wrap}>
      <div
        className={styles.list}
        ref={listRef}
        style={maxHeight ? { maxHeight, flex: "0 1 auto" } : undefined}
      >
        {messages.length === 0 && (
          <div className={styles.empty}>
            {emptyHint && <p>{emptyHint}</p>}
            <div className={styles.suggestions}>
              {suggestions.map((s) => (
                <button key={s} type="button" className={styles.suggestion} onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? styles.user : styles.assistant}>
            {m.content}
          </div>
        ))}

        {busy && <div className={styles.thinking}>正在想…</div>}
        {error && <div className={styles.error}>{error}</div>}
        {needKey && messages.length === 0 && (
          <div className={styles.notice}>
            还没配语言模型的 API key，问不了。
            <button type="button" className={styles.textBtn} onClick={() => setActivePage("settings")}>
              去设置
            </button>
          </div>
        )}
      </div>

      <div className={styles.composer}>
        <textarea
          rows={2}
          value={input}
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button
          type="button"
          className={styles.send}
          disabled={busy || !input.trim()}
          onClick={() => void send(input)}
        >
          发送
        </button>
      </div>
    </div>
  );
}
