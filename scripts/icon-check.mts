/**
 * Whether a built app carries the repository's icon (#1736): a release check, so a package with a stale icon fails
 * before it is published (`release-npm.mts`).
 *
 * Windows: the resource compiler stores each image of `icon.ico` in the exe as it is, one `RT_ICON` resource per
 * image, the `.ico` file's directory entry rewritten as the group's. So each image's bytes, PNG or BMP, appear verbatim
 * in `centralu.exe`: searching for them is the whole check, and no PE resource parser is needed.
 */

/** The images of an `.ico` file: what its directory points at (ICONDIR, then 16-byte ICONDIRENTRYs) */
export function icoImages(ico: Buffer): Buffer[] {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('not an .ico file')
  const count = ico.readUInt16LE(4)
  const images: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    if (entry + 16 > ico.length) throw new Error(`the .ico directory ends before image ${i + 1} of ${count}`)
    const size = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    if (size === 0 || offset + size > ico.length) throw new Error(`image ${i + 1} of the .ico lies outside the file`)
    images.push(ico.subarray(offset, offset + size))
  }
  return images
}

/** Which images of `ico` (1-based, in directory order) `exe` does not carry; empty when it carries them all */
export function missingIcoImages(ico: Buffer, exe: Buffer): number[] {
  return icoImages(ico).flatMap((image, i) => (exe.includes(image) ? [] : [i + 1]))
}
