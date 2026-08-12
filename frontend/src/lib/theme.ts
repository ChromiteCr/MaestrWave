/**
 * 深色 / 浅色主题的读写与落地。
 *
 * 主题是一个 `data-theme` 属性，挂在 `<html>` 上，由 styles/global.css 里的
 * `:root[data-theme="light"]` 接住并覆盖整套 token。深色是默认值，**不带属性**
 * ——这样即使这里整个失效，界面也退回到原来的深色，而不是半套主题。
 *
 * 必须在 React 渲染前调用一次 `applyTheme(readTheme())`（见 main.tsx）：
 * 等 effect 里再挂就晚了一帧，浅色用户会先闪一下深色底。
 */

export type Theme = "dark" | "light";

/** 设置页那两个选项。和 CONDUCT_MODES 一样，文案跟着选项走，不散在页面里。 */
export const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "dark", label: "深色", hint: "默认。暖炭黑底配水蓝，适合正常光线下长时间看。" },
  { id: "light", label: "浅色", hint: "纸白底配深蓝，给强光环境、投影和白色展板用。" },
];

export const THEME_KEY = "mw.theme";
export const DEFAULT_THEME: Theme = "dark";

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // 隐私模式下 localStorage 会抛
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");

  /*
    index.html 里那个 <meta name="color-scheme" content="dark"> 是写死的，
    它管的是浏览器给原生控件（滚动条、下拉、日期选择器）配什么底色。
    不同步改的话，浅色界面上会挂着一条深色滚动条。
  */
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 存不下就只在本次会话里生效，不值得为此报错
  }
}
