/** A byte count as the person and the model read it: `512 B`, `1.4 GB`, `12 MB`. Steps of 1024 labelled KB, MB and GB, the unit chosen after rounding */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  // One decimal below 10, whole numbers from there: 9.96 reads "10", not "10.0"
  const shown = (v: number): string => (v < 9.95 ? v.toFixed(1) : String(Math.round(v)))
  let value = bytes / 1024
  let unit = 0
  // 1024 KB (a count just under a MiB) reads "1.0 MB"
  while (unit < units.length - 1 && Number(shown(value)) >= 1024) {
    value /= 1024
    unit++
  }
  return `${shown(value)} ${units[unit]}`
}
