# File type icons

Source: [vscode-icons](https://github.com/vscode-icons/vscode-icons) — **MIT licence**.
Only the ones actually used are pulled from `icons/*.svg` (the full set is over 1,200 icons, with no reason to ship all of them in the app).

## Updating

When adding an extension to the table in `fileIcon.ts`, if there is no matching svg yet, fetch it from the same repository and place it in this folder:

```
https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons/<name>.svg
```

An extension missing from the table falls back to `default_file.svg`, so leaving one out never results in a blank icon.

## LICENSE (vscode-icons)

```
The MIT License (MIT)

Copyright (c) 2016 Roberto Huertas

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```
