import { Sidebar } from "./components/Sidebar/Sidebar";
import { WaveBackdrop } from "./components/WaveBackdrop/WaveBackdrop";
import { FilePage } from "./pages/FilePage/FilePage";
import { GeneratePage } from "./pages/GeneratePage/GeneratePage";
import { BrowsePage } from "./pages/BrowsePage/BrowsePage";
import { OutputPage } from "./pages/OutputPage/OutputPage";
import { TrainPage } from "./pages/TrainPage/TrainPage";
import { SettingsPage } from "./pages/SettingsPage/SettingsPage";
import { useAppStore } from "./state/store";

const PAGES = {
  file: FilePage,
  generate: GeneratePage,
  browse: BrowsePage,
  output: OutputPage,
  train: TrainPage,
  settings: SettingsPage,
};

export function App() {
  const activePage = useAppStore((s) => s.activePage);
  const Page = PAGES[activePage];

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
