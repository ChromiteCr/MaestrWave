import { useEffect, useRef } from "react";
import QRCode from "qrcode";
import styles from "./QrCode.module.css";

interface QrCodeProps {
  /** 要编码的完整 URL。 */
  value: string;
  size?: number;
}

/**
 * 「输出」页电脑模式下给手机扫的二维码。
 *
 * 刻意用浅色底 + 深色码而不是跟随暗色主题——扫码识别率靠的是明暗对比，
 * 深色底的二维码在很多手机相机下识别很差。所以这里给它一块白底卡片。
 */
export function QrCode({ value, size = 200 }: QrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) return;
    QRCode.toCanvas(canvas, value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#15130f", light: "#ffffff" },
    }).catch(() => {
      /* URL 过长等情况下静默失败，页面下方仍有可手输的地址 */
    });
  }, [value, size]);

  return (
    <div className={styles.card}>
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
