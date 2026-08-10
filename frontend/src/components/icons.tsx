/** 手绘线性图标，统一 20x20、1.6 描边，不依赖图标库——侧栏只用图标不用文字。 */
type IconProps = { size?: number };
const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** 构型：高低不等的柱子 —— 就是这一页的签名视觉「乐曲情绪柱状图」。 */
export function FormationIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M3 14v3M6.5 11v6M10 5v12M13.5 8v9M17 13v4" />
    </svg>
  );
}

export function FileIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M5 2.5h6l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z" />
      <path d="M11 2.5V7h4" />
    </svg>
  );
}

export function GenerateIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M1.5 10h3l1.5-5 3 10 2-13 2 8h4.5" />
    </svg>
  );
}

export function BrowseIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M2 5h11M2 5l2-2M2 5l2 2" />
      <path d="M2 10h16" />
      <path d="M2 15h7M18 15l-2-2M18 15l-2 2" />
    </svg>
  );
}

export function OutputIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <rect x="6.5" y="2" width="7" height="16" rx="1.5" />
      <path d="M2.5 8a6 6 0 0 1 2-4.3M17.5 8a6 6 0 0 0-2-4.3" />
      <circle cx="10" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TrainIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M4 17V10M10 17V4M16 17v-6" />
      <path d="M10 4 6.5 7.8M10 4l3.5 3.8" />
    </svg>
  );
}

export function SettingsIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2.1M10 15.4v2.1M17.5 10h-2.1M4.6 10H2.5M15.1 4.9l-1.5 1.5M6.4 13.6l-1.5 1.5M15.1 15.1l-1.5-1.5M6.4 6.4 4.9 4.9" />
    </svg>
  );
}

export function PlayIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M4 2.5v11l10-5.5-10-5.5Z" />
    </svg>
  );
}

export function StopIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  );
}

export function PlusIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
      <path d="M7 1.5v11M1.5 7h11" />
    </svg>
  );
}

export function CloseIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" {...base}>
      <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
    </svg>
  );
}
