// Browser KeyboardEvent -> Quake key codes (quakekeys.h / keys.h).
//
// Quake keys are plain lowercase ASCII plus the K_* codes above 127; the
// engine applies its own shift table for console/menu typing, so a single
// key id per event is enough. Movement keys are not remapped here: the game
// binds WASD through console commands at startup (see STARTUP_BINDS).

export const QuakeKey = {
  TAB: 9,
  ENTER: 13,
  ESCAPE: 27,
  SPACE: 32,
  BACKSPACE: 127,
  UPARROW: 128,
  DOWNARROW: 129,
  LEFTARROW: 130,
  RIGHTARROW: 131,
  ALT: 132,
  CTRL: 133,
  SHIFT: 134,
  F1: 135,
  F2: 136,
  F3: 137,
  F4: 138,
  F5: 139,
  F6: 140,
  F7: 141,
  F8: 142,
  F9: 143,
  F10: 144,
  F11: 145,
  F12: 146,
  INS: 147,
  DEL: 148,
  PGDN: 149,
  PGUP: 150,
  HOME: 151,
  END: 152,
  MOUSE1: 200,
  MOUSE2: 201,
  MOUSE3: 202,
  MWHEELUP: 239,
  MWHEELDOWN: 240,
  PAUSE: 255,
}         ;

const CODE_TO_KEY                         = {
  ArrowUp: QuakeKey.UPARROW,
  ArrowDown: QuakeKey.DOWNARROW,
  ArrowLeft: QuakeKey.LEFTARROW,
  ArrowRight: QuakeKey.RIGHTARROW,
  Space: QuakeKey.SPACE,
  ControlLeft: QuakeKey.CTRL,
  ControlRight: QuakeKey.CTRL,
  ShiftLeft: QuakeKey.SHIFT,
  ShiftRight: QuakeKey.SHIFT,
  AltLeft: QuakeKey.ALT,
  AltRight: QuakeKey.ALT,
  Escape: QuakeKey.ESCAPE,
  Enter: QuakeKey.ENTER,
  NumpadEnter: QuakeKey.ENTER,
  Tab: QuakeKey.TAB,
  Backspace: QuakeKey.BACKSPACE,
  Pause: QuakeKey.PAUSE,
  Home: QuakeKey.HOME,
  End: QuakeKey.END,
  PageUp: QuakeKey.PGUP,
  PageDown: QuakeKey.PGDN,
  Insert: QuakeKey.INS,
  Delete: QuakeKey.DEL,
  F1: QuakeKey.F1,
  F2: QuakeKey.F2,
  F3: QuakeKey.F3,
  F4: QuakeKey.F4,
  F5: QuakeKey.F5,
  F6: QuakeKey.F6,
  F7: QuakeKey.F7,
  F8: QuakeKey.F8,
  F9: QuakeKey.F9,
  F10: QuakeKey.F10,
  F11: QuakeKey.F11,
  F12: QuakeKey.F12,
};

// Returns undefined for keys Quake has no use for.
export function translateKey(event               )                     {
  const mapped = CODE_TO_KEY[event.code];
  if (mapped !== undefined) {
    return mapped;
  }
  // Letters by physical key so layouts with shifted symbols still move.
  if (/^Key[A-Z]$/.test(event.code)) {
    return event.code.charCodeAt(3) + 32;
  }
  if (/^Digit[0-9]$/.test(event.code)) {
    return event.code.charCodeAt(5);
  }
  if (event.key.length === 1) {
    const code = event.key.toLowerCase().charCodeAt(0);
    if (code >= 32 && code < 127) {
      return code;
    }
  }
  return undefined;
}

// Console commands issued once after Host_Init: modern movement binds and
// mouse look (vanilla only looks with the mouse while +mlook is held).
export const STARTUP_BINDS = [
  "+mlook",
  "bind w +forward",
  "bind s +back",
  "bind a +moveleft",
  "bind d +moveright",
  "bind q +left",
  "bind e +right",
  "bind SPACE +jump",
  "bind MOUSE1 +attack",
  "bind MOUSE2 +jump",
  "bind MOUSE3 +forward",
  "bind MWHEELUP impulse 12",
  "bind MWHEELDOWN impulse 10",
  "bind SHIFT +speed",
  "bind CTRL +attack",
];


//# sourceURL=examples/quake/sim/quakekeys.ts