import { PlayIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'

/**
 * 자주 쓰는 명령어 여는 버튼 (issue #44 → #60에서 창으로 확장).
 *
 * 열림 상태를 칸(pane)이 드는 이유는 그대로다: 그리드에서 이 헤더는 칸을 옮기는
 * 손잡이(`draggable`)라, 창이 열려 있는 동안 끌기를 꺼야 한다.
 *
 * 목록·등록·실행·로그는 전부 CommandRunnerOverlay로 옮겨 갔다 — 헤더의 작은
 * 팝오버로는 로그를 볼 자리가 없었다 (#60). 여기 남은 것은 여는 버튼뿐이다.
 */
export function RunMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <IconButton
      label="Saved commands — run with live logs"
      onClick={() => onOpenChange(!open)}
      testId="run-open"
      align="right"
    >
      <PlayIcon />
    </IconButton>
  )
}
