// src/components/BarcodeScanner.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { DecodeHintType, BarcodeFormat, Result } from '@zxing/library';

type Props = {
  onDetected: (code: string) => void;
  onError?: (msg: string) => void;
  /** Max rendered width of the preview (px). Keeps the scan box compact. */
  maxWidth?: number;
  /** Size of the inner guide box as a fraction of the preview (0–1). */
  boxFrac?: number;
  /** Show torch toggle if the camera supports it (default false). */
  showTorch?: boolean;
};

// Extend capabilities/constraints with an optional torch flag (no `any`)
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean };
type TorchConstraints = MediaTrackConstraints & { advanced?: TorchConstraintSet[] };

export default function BarcodeScanner({
  onDetected,
  onError,
  maxWidth = 380,
  boxFrac = 0.58,
  showTorch = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastAtRef = useRef<number>(0);

  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchCapable, setTorchCapable] = useState(false);

  // Defaults + clamping for overlay box
  const _maxW = typeof maxWidth === 'number' ? maxWidth : 360;
  const _frac = typeof boxFrac === 'number' ? boxFrac : 0.56;
  const frac = Math.min(0.95, Math.max(0.3, _frac));

  const boxW = Math.round(_maxW * frac);
  const boxH = Math.round(boxW * 0.66); // ~2:3 aspect

  useEffect(() => {
    let reader: BrowserMultiFormatReader | null = null;

    (async () => {
      try {
        const hints = new Map<DecodeHintType, unknown>();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128,
          BarcodeFormat.QR_CODE,
        ]);
        hints.set(DecodeHintType.TRY_HARDER, true);
        hints.set(DecodeHintType.ASSUME_GS1, true);

        reader = new BrowserMultiFormatReader(hints);

        // Prefer back camera when available
        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        const back =
          devices.find((d) => /back|rear|environment/i.test(d.label)) ?? devices[0];

        // Start decode loop
        controlsRef.current = await reader.decodeFromVideoDevice(
          back?.deviceId ?? null,
          videoRef.current!,
          (result?: Result | null) => {
            if (!result) return;
            const now = Date.now();
            if (now - lastAtRef.current < 1200) return; // debounce
            lastAtRef.current = now;
            onDetected(result.getText());
          }
        );

        // Grab the media track so we can expose torch if supported
        const el = videoRef.current;
        const stream = (el?.srcObject as MediaStream | null) ?? null;
        const track = stream?.getVideoTracks?.()[0] ?? null;
        trackRef.current = track;

        if (showTorch && track && typeof track.getCapabilities === 'function') {
          const caps = track.getCapabilities() as TorchCapabilities;
          if (caps.torch !== undefined) {
            setTorchCapable(true);
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        onError?.(msg);
      }
    })();

    return () => {
      try {
        // Stop ZXing decode loop
        controlsRef.current?.stop();

        const track = trackRef.current;

        // Try to turn torch off before stopping the track (no need for torchOn in deps)
        if (track && track.applyConstraints) {
          const off: TorchConstraints = { advanced: [{ torch: false }] };
          track.applyConstraints(off).catch(() => {
            /* ignore */
          });
        }

        // Stop the underlying MediaStreamTrack (camera)
        track?.stop?.();

        // Older ZXing path (noop if not present)
        type MaybeStop = { stopContinuousDecode?: () => void };
        (reader as unknown as MaybeStop)?.stopContinuousDecode?.();
      } catch {
        // noop
      }
    };
  }, [onDetected, onError, showTorch]);

  // Torch toggle handler
  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track || !track.applyConstraints) return;

    try {
      const caps = track.getCapabilities?.() as TorchCapabilities | undefined;
      if (!caps || caps.torch === undefined) return;

      const next = !torchOn;

      const constraints: TorchConstraints = {
        advanced: [{ torch: next }],
      };

      await track.applyConstraints(constraints);
      setTorchOn(next);
    } catch {
      // ignore if device refuses torch constraint
    }
  };

  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-xl"
      style={{ maxWidth: _maxW }}
    >
      <video
        ref={videoRef}
        className="block w-full h-auto object-cover"
        muted
        playsInline
      />

      {/* Overlay container – no page tint now */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {/* aim box */}
        <div
          className="rounded-lg border-2 border-white/90 shadow-[0_0_0_2px_rgba(0,0,0,0.35)_inset]"
          style={{
            width: boxW,
            height: boxH,
          }}
        />
        {/* helper label */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[11px] text-white/95 bg-black/60 px-2 py-1 rounded-full">
          Align the code inside the box
        </div>
      </div>

      {/* Torch button (outside pointer-events-none so it’s clickable) */}
      {showTorch && torchCapable ? (
        <button
          type="button"
          onClick={toggleTorch}
          className="absolute right-3 top-3 z-10 rounded-md bg-black/50 text-white text-xs px-2 py-1"
          aria-label={torchOn ? 'Turn torch off' : 'Turn torch on'}
        >
          {torchOn ? 'Torch Off' : 'Torch'}
        </button>
      ) : null}
    </div>
  );
}

/** File decode helper stays the same */
export async function decodeBarcodeFromFile(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('Image load failed'));
      img.src = url;
    });
    const hints = new Map<DecodeHintType, unknown>();
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints);
    const res = await reader.decodeFromImageElement(img);
    return res.getText();
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}