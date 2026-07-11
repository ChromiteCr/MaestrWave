/** MaestrWave 的 logo：一条指挥棒（直线，棒尖是个光点）斜切过一道波浪，
 * 呼应"指挥"和"声波/波形"两个主题。放在侧栏文件图标正上方。 */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--surface-3)" />
          <stop offset="100%" stopColor="var(--bg)" />
        </linearGradient>
        <linearGradient id="logo-wave" x1="3" y1="20" x2="25" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--wave-2)" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
      </defs>

      <rect width="28" height="28" rx="7" fill="url(#logo-bg)" />

      <path
        d="M4,18 C7,14.5 9.5,20 12.5,16.5 C15.5,13 18,18.5 24,13.5"
        stroke="url(#logo-wave)"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
        opacity="0.85"
      />

      <line x1="6.5" y1="22" x2="21.5" y2="6.5" stroke="var(--ink)" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="21.5" cy="6.5" r="2.1" fill="var(--accent)" />
    </svg>
  );
}
