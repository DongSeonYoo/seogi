/** GPT-Live sends the next sentence without a leading space; other deltas carry their own spacing. */
export function appendDelta(text: string, delta: string) {
  return /[.?!…。]$/.test(text) && /^[^\s\d.,?!]/.test(delta) ? `${text} ${delta}` : text + delta;
}
