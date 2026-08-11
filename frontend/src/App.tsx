import { AgentPanel } from "./components/AgentPanel/AgentPanel";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { WaveBackdrop } from "./components/WaveBackdrop/WaveBackdrop";
import { HomePage } from "./pages/HomePage/HomePage";
import { TeachPage } from "./pages/TeachPage/TeachPage";
import { LessonPage } from "./pages/LessonPage/LessonPage";
import { ExamPage } from "./pages/ExamPage/ExamPage";
import { FilePage } from "./pages/FilePage/FilePage";
import { FormationPage } from "./pages/FormationPage/FormationPage";
import { GeneratePage } from "./pages/GeneratePage/GeneratePage";
import { BrowsePage } from "./pages/BrowsePage/BrowsePage";
import { OutputPage } from "./pages/OutputPage/OutputPage";
import { TrainPage } from "./pages/TrainPage/TrainPage";
import { SettingsPage } from "./pages/SettingsPage/SettingsPage";
import { RemotePage } from "./pages/RemotePage/RemotePage";
import { DebugConductPage } from "./pages/DebugConductPage/DebugConductPage";
import { useAppStore } from "./state/store";

const PAGES = {
  home: HomePage,
  teach: TeachPage,
  "teach-lesson": LessonPage,
  "teach-exam": ExamPage,
  file: FilePage,
  formation: FormationPage,
  generate: GeneratePage,
  browse: BrowsePage,
  output: OutputPage,
  train: TrainPage,
  settings: SettingsPage,
};

/**
 * 手机扫码进来的地址形如 /?conduct=ABC123。这种情况下整个 app 切换成
 * 手机遥控界面——手机上不需要侧栏和编辑器那几个页面（见 pages/RemotePage）。
 */
function remoteRoomFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const room = new URLSearchParams(window.location.search).get("conduct");
  return room && room.trim() ? room.trim().toUpperCase() : null;
}

/**
 * /?debug=conduct 打开手势解析调试页。仿照上面 ?conduct= 的做法走 query 分支，
 * 不进侧栏也不动 store 里的 PageId —— 它是开发工具，不是产品页面。
 * 只在开发模式下可达，生产构建里这个分支恒为 false。
 */
function isDebugConduct(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("debug") === "conduct";
}

export function App() {
  const activePage = useAppStore((s) => s.activePage);
  const Page = PAGES[activePage];

  // DEV 判断必须内联在这里，不能藏进 isDebugConduct()：Vite 会把 import.meta.env.DEV
  // 替换成字面量 false，整个分支才会被判成死代码、DebugConductPage 才摇得掉。
  // 写成 if (isDebugConduct()) 的话 Rollup 证明不了它恒为假，调试页会被打进生产包。
  if (import.meta.env.DEV && isDebugConduct()) return <DebugConductPage />;

  const remoteRoom = remoteRoomFromUrl();
  if (remoteRoom) return <RemotePage roomId={remoteRoom} />;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <Sidebar />
      <main style={{ flex: 1, overflowY: "auto", position: "relative", minWidth: 0 }}>
        <WaveBackdrop />
        <div style={{ position: "relative", zIndex: 1 }}>
          <Page />
        </div>
      </main>
      {/* 常驻在这一层：切页时对话不能丢，而且它不属于左侧任何一个一级导航 */}
      <AgentPanel />
    </div>
  );
}
