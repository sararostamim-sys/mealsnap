// src/components/BarcodeScanner.tsx
'use client';
import { useEffect, useRef } from 'react';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { DecodeHintType, BarcodeFormat, Result } from '@zxing/library';

export default function BarcodeScanner({
  onDetected,
  onError,
}: {
  onDetected: (code: string) => void;
  onError?: (msg: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastAtRef = useRef<number>(0);

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

        // Prefer back camera when we can
        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        const back = devices.find((d) => /back|rear|environment/i.test(d.label)) ?? devices[0];

        controlsRef.current = await reader.decodeFromVideoDevice(
          back?.deviceId ?? null,
          videoRef.current!,
          (result?: Result) => {
            if (!result) return;
            const now = Date.now();
            if (now - lastAtRef.current < 1200) return; // debounce
            lastAtRef.current = now;
            onDetected(result.getText());
          }
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        onError?.(msg);
      }
    })();

    return () => {
      try {
        controlsRef.current?.stop();
        reader?.reset();
      } catch {
        // noop
      }
    };
  }, [onDetected, onError]);

  return <video ref={videoRef} className="w-full rounded border" muted playsInline />;
}

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