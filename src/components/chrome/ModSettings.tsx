"use client";

import "./chrome.css";
import "./settings.css";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { APP_FONTS, getStoredAppFont, setAppFont, type AppFontId } from "@/lib/app-font";
import { resetMeasuredFont } from "@/components/flow/clean/text-measure";
import { useDeviceSettings, wheelChangesValues, writeDeviceSettings } from "@/lib/device-settings";
import { MinimapSettingsRows } from "@/components/flow/clean/minimap/MinimapSettingsPanel";
import {
  getSoundLevel,
  playSfx,
  setSoundLevel,
  sfxClick,
  sfxTick,
  sfxToggle,
} from "@/lib/sound/sfx";
import { setUiScalePercent, useUiScalePercent } from "@/lib/ui-scale";
import { ChromeMenu, chromeAnchorOf, MENU_ANCHOR_ATTR, type ChromeAnchor } from "./ChromeMenu";
import { knock, OPEN_CONTROLS_EVENT, OPEN_TOUR_EVENT } from "./chrome-events";
import { SettingsPreview } from "./SettingsPreview";
import { AgentConnectionPanel } from "../AgentConnectionPanel";
import {
  SIZE_NAMES,
  SOUND_NAMES,
  ZOOMED_OUT_NAMES,
  ZOOMED_OUT_STEPS,
  sizeIndexOf,
  sizePercentOf,
  zoomedOutIndexOf,
} from "./settings-model";

type Kind = "switch" | "choice" | "slider" | "button";

interface Row {
  label: string;
  hint?: string;
  about?: string;
  kind: Kind;
  names: readonly string[];
  /** The value's index; -1 when none of the choices is the current one. */
  at: number;
  /** A button: the name shown instead of a value (for `button`, `names` are its keys). */
  to: (index: number, anchor?: HTMLElement) => void;
  /** Dimmed and inert. */
  off?: boolean;
}

interface Section {
  name: string;
  /** One short line on what the section is for. */
  intro?: string;
  rows: Row[];
  /** A section drawn by another part of the app instead of rows (the minimap's own rows). */
  body?: ReactNode;
}

/**
 * The planner's settings, the mod's box: a title bar, the sections down the left and the chosen one's settings on the
 * right, each with the control that fits it (a switch, a row of choices, a slider), a picture of what the section
 * changes beside them, and the section left open remembered. A change saves at once.
 */
export function ModSettings({ onClose }: { onClose: () => void }) {
  const settings = useDeviceSettings();
  const uiPercent = useUiScalePercent();
  const [font, setFont] = useState<AppFontId>(() => getStoredAppFont());
  const [soundIndex, setSoundIndex] = useState(() => getSoundLevel());
  const [menu, setMenu] = useState<{ anchor: ChromeAnchor }>();
  const dragRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !menu) {
        event.stopPropagation();
        playSfx("ui.close");
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, menu]);

  const setSound = (index: number) => {
    setSoundLevel(index);
    setSoundIndex(index);
  };
  // The box opens and closes with the mod's panel sounds.
  useEffect(() => {
    playSfx("ui.open");
  }, []);
  const close = () => {
    playSfx("ui.close");
    onClose();
  };

  const sections: Section[] = [
    {
      name: "Board",
      rows: [
        {
          label: "Size",
          about: "Sets how big the planner is.",
          hint: "of the planner",
          kind: "choice",
          names: SIZE_NAMES,
          at: sizeIndexOf(uiPercent),
          to: (index) => setUiScalePercent(sizePercentOf(index)),
        },
        {
          label: "Names when zoomed out",
          about: "Names each card when you zoom far out.",
          kind: "switch",
          names: ["Off", "On"],
          at: settings.zoomedOutNames ? 1 : 0,
          to: (index) => writeDeviceSettings({ zoomedOutNames: index === 1 }),
        },
        {
          label: "Zoomed-out view",
          about: "Cards turn simple below this zoom.",
          kind: "slider",
          names: ZOOMED_OUT_NAMES,
          at: zoomedOutIndexOf(settings.zoomedOutAt),
          to: (index) => writeDeviceSettings({ zoomedOutAt: ZOOMED_OUT_STEPS[index] }),
        },
        {
          label: "Problem outlines",
          about: "Draws a card's edge in its bar's colour.",
          kind: "switch",
          names: ["Off", "On"],
          at: settings.problemOutlines ? 1 : 0,
          to: (index) => writeDeviceSettings({ problemOutlines: index === 1 }),
        },
        {
          label: "Scroll changes values",
          about: "Scroll over a number or chip to change it.",
          kind: "switch",
          names: ["Off", "On"],
          at: settings.scrollChangesValues ? 1 : 0,
          to: (index) => writeDeviceSettings({ scrollChangesValues: index === 1 }),
        },
        {
          label: "Item browser",
          about: "The side it sits on.",
          kind: "choice",
          names: ["Left", "Right"],
          at: settings.itemsLeft ? 0 : 1,
          to: (index) => writeDeviceSettings({ itemsLeft: index === 0 }),
        },
        {
          label: "Font",
          about: "Sets the font of the planner.",
          kind: "button",
          names: [APP_FONTS.find((option) => option.id === font)?.label ?? "Inter"],
          at: 0,
          to: (_, anchor) => anchor && setMenu({ anchor: chromeAnchorOf(anchor) }),
        },
      ],
    },
    { name: "Minimap", rows: [], body: <MinimapSettingsRows className="ms-minimap" /> },
    { name: "Agent", rows: [], body: <AgentConnectionPanel /> },
    {
      name: "Sound",
      rows: [
        {
          label: "Sounds",
          about: "Sets how loud the clicks are.",
          kind: "choice",
          names: SOUND_NAMES,
          at: soundIndex,
          to: setSound,
        },
      ],
    },
    {
      name: "Controls",
      rows: [
        {
          label: "Controls and shortcuts",
          about: "Opens the list of keys.",
          kind: "button",
          names: ["Open"],
          at: 0,
          to: () => {
            onClose();
            window.setTimeout(() => knock(OPEN_CONTROLS_EVENT), 0);
          },
        },
        {
          label: "The tour",
          about: "Walks you through the planner.",
          kind: "button",
          names: ["Take it"],
          at: 0,
          to: () => {
            onClose();
            window.setTimeout(() => knock(OPEN_TOUR_EVENT), 0);
          },
        },
      ],
    },
  ];

  const sectionIndex = Math.max(
    0,
    sections.findIndex((section) => section.name === settings.settingsSection),
  );
  const section = sections[sectionIndex];
  const pick = (index: number, wheel?: boolean) => {
    if (index === sectionIndex) return;
    writeDeviceSettings({ settingsSection: sections[index].name });
    if (wheel) sfxTick(index < sectionIndex);
    else sfxClick();
  };

  const set = (row: Row, index: number, anchor?: HTMLElement) => {
    if (row.off) return;
    if (row.kind !== "button" && index === row.at) return;
    const up = index > row.at;
    row.to(index, anchor);
    // The sound of what changed, as the mod's SettingsPanel.set; the Sounds row clicks at its new loudness.
    if (row.kind === "switch") sfxToggle(index === 1);
    else if (row.kind === "slider")
      playSfx("ui.tick", 1, 0.85 + (0.4 * index) / Math.max(1, row.names.length - 1));
    else if (row.kind === "button" || row.label === "Sounds") sfxClick();
    else sfxTick(up);
  };

  return createPortal(
    <div
      className="ms-backdrop ui-zoom ms-zoom"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="ms mx"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-mod-settings=""
        data-section={section.name}
        onWheel={(event) => {
          // Over the sections, the wheel goes through them.
          const target = event.target as HTMLElement;
          if (!target.closest(".ms-side")) return;
          const next = Math.max(
            0,
            Math.min(sections.length - 1, sectionIndex + (event.deltaY > 0 ? 1 : -1)),
          );
          pick(next, true);
        }}
      >
        <div className="ms-title">
          <span>Settings</span>
          <div className="ms-close" role="button" aria-label="Close" onClick={close}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              shapeRendering="crispEdges"
              aria-hidden
              fill="currentColor"
            >
              <path d={crossPath()} />
            </svg>
          </div>
        </div>
        <div className="ms-body">
          <nav className="ms-side" aria-label="Settings sections" data-sfx-own="">
            {sections.map((entry, index) => (
              <div
                key={entry.name}
                role="tab"
                aria-selected={index === sectionIndex}
                className="ms-section"
                data-picked={index === sectionIndex ? "" : undefined}
                onClick={() => pick(index)}
              >
                {entry.name}
              </div>
            ))}
          </nav>
          <div className="ms-rows" data-sfx-own="">
            {section.intro ? <div className="ms-intro">{section.intro}</div> : null}
            {section.body ??
              section.rows.map((row) => (
                <SettingRow key={row.label} row={row} onSet={set} dragRef={dragRef} />
              ))}
          </div>
          <div className="ms-preview" aria-hidden>
            <SettingsPreview
              section={section.name}
              names={settings.zoomedOutNames}
              sizeIndex={sizeIndexOf(uiPercent)}
              soundIndex={soundIndex}
            />
          </div>
        </div>
      </div>
      {menu ? (
        <ChromeMenu
          anchor={menu.anchor}
          label="Font"
          align="right"
          minWidth={150}
          entries={APP_FONTS.map((option) => ({
            label: option.label,
            labelFont: option.stack,
            current: option.id === font,
            onSelect: () => {
              setAppFont(option.id);
              resetMeasuredFont();
              setFont(option.id);
            },
          }))}
          onClose={() => setMenu(undefined)}
        />
      ) : null}
    </div>,
    document.body,
  );
}

/** The pixel cross of a close key: two seven-pixel diagonals. */
export function crossPath(): string {
  const d: string[] = [];
  for (let k = -3; k <= 3; k++) {
    d.push(`M${6.5 + k} ${6.5 + k}h1v1h-1z`, `M${6.5 + k} ${6.5 - k}h1v1h-1z`);
  }
  return d.join("");
}

function SettingRow({
  row,
  onSet,
  dragRef,
}: {
  row: Row;
  onSet: (row: Row, index: number, anchor?: HTMLElement) => void;
  dragRef: React.MutableRefObject<string | undefined>;
}) {
  const last = row.names.length - 1;
  let control: ReactNode;
  if (row.kind === "switch") {
    control = (
      <span
        className="ms-switch"
        role="switch"
        aria-checked={row.at === 1}
        aria-label={row.label}
        data-on={row.at === 1 ? "" : undefined}
      >
        <span className="ms-knob" />
      </span>
    );
  } else if (row.kind === "slider") {
    control = (
      <span className="ms-slider-wrap">
        <input
          className="ms-slider"
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.max(0, row.at)}
          aria-label={row.label}
          onPointerDown={() => (dragRef.current = row.label)}
          onPointerUp={() => (dragRef.current = undefined)}
          onChange={(event) => {
            const value = Number(event.target.value);
            onSet(row, value);
          }}
        />
        <span className="ms-value">{row.names[Math.max(0, row.at)]}</span>
      </span>
    );
  } else {
    control = (
      <span
        className="ms-choices"
        role={row.kind === "choice" ? "radiogroup" : "group"}
        aria-label={row.label}
      >
        {row.names.map((name, index) => (
          <span
            key={name}
            role={row.kind === "choice" ? "radio" : "button"}
            aria-checked={row.kind === "choice" ? row.at === index : undefined}
            className="ms-choice"
            data-picked={row.kind === "choice" && row.at === index ? "" : undefined}
            {...(row.kind === "button" && row.label === "Font" ? { [MENU_ANCHOR_ATTR]: "" } : {})}
            onClick={(event) => {
              event.stopPropagation();
              onSet(row, index, event.currentTarget);
            }}
          >
            {name}
          </span>
        ))}
      </span>
    );
  }
  return (
    <div
      className="ms-row"
      data-kind={row.kind}
      data-off={row.off ? "" : undefined}
      onClick={() => {
        // The whole row flips a switch.
        if (row.kind === "switch") onSet(row, 1 - row.at);
      }}
      onWheel={(event) => {
        if (row.off || event.deltaY === 0 || !wheelChangesValues()) return;
        const step = event.deltaY < 0 ? 1 : -1;
        if (row.kind === "switch") onSet(row, step > 0 ? 1 : 0);
        else if (row.kind === "choice" || row.kind === "slider") {
          const next = Math.max(0, Math.min(last, (row.at < 0 ? 0 : row.at) + step));
          onSet(row, next);
        }
      }}
    >
      <span className="ms-text">
        <span className="ms-name">
          <span className="ms-label">{row.label}</span>
          {row.hint ? <span className="ms-hint">{row.hint}</span> : null}
        </span>
        {row.about ? <span className="ms-about">{row.about}</span> : null}
      </span>
      <span className="ms-spacer" />
      {control}
    </div>
  );
}
