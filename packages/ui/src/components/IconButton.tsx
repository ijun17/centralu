import type { ReactNode } from 'react'
import { Tooltip } from './primitives.jsx'

/**
 * 아이콘만 있는 버튼.
 *
 * 글자를 뺀 만큼 **무슨 버튼인지 물어볼 방법**이 있어야 한다. 브라우저 기본
 * title은 1~2초를 기다려야 뜨고 생김새도 앱과 따로 노는데, 아이콘 버튼처럼
 * "평소엔 자리를 안 주지만 물어보면 바로 답해야 하는" 것에는 그 지연이
 * 사실상 정보가 없는 것과 같다. 그래서 우리 툴팁을 쓴다 (마우스뿐 아니라
 * 포커스에도 뜬다 — 키보드로만 도는 사람에게도 같은 정보가 필요하다).
 *
 * 아이콘 버튼을 한 부품으로 모으는 이유: 하나씩 만들면 어떤 건 툴팁이 있고
 * 어떤 건 없는 상태가 된다. 실제로 그랬다.
 */
export function IconButton({
  label,
  onClick,
  children,
  testId,
  disabled,
  type = 'button',
  placement = 'bottom',
  align = 'left',
  className = '',
}: {
  /** 툴팁 문구이자 스크린리더가 읽는 이름 — 하나로 둔다 */
  label: string
  onClick?: () => void
  children: ReactNode
  testId?: string
  disabled?: boolean
  type?: 'button' | 'submit'
  placement?: 'bottom' | 'top'
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <Tooltip content={label} placement={placement} align={align}>
      <button
        type={type}
        className={`flex items-center justify-center rounded p-1 text-slate transition-colors hover:bg-graphite/60 hover:text-chalk disabled:opacity-40 ${className}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
      >
        {children}
      </button>
    </Tooltip>
  )
}
