import { create } from "zustand";

const KEY = "pixel-live:shortcuts";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

interface Prefs {
  /** Single-key shortcuts (1-4 for emotes, B for a bookmark). Can be turned off: they fire whenever focus is not in a text field. */
  shortcuts: boolean;
}

export const usePrefs = create<Prefs>(() => ({ shortcuts: read() }));

export function setShortcuts(on: boolean) {
  usePrefs.setState({ shortcuts: on });
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // not remembered across visits
  }
}
