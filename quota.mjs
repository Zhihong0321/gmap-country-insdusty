// The AGY CLI reports its account limit as plain text with a relative reset.
export function quotaCooldownMs(message) {
  const text = String(message ?? '');
  if (!/individual quota reached/i.test(text)) return null;
  const reset = /resets?\s+in\s+([^\r\n.]+)/i.exec(text)?.[1] ?? '';
  let ms = 0;
  for (const part of reset.matchAll(/(\d+)\s*(d(?:ays?)?|h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)/gi)) {
    ms += Number(part[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[part[2][0].toLowerCase()];
  }
  // If AGY omits a reset time, stop the retry storm for one hour.
  return Math.min(Math.max(ms || 3_600_000, 60_000) + 5_000, 7 * 86_400_000);
}
