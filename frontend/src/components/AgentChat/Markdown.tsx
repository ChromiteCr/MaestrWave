import { Fragment, type ReactNode } from "react";
import styles from "./Markdown.module.css";

/**
 * 助手回复的 Markdown 渲染。
 *
 * 只认语言模型实际会写的那几种记法：标题、有序/无序列表、粗体、斜体、
 * 行内代码、代码块、分隔线。**刻意不引 react-markdown**：
 *
 *  1. 那套东西（remark + rehype + 一串 micromark 扩展）压缩后几十 KB，
 *     而这里要渲染的是聊天气泡，用不到表格、脚注、GFM 任务列表。
 *  2. 更要紧的是安全：这里渲染的是**语言模型的输出**，而模型的输入里
 *     混着课程数据和项目摘要。整条链路都不碰 `dangerouslySetInnerHTML`，
 *     直接拼 React 元素 —— 于是无论模型吐出什么，都不可能变成可执行的
 *     HTML。链接也只渲染成文字，不生成 <a>，省掉一整类钓鱼路径。
 */

interface Props {
  text: string;
}

/** 行内记法：`code` > **bold** > *italic* / _italic_。按优先级依次切分。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // 一次正则扫完三种记法，避免嵌套解析 —— 聊天回复里不会出现粗体套斜体
  // 这种写法，为它做一棵语法树不值得。
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-i${i++}`;
    if (token.startsWith("`")) {
      out.push(<code key={key} className={styles.code}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 段落内的单个换行渲染成 <br>：模型经常靠换行断句，吞掉会挤成一坨。 */
function renderLines(lines: string[], keyPrefix: string): ReactNode[] {
  return lines.map((line, i) => (
    <Fragment key={`${keyPrefix}-l${i}`}>
      {i > 0 && <br />}
      {renderInline(line, `${keyPrefix}-l${i}`)}
    </Fragment>
  ));
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*(#{1,4})\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

export function Markdown({ text }: Props) {
  const src = (text || "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const blocks: ReactNode[] = [];

  let i = 0;
  let k = 0;
  const nextKey = () => `b${k++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 代码块：围栏没闭合时读到末尾，不要因为模型少写三个反引号就整段丢掉
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={nextKey()} className={styles.pre}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(<hr key={nextKey()} className={styles.rule} />);
      i += 1;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      // 聊天气泡里不需要六级标题的层次，一律渲染成一种加重的小标题，
      // 靠字号区分反而会让窄侧栏里的排版忽大忽小。
      blocks.push(
        <p key={nextKey()} className={styles.heading}>
          {renderInline(h[2], nextKey())}
        </p>,
      );
      i += 1;
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i])) {
        items.push(BULLET.exec(lines[i])![1]);
        i += 1;
      }
      blocks.push(
        <ul key={nextKey()} className={styles.list}>
          {items.map((it, n) => (
            <li key={n}>{renderInline(it, `u${k}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (ORDERED.test(line)) {
      const first = Number(ORDERED.exec(line)![1]);
      const items: string[] = [];
      while (i < lines.length && ORDERED.test(lines[i])) {
        items.push(ORDERED.exec(lines[i])![2]);
        i += 1;
      }
      blocks.push(
        // start 跟随原文：模型分几段讲时会写「4. 5. 6.」接着上一段
        <ol key={nextKey()} className={styles.list} start={first}>
          {items.map((it, n) => (
            <li key={n}>{renderInline(it, `o${k}-${n}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // 普通段落：吃到空行或下一个块级记法为止
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !BULLET.test(lines[i]) &&
      !ORDERED.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !lines[i].trim().startsWith("```")
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={nextKey()} className={styles.para}>
        {renderLines(para, `p${k}`)}
      </p>,
    );
  }

  return <div className={styles.md}>{blocks}</div>;
}
