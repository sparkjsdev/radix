// Browser KeyboardEvent -> Doom key codes (doomkeys.h).
//
// Doom events carry two values: data1 is the key identifier bound to
// actions (movement, fire, menus) and data2 is the typed character used by
// menus, chat, and cheat codes. WASD is mapped to the arrow/strafe keys in
// data1 while still reporting the letter in data2, so "idkfa" keeps working.

export const DoomKey = {
  RIGHTARROW: 0xae,
  LEFTARROW: 0xac,
  UPARROW: 0xad,
  DOWNARROW: 0xaf,
  STRAFE_L: 0xa0,
  STRAFE_R: 0xa1,
  USE: 0xa2,
  FIRE: 0xa3,
  ESCAPE: 27,
  ENTER: 13,
  TAB: 9,
  F1: 0x80 + 0x3b,
  F2: 0x80 + 0x3c,
  F3: 0x80 + 0x3d,
  F4: 0x80 + 0x3e,
  F5: 0x80 + 0x3f,
  F6: 0x80 + 0x40,
  F7: 0x80 + 0x41,
  F8: 0x80 + 0x42,
  F9: 0x80 + 0x43,
  F10: 0x80 + 0x44,
  F11: 0x80 + 0x57,
  F12: 0x80 + 0x58,
  BACKSPACE: 0x7f,
  PAUSE: 0xff,
  EQUALS: 0x3d,
  MINUS: 0x2d,
  RSHIFT: 0x80 + 0x36,
  RCTRL: 0x80 + 0x1d,
  RALT: 0x80 + 0x38,
  CAPSLOCK: 0x80 + 0x3a,
  HOME: 0x80 + 0x47,
  END: 0x80 + 0x4f,
  PGUP: 0x80 + 0x49,
  PGDN: 0x80 + 0x51,
  INS: 0x80 + 0x52,
  DEL: 0x80 + 0x53,
} as const;

export interface DoomKeyEvent {
  key: number;
  typed: number;
}

const CODE_TO_KEY: Record<string, number> = {
  ArrowUp: DoomKey.UPARROW,
  ArrowDown: DoomKey.DOWNARROW,
  ArrowLeft: DoomKey.LEFTARROW,
  ArrowRight: DoomKey.RIGHTARROW,
  KeyW: DoomKey.UPARROW,
  KeyS: DoomKey.DOWNARROW,
  KeyA: DoomKey.STRAFE_L,
  KeyD: DoomKey.STRAFE_R,
  KeyQ: DoomKey.LEFTARROW,
  KeyE: DoomKey.RIGHTARROW,
  Space: DoomKey.USE,
  ControlLeft: DoomKey.FIRE,
  ControlRight: DoomKey.FIRE,
  ShiftLeft: DoomKey.RSHIFT,
  ShiftRight: DoomKey.RSHIFT,
  AltLeft: DoomKey.RALT,
  AltRight: DoomKey.RALT,
  Escape: DoomKey.ESCAPE,
  Enter: DoomKey.ENTER,
  NumpadEnter: DoomKey.ENTER,
  Tab: DoomKey.TAB,
  Backspace: DoomKey.BACKSPACE,
  Pause: DoomKey.PAUSE,
  Equal: DoomKey.EQUALS,
  Minus: DoomKey.MINUS,
  NumpadAdd: DoomKey.EQUALS,
  NumpadSubtract: DoomKey.MINUS,
  CapsLock: DoomKey.CAPSLOCK,
  Home: DoomKey.HOME,
  End: DoomKey.END,
  PageUp: DoomKey.PGUP,
  PageDown: DoomKey.PGDN,
  Insert: DoomKey.INS,
  Delete: DoomKey.DEL,
  F1: DoomKey.F1,
  F2: DoomKey.F2,
  F3: DoomKey.F3,
  F4: DoomKey.F4,
  F5: DoomKey.F5,
  F6: DoomKey.F6,
  F7: DoomKey.F7,
  F8: DoomKey.F8,
  F9: DoomKey.F9,
  F10: DoomKey.F10,
  F11: DoomKey.F11,
  F12: DoomKey.F12,
};

// Returns undefined for keys Doom has no use for.
export function translateKey(event: KeyboardEvent): DoomKeyEvent | undefined {
  const typed = typedChar(event);
  const mapped = CODE_TO_KEY[event.code];
  if (mapped !== undefined) {
    return { key: mapped, typed };
  }
  // Printable ASCII: Doom uses the lowercase character as the key id.
  if (event.key.length === 1) {
    const code = event.key.toLowerCase().charCodeAt(0);
    if (code >= 32 && code < 127) {
      return { key: code, typed };
    }
  }
  return undefined;
}

function typedChar(event: KeyboardEvent): number {
  if (event.key.length === 1) {
    const code = event.key.charCodeAt(0);
    return code >= 32 && code < 127 ? code : 0;
  }
  switch (event.key) {
    case "Enter":
      return 13;
    case "Backspace":
      return 0x7f;
    case "Escape":
      return 27;
    case "Tab":
      return 9;
    default:
      return 0;
  }
}

// Mouse buttons in Doom's ev_mouse data1 order: fire, strafe, forward.
export function mouseButtonMask(buttons: number): number {
  let mask = 0;
  if (buttons & 1) mask |= 1; // left -> fire
  if (buttons & 2) mask |= 2; // right -> strafe
  if (buttons & 4) mask |= 4; // middle -> forward
  return mask;
}

export const KEY_BINDINGS_HELP = [
  "W/S or arrows: move, A/D: strafe, Q/E or arrows: turn",
  "Mouse: turn, left button: fire, right button: strafe",
  "Ctrl: fire, Space: use, Shift: run, Alt: strafe modifier",
  "1-7: weapons, Tab: map, Esc: menu, Enter/Y/N: menu select",
  "F2/F3 save/load, F5 detail, F6 quicksave, F9 quickload, Pause",
];
