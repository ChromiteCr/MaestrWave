/**
 * canvas 取色的两件小事。和 `canvasFont.ts` 同一个理由：canvas 读不到 CSS 变量。
 *
 * **不要在 canvas 里用 `color-mix()`**：它是 CSS 的颜色函数，canvas 的颜色解析
 * 对它的支持各家不一，而解析失败时 `fillStyle` 是**静默保留上一个值**的 ——
 * 会变成一个「某些浏览器上颜色全错」且完全没有报错的 bug。要半透明就用
 * `withAlpha()`，自己按 token 的十六进制算 rgba。
 */

/** 读一个 CSS 变量的实际值；取不到时用 fallback（首帧、或主题还没挂上）。 */
export function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** `#7cb2e8` + 0.4 → `rgba(124, 178, 232, 0.4)`。不是六位十六进制就原样返回。 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
