# Bundled fonts

The app's default body and code fonts (#731), shipped with the UI so the desktop app, the browser
and every OS show the same type. Each is one whole file, not subset: the UI loads from the app
bundle, so there is no network cost to save. Settings → Appearance can still put another font in
front of them, and the system fonts stay behind them as fallbacks (`styles/index.css`, `--font-sans`,
`--font-mono`; `@font-face` near the top of the file).

| File | Font | Version | Source | sha256 |
|---|---|---|---|---|
| `PretendardVariable.woff2` | Pretendard Variable (weights 45–920) | 1.3.9 | npm `pretendard@1.3.9`, `dist/web/variable/woff2/` (by the font's author, [orioncactus/pretendard](https://github.com/orioncactus/pretendard)) | `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4` |
| `D2Coding.woff2` | D2Coding Regular | 1.4.0 | [naver/d2codingfont](https://github.com/naver/d2codingfont) release `VER1.4.0`, `D2Coding/D2Coding-Ver1.4.0-20261003.ttf`, converted to WOFF2 with fontTools (no glyph or table changes) | `fcffce2a9fc5dc2183e7964d36658a6b93cfa9b513364ea8aa80643b0eb6ef05` |

D2Coding has no bold file here: bold code (rare in this UI) is synthesized by the browser.

## Licence

Both are under the **SIL Open Font License 1.1**: [OFL-Pretendard.txt](OFL-Pretendard.txt) and
[OFL-D2Coding.txt](OFL-D2Coding.txt). The licence notice is also inside each font file (name
records 13 and 14), so it travels with the file into the built app. The Reserved Font Names
(Pretendard; D2Coding, D2Coding-Bold) stay with the unmodified fonts.

## Updating

Replace the file, keep the name, update the version and sha256 above and the licence file if it
changed. For D2Coding: `python3 -c "from fontTools.ttLib import TTFont; f=TTFont('D2Coding-….ttf'); f.flavor='woff2'; f.save('D2Coding.woff2')"` (needs `brotli`).
