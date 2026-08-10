/**
 * MaestrWave 的字标：斜切的 M/W 折线，既是首字母也是波形，
 * 与 `public/icon.svg`（favicon / 应用图标）是同一份图形，改一处要同步另一处。
 *
 * 底色写死为海军蓝→黑的渐变，不走主题 token —— 它是品牌标识，
 * 需要在侧栏、浏览器标签、桌面图标等不同背景下保持一致。
 */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
      <defs>
        {/* id 带 logo- 前缀，避免和页面里同时出现的 icon.svg 撞号 */}
        <linearGradient id="logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1B2E55" />
          <stop offset="0.5" stopColor="#0A1428" />
          <stop offset="1" stopColor="#02040A" />
        </linearGradient>
        <linearGradient id="logo-ink" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#C7D3E6" />
        </linearGradient>
      </defs>

      {/* rx 120 ≈ 28px 显示尺寸下的 6.6px 圆角，和侧栏其他图标按钮的圆角量级一致 */}
      <rect width="512" height="512" rx="120" fill="url(#logo-bg)" />

      <g transform="translate(92.56,187.70) scale(1.2197)">
        <g transform="translate(0,56.0) skewX(-8) translate(0,-56.0)">
          <path
            d="M22.500,0.000 L43.500,0.000 L10.500,112.000 L-10.500,112.000 Z M22.500,0.000 L43.500,0.000 L76.500,112.000 L55.500,112.000 Z M88.500,0.000 L109.500,0.000 L76.500,112.000 L55.500,112.000 Z M88.500,0.000 L109.500,0.000 L142.500,112.000 L121.500,112.000 Z M125.500,0.000 L146.500,0.000 L179.500,112.000 L158.500,112.000 Z M191.500,0.000 L212.500,0.000 L179.500,112.000 L158.500,112.000 Z M191.500,0.000 L212.500,0.000 L245.500,112.000 L224.500,112.000 Z M257.500,0.000 L278.500,0.000 L245.500,112.000 L224.500,112.000 Z"
            fill="url(#logo-ink)"
            fillRule="nonzero"
          />
        </g>
      </g>
    </svg>
  );
}
