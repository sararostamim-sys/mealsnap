// next.config.ts

const nextConfig = {
  serverExternalPackages: ['sharp', 'tesseract.js', 'tesseract.js-core'],

  outputFileTracingIncludes: {
    '/api/ocr': [
      // Tesseract worker + core
      'node_modules/tesseract.js/src/worker-script/node/index.js',
      'node_modules/tesseract.js-core/tesseract-core.wasm.js',
      'node_modules/tesseract.js-core/tesseract-core.wasm',

      // Language data
      'public/tessdata/*.traineddata*',
    ],
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
webpack(config: any, { isServer }: { isServer: boolean }) {
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