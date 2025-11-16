import fs from 'fs';
import path from 'path';
import https from 'https';

const outDir = path.resolve('public', 'tessdata');
const outFile = path.join(outDir, 'eng.traineddata');
const url = 'https://tessdata.projectnaptha.com/4.0.0_best/eng.traineddata';

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function download(url, to) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(to);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download: ${url} (${res.statusCode})`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

(async () => {
  try {
    ensureDir(outDir);
    if (fs.existsSync(outFile)) {
      console.log('[tessdata] eng.traineddata already present');
      return;
    }
    console.log('[tessdata] downloading eng.traineddata...');
    await download(url, outFile);
    console.log('[tessdata] downloaded to public/tessdata/eng.traineddata');
  } catch (e) {
    console.warn('[tessdata] download failed, OCR will fall back to remote langPath:', String(e));
  }
})();