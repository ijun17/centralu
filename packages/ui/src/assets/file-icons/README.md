# 파일 타입 아이콘

출처: [vscode-icons](https://github.com/vscode-icons/vscode-icons) — **MIT 라이선스**.
`icons/*.svg`에서 우리가 쓰는 것만 가져왔다 (전체는 1,200개가 넘어 앱에 다 넣을 이유가 없다).

## 갱신

`fileIcon.ts`의 표에 확장자를 추가할 때, 대응하는 svg가 없으면 같은 저장소에서 받아 이 폴더에 둔다:

```
https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons/<이름>.svg
```

표에 없는 확장자는 `default_file.svg`로 떨어지므로, 빠뜨려도 빈칸이 되지는 않는다.

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
