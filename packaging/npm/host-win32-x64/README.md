# @centralu/host-win32-x64

The host of [Centralu](https://github.com/ijun17/centralu) for Windows on x86-64, without the window:
the folder `centralu serve` runs. A Centralu on another computer installs it here over ssh, beside the
`centralu` package, when it links this machine (remote mode). It is the same host the app package
`@centralu/win32-x64` carries in `Centralu\resources\host\`.

**Do not install this directly.** To use Centralu on this machine, install the app:

```bash
npm i -g centralu
```
