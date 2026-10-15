# Bundled fonts

The app's default body and code fonts (#731), shipped with the UI so the desktop app, the browser
and every OS show the same type. Each is one whole file, not subset: the UI loads from the app
bundle, so there is no network cost to save. Settings → Appearance can still put another font in
front of them, and the system fonts stay behind them as fallbacks (`styles/index.css`, `--font-sans`,
`--font-mono`; `@font-face` near the top of the file).

| File | Font | Version | Source | sha256 |
|---|---|---|---|---|
| `Pretendard-Regular.woff2` | Pretendard Regular (400) | 1.3.9 | npm `pretendard@1.3.9`, `dist/web/static/woff2/` (by the font's author, [orioncactus/pretendard](https://github.com/orioncactus/pretendard)) | `fad853f7f47c6c8b103171e7193fa095708cdcd70850a71d93aa5379e8a61d63` |
| `Pretendard-Medium.woff2` | Pretendard Medium (500) | 1.3.9 | the same | `d03481330eeba0659ab5b87f25ceb504a35de377dd90a0d0aba2982eb2d05e2c` |
| `Pretendard-SemiBold.woff2` | Pretendard SemiBold (600) | 1.3.9 | the same | `c863f76a7de5c1ddc1ed8b2fa794964530774592c4f31407a84e2a2ae93f17f0` |
| `D2Coding.woff2` | D2Coding Regular | 1.4.0 | [naver/d2codingfont](https://github.com/naver/d2codingfont) release `VER1.4.0`, `D2Coding/D2Coding-Ver1.4.0-20261003.ttf`, converted to WOFF2 with fontTools (no glyph or table changes) | `fcffce2a9fc5dc2183e7964d36658a6b93cfa9b513364ea8aa80643b0eb6ef05` |

Pretendard comes as the three weights the UI uses (400, and `--font-weight-medium` and
`--font-weight-semibold` in `styles/index.css`); a bold 700 takes the SemiBold. They are static files,
not `PretendardVariable.woff2`: WebKit on Linux (WebKitGTK, and Playwright's WebKit in CI) lays out
text in the variable font about seven times slower than in a static one, with or without an HVAR
table, and that kept the main thread busy enough to fail e2e scenarios there (#746). The three files
weigh about as much as the one variable file. A new weight in the UI needs its own file here.

D2Coding has no bold file here: bold code (rare in this UI) is synthesized by the browser.

## Licence

Both are under the **SIL Open Font License 1.1**: [OFL-Pretendard.txt](OFL-Pretendard.txt) and
[OFL-D2Coding.txt](OFL-D2Coding.txt). The licence notice is also inside each font file (name
records 13 and 14), so it travels with the file into the built app. The Reserved Font Names
(Pretendard; D2Coding, D2Coding-Bold) stay with the unmodified fonts.

## Updating

Replace the files, keep the names, update the version and sha256 above and the licence file if it
changed. For D2Coding: `python3 -c "from fontTools.ttLib import TTFont; f=TTFont('D2Coding-….ttf'); f.flavor='woff2'; f.save('D2Coding.woff2')"` (needs `brotli`).
