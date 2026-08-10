/**
 * canvas 的 `ctx.font` 不认 CSS 变量，只能取 computed style 里的实际值。
 *
 * 不这么做的话，每个画布都得自己写死一串字体名 —— M6 换衬线体时就发现刻度文字
 * 全被漏掉了。走这里的话，改 `--font-mono` 一个 token，所有画布跟着变。
 */

let cached = "";

function family(): string {
  if (!cached) {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
    cached = v || "Georgia, serif";
  }
  return cached;
}

/** 例：`canvasFont(11)` → `"11px \"Source Serif 4\", ..."`。 */
export function canvasFont(px: number, weight?: number | string): string {
  return `${weight ? `${weight} ` : ""}${px}px ${family()}`;
}
