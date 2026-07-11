import styles from "./WaveBackdrop.module.css";

/**
 * 页面上半部分的装饰性波浪：几支不同的蓝叠在一起，透明度都很低，
 * 底部渐隐融入 --bg，不抢内容，只是一层氛围。纯装饰，pointer-events: none。
 */
export function WaveBackdrop() {
  return (
    <div className={styles.backdrop} aria-hidden="true">
      <svg className={styles.svg} viewBox="0 0 1440 420" preserveAspectRatio="none">
        <defs>
          <linearGradient id="wave-g1" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--wave-4)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--wave-4)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="wave-g2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--wave-1)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--wave-2)" stopOpacity="0.03" />
          </linearGradient>
          <linearGradient id="wave-g3" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--wave-2)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--wave-3)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="wave-g4" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--wave-3)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="var(--wave-3)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="wave-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="62%" stopColor="#fff" stopOpacity="1" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="wave-mask">
            <rect width="1440" height="420" fill="url(#wave-fade)" />
          </mask>
          <filter id="wave-soften" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="10" />
          </filter>
        </defs>

        <g mask="url(#wave-mask)" filter="url(#wave-soften)">
          <path
            d="M0,90 C180,40 360,140 540,90 C720,40 900,140 1080,90 C1260,40 1350,110 1440,80 L1440,0 L0,0 Z"
            fill="url(#wave-g1)"
          />
          <path
            d="M0,150 C200,100 380,200 600,150 C780,110 960,210 1140,160 C1260,130 1350,180 1440,150 L1440,0 L0,0 Z"
            fill="url(#wave-g2)"
          />
          <path
            d="M0,210 C220,260 400,160 620,210 C800,250 980,170 1160,220 C1280,250 1360,200 1440,215 L1440,0 L0,0 Z"
            fill="url(#wave-g3)"
          />
          <path
            d="M0,280 C240,240 460,320 680,280 C860,250 1040,310 1220,280 C1310,265 1380,290 1440,275 L1440,0 L0,0 Z"
            fill="url(#wave-g4)"
          />
        </g>
      </svg>
    </div>
  );
}
