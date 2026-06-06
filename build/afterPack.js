const fs = require('fs');
const path = require('path');

const gpuFallbackFiles = [
  'dxcompiler.dll',
  'dxil.dll',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll'
];

function removeIfExists(file) {
  if (!fs.existsSync(file)) {
    return 0;
  }
  const size = fs.statSync(file).size;
  fs.rmSync(file, { force: true });
  return size;
}

exports.default = async function afterPack(context) {
  if (process.env.MEMGUARD_KEEP_GPU_FALLBACKS === '1') {
    console.log('MemGuard afterPack: keeping GPU fallback files by env request.');
    return;
  }

  let savedBytes = 0;
  const removed = [];
  for (const name of gpuFallbackFiles) {
    const file = path.join(context.appOutDir, name);
    const size = removeIfExists(file);
    if (size > 0) {
      savedBytes += size;
      removed.push(name);
    }
  }

  if (removed.length) {
    const savedMB = Math.round((savedBytes / 1024 / 1024) * 10) / 10;
    console.log(`MemGuard afterPack: removed ${removed.join(', ')} (${savedMB} MB).`);
  }
};
