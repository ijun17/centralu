import { useState } from 'react'
import { Modal } from '../../components/Modal.jsx'

/** A thumbnail-plus-zoom pair — an agent image (#40) and a user attachment use the same zoom */
export function ZoomableImage({
  src,
  alt,
  thumbClassName,
  onError,
  onLoad,
}: {
  src: string
  alt: string
  thumbClassName: string
  onError?: () => void
  /** The loaded thumbnail, for the one that loads and has no size */
  onLoad?: (img: HTMLImageElement) => void
}) {
  const [zoom, setZoom] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setZoom(true)} title={alt} className="block cursor-zoom-in">
        <img src={src} alt={alt} className={thumbClassName} onError={onError} onLoad={onLoad && ((e) => onLoad(e.currentTarget))} />
      </button>
      {zoom && (
        <Modal onClose={() => setZoom(false)} testId="image-lightbox">
          {/* vh/vw know nothing about zoom — the same correction as every other modal
          (index.css --text-zoom) */}
          <img
            src={src}
            alt={alt}
            className="max-h-[calc(90vh/var(--text-zoom))] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-line"
          />
        </Modal>
      )}
    </>
  )
}
