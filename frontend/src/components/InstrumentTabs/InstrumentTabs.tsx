import { useState } from "react";
import type { Instrument, InstrumentLibrary } from "../../lib/api";
import { CloseIcon, PlusIcon } from "../icons";
import { Button } from "../Button/Button";
import styles from "./InstrumentTabs.module.css";

interface InstrumentTabsProps {
  instruments: Instrument[];
  selectedId: string | null;
  pendingIds: Set<string>;
  library: InstrumentLibrary | null;
  onSelect: (id: string) => void;
  onAdd: (libraryKey: string) => void;
  onClose: (id: string) => void;
}

export function InstrumentTabs({ instruments, selectedId, pendingIds, library, onSelect, onAdd, onClose }: InstrumentTabsProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customName, setCustomName] = useState("");

  const status = (inst: Instrument) => {
    if (pendingIds.has(inst.id)) return styles.dotPending;
    if (inst.current_take_id) return styles.dotReady;
    return "";
  };

  const closePicker = () => {
    setPickerOpen(false);
    setCustomMode(false);
    setCustomName("");
  };

  const submitCustom = () => {
    const name = customName.trim();
    if (!name) return;
    onAdd(name);
    closePicker();
  };

  return (
    <div className={styles.strip}>
      {instruments.map((inst) => (
        <div key={inst.id} className={`${styles.tab} ${inst.id === selectedId ? styles.tabActive : ""}`}>
          <button type="button" onClick={() => onSelect(inst.id)} style={{ all: "unset", display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
            <span className={`${styles.dot} ${status(inst)}`} />
            {inst.display_name}
          </button>
          <button type="button" className={styles.closeBtn} title="移除乐器" onClick={() => onClose(inst.id)}>
            <CloseIcon />
          </button>
        </div>
      ))}

      <button type="button" className={styles.addBtn} title="添加乐器" onClick={() => (pickerOpen ? closePicker() : setPickerOpen(true))}>
        <PlusIcon />
      </button>

      {pickerOpen && library && !customMode && (
        <div className={styles.picker} onMouseLeave={closePicker}>
          {Object.entries(library.library).map(([key, spec]) => (
            <button
              key={key}
              type="button"
              className={styles.pickerItem}
              onClick={() => {
                onAdd(key);
                closePicker();
              }}
            >
              {spec.display_name}
            </button>
          ))}
          <button type="button" className={styles.pickerItem} onClick={() => setCustomMode(true)}>
            其他…
          </button>
        </div>
      )}

      {pickerOpen && customMode && (
        <div className={styles.picker}>
          <div className={styles.customRow}>
            <input
              autoFocus
              placeholder="输入乐器名，比如萨克斯风"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitCustom()}
            />
            <Button variant="primary" disabled={!customName.trim()} onClick={submitCustom}>
              添加
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
