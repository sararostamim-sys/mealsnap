import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['sharp', 'tesseract.js', 'tesseract.js-core'],
  outputFileTracingIncludes: {
    '/api/ocr': [
      'node_modules/tesseract.js/dist/worker.min.js',
      'node_modules/tesseract.js-core/tesseract-core.wasm.js',
    ],
  },
};

export default nextConfig;
