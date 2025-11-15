import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['sharp', 'tesseract.js', 'tesseract.js-core'],

  outputFileTracingIncludes: {
    '/api/ocr': [
      // Tesseract worker + core
      'node_modules/tesseract.js/src/worker-script/node/index.js',
      'node_modules/tesseract.js-core/tesseract-core.wasm.js',
      'node_modules/tesseract.js-core/tesseract-core.wasm',   // ← add the binary too

      // Language data (use a glob so future langs/gz are picked up)
      'public/tessdata/*.traineddata*',                        // ← was eng.traineddata
    ],
  },

  webpack(config, { isServer }) {
    if (isServer) {
      config.ignoreWarnings = config.ignoreWarnings || [];
      // Silence the benign dynamic-require warning from tesseract.js
      config.ignoreWarnings.push(
        /Critical dependency: the request of a dependency is an expression/i
      );
    }
    return config;
  },
};

export default nextConfig;