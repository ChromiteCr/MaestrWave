import { Sidebar } from "./components/Sidebar/Sidebar";
import { WaveBackdrop } from "./components/WaveBackdrop/WaveBackdrop";
import { FilePage } from "./pages/FilePage/FilePage";
import { GeneratePage } from "./pages/GeneratePage/GeneratePage";
import { BrowsePage } from "./pages/BrowsePage/BrowsePage";
import { OutputPage } from "./pages/OutputPage/OutputPage";
import { TrainPage } from "./pages/TrainPage/TrainPage";
import { SettingsPage } from "./pages/SettingsPage/SettingsPage";
import { RemotePage } from "./pages/RemotePage/RemotePage";
import { useAppStore } from "./state/store";

const PAGES = {
  file: FilePage,
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

export function App() {
  const activePage = useAppStore((s) => s.activePage);
  const Page = PAGES[activePage];

  const remoteRoom = remoteRoomFromUrl();
  if (remoteRoom) return <RemotePage roomId={remoteRoom} />;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <Sidebar />
      <main style={{ flex: 1, overflowY: "auto", position: "relative" }}>
        <WaveBackdrop />
        <div style={{ position: "relative", zIndex: 1 }}>
          <Page />
        </div>
      </main>
    </div>
  );
}
