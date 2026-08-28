// Byte-aware clipping for everything the bridge ships INTO the game.
//
// Measured on the stand 2026-08-28: the engine's string buffer is 1 KiB
// everywhere -- JsonFileLoader silently truncates any JSON string value at
// 1023 BYTES when the game parses a reply. A truncation that lands inside
// a multi-byte UTF-8 character leaves a broken glyph on screen, and
// JavaScript's String.slice counts UTF-16 units, not bytes -- 1500 Cyrillic
// characters are 3000 bytes. So the clip is by bytes, stepping back over
// UTF-8 continuation bytes, with 1000 as the ceiling to leave margin.

export const GAME_STR_MAX = 1000;

export function byteClip(s, max = GAME_STR_MAX) {
  const str = String(s ?? '');
  const b = Buffer.from(str, 'utf8');
  if (b.length <= max) return str;

  let cut = max;
  while (cut > 0 && (b[cut] & 0xc0) === 0x80) cut--;
  return b.toString('utf8', 0, cut);
}
