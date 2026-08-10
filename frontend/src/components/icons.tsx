/** 手绘线性图标，统一 20x20、1.6 描边，不依赖图标库。 */
type IconProps = { size?: number };
const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** 指挥教学（一级）：摊开的书。 */
export function TeachIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M10 5.5C8.5 4 6 3.5 2.5 4v11c3.5-.5 6 0 7.5 1.5 1.5-1.5 4-2 7.5-1.5V4c-3.5-.5-6 0-7.5 1.5Z" />
      <path d="M10 5.5v11" />
    </svg>
  );
}

/** 指挥体验（一级）：一根指挥棒 —— 斜线 + 棒尖的点，和 Logo 里的意象一致。 */
export function PerformIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M3.5 16.5 14 6" />
      <circle cx="15.5" cy="4.5" r="2.2" />
      <path d="M2 18.2 4.6 15.4" strokeWidth={2.4} />
    </svg>
  );
}

/** 助手：一个对话气泡。 */
export function AgentIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M17 11.5a2 2 0 0 1-2 2H8l-4 3.2V13.5a2 2 0 0 1-1-1.7v-6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" />
      <path d="M7 7.5h6M7 10h4" />
    </svg>
  );
}

/** 考试：一块打了勾的评分板。 */
export function ExamIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M6 3.5H4.5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-12a1 1 0 0 0-1-1H14" />
      <path d="M7 2.5h6v2.6H7z" />
      <path d="m7 11.5 2 2 4-4.5" />
    </svg>
  );
}

/** 课程：图形拍型的四拍轨迹（下→左→右→上），拍点处有个记号。 */
export function LessonIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" {...base}>
      <path d="M10 2.5v11" />
      <path d="M10 13.5 4 9.5" />
      <path d="M4 9.5 16 13" />
      <path d="M16 13V4" />
      <circle cx="10" cy="13.5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

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
