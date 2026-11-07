/**
 * Button constructor (issue #25, «Кнопки»): drag-and-drop entries across
 * `controls.primary` / `controls.secondary` / `settings.menu`, hide them with
 * the «глазик», and reset to the default layout.
 */

import { useState } from "react";
import type { DragEvent, ReactElement } from "react";
import type { LayoutSlotId } from "./chromeSchema";
import { LAYOUT_SLOTS } from "./chromeSchema";
import { useChromeSchema, chromeStore } from "./chromeStore";
import type { ChromeEntry } from "./layoutModel";
import { resolveLayout } from "./layoutModel";
import { EyeToggle } from "./bits";

const SLOT_TITLES: Record<LayoutSlotId, string> = {
  "controls.primary": "Контролы · слева",
  "controls.secondary": "Контролы · справа",
  "settings.menu": "Меню настроек",
};

type DropTarget = { slot: LayoutSlotId; index: number };

export function LayoutEditor(): ReactElement {
  const schema = useChromeSchema();
  const resolved = resolveLayout(schema);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const dragEntry = dragId
    ? resolved.hidden
        .concat(resolved.slots["controls.primary"], resolved.slots["controls.secondary"], resolved.slots["settings.menu"])
        .find((entry) => entry.id === dragId) ?? null
    : null;

  const canDrop = (slot: LayoutSlotId): boolean =>
    dragEntry != null && dragEntry.allowedSlots.includes(slot);

  const onDropAt = (target: DropTarget) => {
    if (!dragId || !canDrop(target.slot)) return;
    chromeStore.moveEntry(dragId, target.slot, target.index);
    setDragId(null);
    setDrop(null);
  };

  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };

  return (
    <div className="ps-card">
      <h3>Кнопки</h3>
      <p className="hint">
        Перетаскивайте кнопки между слотами и внутри них — порядок сохранится и
        применится в плеере. «Глазик» прячет кнопку.
      </p>

      <div className="ps-slots">
        {LAYOUT_SLOTS.map((slot) => (
          <div
            key={slot}
            className={`ps-slot${drop?.slot === slot ? " ps-slot-dragover" : ""}`}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              if (!canDrop(slot)) return;
              event.preventDefault();
              setDrop({ slot, index: resolved.slots[slot].length });
            }}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              onDropAt(drop ?? { slot, index: resolved.slots[slot].length });
              endDrag();
            }}
          >
            <div className="ps-slot-title">{SLOT_TITLES[slot]}</div>
            {resolved.slots[slot].length === 0 ? (
              <div className="ps-empty">Перетащите сюда</div>
            ) : (
              resolved.slots[slot].map((entry, index) => (
                <Token
                  key={entry.id}
                  entry={entry}
                  dragging={dragId === entry.id}
                  dropHere={drop?.slot === slot && drop.index === index}
                  onDragStart={() => setDragId(entry.id)}
                  onDragEnd={endDrag}
                  onDragOver={() => {
                    if (!canDrop(slot)) return;
                    setDrop({ slot, index });
                  }}
                  onDropHere={() => onDropAt({ slot, index })}
                  onToggleVisible={() => chromeStore.hideEntry(entry.id)}
                  visible
                />
              ))
            )}
          </div>
        ))}
      </div>

      <div>
        <div className="ps-slot-title">Скрыто</div>
        {resolved.hidden.length === 0 ? (
          <div className="ps-empty">Ничего не скрыто</div>
        ) : (
          <div className="ps-hidden-list">
            {resolved.hidden.map((entry) => (
              <Token
                key={entry.id}
                entry={entry}
                dragging={dragId === entry.id}
                dropHere={false}
                onDragStart={() => setDragId(entry.id)}
                onDragEnd={endDrag}
                onDragOver={() => {}}
                onDropHere={endDrag}
                onToggleVisible={() => chromeStore.showEntry(entry.id)}
                visible={false}
              />
            ))}
          </div>
        )}
      </div>

      <div className="state-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => chromeStore.resetLayout()}
        >
          Сбросить раскладку
        </button>
        <span className="hint">
          {schema.hidden.length > 0
            ? `Скрыто кнопок: ${schema.hidden.length}`
            : "Все кнопки на местах"}
        </span>
      </div>
    </div>
  );
}

function Token({
  entry,
  dragging,
  dropHere,
  visible,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDropHere,
  onToggleVisible,
}: {
  entry: ChromeEntry;
  dragging: boolean;
  dropHere: boolean;
  visible: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDropHere: () => void;
  onToggleVisible: () => void;
}): ReactElement {
  return (
    <div
      className={`ps-token${dragging ? " ps-token-dragging" : ""}${dropHere ? " ps-slot-dragover" : ""}`}
      draggable
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", entry.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onDragOver();
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onDropHere();
      }}
    >
      <span className="ps-token-kind">{entry.kind === "button" ? "⌘" : "ƒ"}</span>
      <span className="ps-token-name">{entry.label}</span>
      <EyeToggle
        visible={visible}
        onChange={onToggleVisible}
        label={
          visible
            ? `Скрыть «${entry.label}» из плеера`
            : `Показать «${entry.label}» снова`
        }
      />
    </div>
  );
}
