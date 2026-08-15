import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 에이전트 응답 렌더링.
 *
 * 스트리밍 중에는 마크다운이 **미완성 상태로 들어온다** (열린 코드펜스, 잘린 링크).
 * react-markdown은 그런 입력도 던지지 않고 부분 렌더하므로 그대로 쓴다.
 *
 * 스타일은 무채색 규칙을 따른다 — 코드·인용은 색이 아니라 배경 밝기와 여백으로 구분한다.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="cc-md max-w-[80ch] text-chalk/90" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 링크는 새 창으로 (앱 안에서 이동하면 세션이 날아간다)
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
