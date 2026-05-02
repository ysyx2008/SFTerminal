#!/usr/bin/env node

/**
 * 图标生成脚本
 * 
 * 从源 logo.png 生成所有平台所需的图标文件：
 * - macOS: icon.icns (通过 iconset)
 * - Windows: icon.ico
 * - Linux/通用: 各尺寸 PNG
 * 
 * 用法: node scripts/generate-icons.js [源图片路径]
 * 默认源图片: resources/logo.png
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message) {
  log(`✓ ${message}`, 'green');
}

function warn(message) {
  log(`⚠ ${message}`, 'yellow');
}

function error(message) {
  log(`✗ ${message}`, 'red');
}

function execSilent(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    return null;
  }
}

function exec(command, silent = false) {
  if (!silent) {
    log(`  $ ${command}`, 'blue');
  }
  try {
    execSync(command, { stdio: silent ? 'pipe' : 'inherit' });
    return true;
  } catch (e) {
    return false;
  }
}

function getImageSize(imagePath) {
  const width = execSilent(`sips -g pixelWidth "${imagePath}" | tail -1 | awk '{print $2}'`);
  const height = execSilent(`sips -g pixelHeight "${imagePath}" | tail -1 | awk '{print $2}'`);
  return {
    width: parseInt(width, 10),
    height: parseInt(height, 10),
  };
}

function checkImageMagick() {
  return execSilent('which magick') !== null || execSilent('which convert') !== null;
}

function getMagickCmd() {
  return execSilent('which magick') !== null ? 'magick' : 'convert';
}

function checkPlatform() {
  return process.platform;
}

async function main() {
  log('\n========================================', 'cyan');
  log('     图标生成工具', 'cyan');
  log('========================================\n', 'cyan');

  const projectRoot = path.resolve(__dirname, '..');
  const resourcesDir = path.join(projectRoot, 'resources');
  const iconsetDir = path.join(resourcesDir, 'icon.iconset');

  // 获取源图片路径，默认使用 resources/logo.png
  const sourceLogo = process.argv[2] || path.join(resourcesDir, 'logo.png');

  // 检查源图片是否存在
  if (!fs.existsSync(sourceLogo)) {
    error(`源图片不存在: ${sourceLogo}`);
    log('\n用法: node scripts/generate-icons.js [源图片路径]');
    log('默认源图片: resources/logo.png\n');
    process.exit(1);
  }

  log(`源图片: ${sourceLogo}`);

  // 检查图片尺寸
  const size = getImageSize(sourceLogo);
  log(`图片尺寸: ${size.width} x ${size.height}`);

  if (size.width !== size.height) {
    error('源图片必须是正方形!');
    process.exit(1);
  }

  if (size.width < 1024) {
    warn(`图片尺寸 (${size.width}px) 小于推荐的 1024px，可能影响显示效果`);
  } else {
    success('图片尺寸符合要求');
  }

  const platform = checkPlatform();
  const hasImageMagick = checkImageMagick();

  log(`\n当前平台: ${platform}`);
  log(`ImageMagick: ${hasImageMagick ? '已安装' : '未安装'}`);

  // 确保 iconset 目录存在
  if (!fs.existsSync(iconsetDir)) {
    fs.mkdirSync(iconsetDir, { recursive: true });
  }

  // ========================================
  // 生成 macOS iconset
  // ========================================
  log('\n生成 macOS iconset...', 'cyan');

  const iconsetSizes = [
    { size: 16, name: 'icon_16x16.png' },
    { size: 32, name: 'icon_16x16@2x.png' },
    { size: 32, name: 'icon_32x32.png' },
    { size: 64, name: 'icon_32x32@2x.png' },
    { size: 128, name: 'icon_128x128.png' },
    { size: 256, name: 'icon_128x128@2x.png' },
    { size: 256, name: 'icon_256x256.png' },
    { size: 512, name: 'icon_256x256@2x.png' },
    { size: 512, name: 'icon_512x512.png' },
    { size: 1024, name: 'icon_512x512@2x.png' },
  ];

  for (const { size, name } of iconsetSizes) {
    const outputPath = path.join(iconsetDir, name);
    exec(`sips -z ${size} ${size} "${sourceLogo}" --out "${outputPath}"`, true);
  }
  success(`已生成 ${iconsetSizes.length} 个 iconset 图标`);

  // ========================================
  // 生成 .icns (仅 macOS)
  // ========================================
  if (platform === 'darwin') {
    log('\n生成 macOS icon.icns...', 'cyan');
    const icnsPath = path.join(resourcesDir, 'icon.icns');
    if (exec(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`, true)) {
      success('已生成 icon.icns');
    } else {
      error('生成 icon.icns 失败');
    }
  } else {
    warn('跳过 .icns 生成 (需要在 macOS 上运行)');
  }

  // ========================================
  // 生成 Windows .ico
  // ========================================
  // Windows 与 macOS 图标设计规范不同：
  //   - macOS：系统会自动加圆角并要求图标本身留白（Apple HIG）
  //   - Windows：任务栏/桌面/文件管理器直接渲染 ICO，主流应用（VS Code/Chrome/Edge）
  //     都让图标几乎贴边，留白会显得"图标偏小"
  //
  // 因此 Windows ICO 单独处理：
  //   1) 先 trim 透明边距 → 获得"裸"图标内容
  //   2) 等比缩放到 contentRatio * size，居中放到 size x size 透明画布（约 4% 边距）
  //   3) 覆盖 100%-200% DPI 的所有任务栏/桌面尺寸（含 20/24/40/96，Win10/11 关键尺寸）
  //   4) 用 Lanczos 高质量缩放滤波，对小尺寸（≤64）额外做 unsharp 锐化避免软糊
  //   5) 合并为单个 ICO（256x256 用 PNG 压缩，其他尺寸用 BMP）
  log('\n生成 Windows icon.ico...', 'cyan');
  const icoPath = path.join(resourcesDir, 'icon.ico');

  if (hasImageMagick) {
    const magick = getMagickCmd();
    const tmpDir = path.join(resourcesDir, '.tmp-ico');
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });

    const trimmedPath = path.join(tmpDir, 'trimmed.png');
    if (!exec(`${magick} "${sourceLogo}" -background none -trim +repage "${trimmedPath}"`, true)) {
      error('trim 透明边距失败');
    }

    // Win10/11 任务栏 100%/125%/150%/175%/200% DPI 关键尺寸
    const winSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
    const contentRatio = 0.92; // 约 4% 边距，让图标贴边显示

    const pngFiles = [];
    let allOk = true;
    for (const size of winSizes) {
      const outPath = path.join(tmpDir, `icon_${String(size).padStart(3, '0')}.png`);
      const contentSize = Math.round(size * contentRatio);

      let cmd = `${magick} "${trimmedPath}" -filter Lanczos -resize "${contentSize}x${contentSize}"` +
                ` -background none -gravity center -extent "${size}x${size}"`;

      // 小尺寸做 unsharp 锐化，避免边缘模糊；强度需平衡，过强会引入彩色噪点
      if (size <= 20) {
        // 极小尺寸：温和锐化，避免噪点
        cmd += ' -unsharp 0x0.5+0.5+0.01';
      } else if (size <= 32) {
        cmd += ' -unsharp 0x0.6+0.7+0.008';
      } else if (size <= 64) {
        cmd += ' -unsharp 0x0.75+0.6+0.005';
      }

      cmd += ` "${outPath}"`;
      if (exec(cmd, true)) {
        pngFiles.push(outPath);
      } else {
        allOk = false;
      }
    }

    if (pngFiles.length > 0) {
      const pngList = pngFiles.map(p => `"${p}"`).join(' ');
      if (exec(`${magick} ${pngList} "${icoPath}"`, true)) {
        success(`已生成 icon.ico (${pngFiles.length} 个尺寸: ${winSizes.join(', ')})`);
        if (!allOk) {
          warn('部分尺寸生成失败，但 ICO 已写入');
        }
      } else {
        error('合并 ICO 失败');
      }
    } else {
      error('未生成任何尺寸的 PNG，跳过 ICO 合并');
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } else {
    // 尝试使用 png2ico (如果存在)
    const hasPng2ico = execSilent('which png2ico') !== null;
    if (hasPng2ico) {
      // 生成多尺寸临时 PNG
      const tmpDir = path.join(resourcesDir, '.tmp-ico');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      
      const icoSizes = [256, 128, 64, 48, 32, 16];
      for (const size of icoSizes) {
        exec(`sips -z ${size} ${size} "${sourceLogo}" --out "${tmpDir}/icon_${size}.png"`, true);
      }
      
      const pngFiles = icoSizes.map(s => `"${tmpDir}/icon_${s}.png"`).join(' ');
      if (exec(`png2ico "${icoPath}" ${pngFiles}`, true)) {
        success('已生成 icon.ico (使用 png2ico)');
      }
      
      // 清理临时目录
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } else {
      warn('未安装 ImageMagick 或 png2ico，跳过 .ico 生成');
      log('  安装方法: brew install imagemagick', 'yellow');
      log('  或使用在线工具: https://icoconvert.com/', 'yellow');
    }
  }

  // ========================================
  // 复制其他 PNG 文件
  // ========================================
  log('\n复制 PNG 图标文件...', 'cyan');

  const pngCopies = [
    { dest: 'icon.png', desc: '通用图标' },
    { dest: 'icon_1024.png', desc: '高分辨率图标' },
  ];

  for (const { dest, desc } of pngCopies) {
    const destPath = path.join(resourcesDir, dest);
    try {
      fs.copyFileSync(sourceLogo, destPath);
      success(`已复制 ${dest} (${desc})`);
    } catch (e) {
      error(`复制 ${dest} 失败: ${e.message}`);
    }
  }

  // ========================================
  // 总结
  // ========================================
  log('\n========================================', 'cyan');
  log('     生成完成!', 'green');
  log('========================================\n', 'cyan');

  log('已生成的文件:', 'cyan');
  log('  macOS:');
  log('    - resources/icon.icns');
  log('    - resources/icon.iconset/*.png');
  log('  Windows:');
  log('    - resources/icon.ico');
  log('  Linux/通用:');
  log('    - resources/icon.png');
  log('    - resources/icon_1024.png');

  if (!hasImageMagick && platform !== 'darwin') {
    log('\n注意事项:', 'yellow');
    log('  - Windows .ico 文件可能未生成，请手动创建或安装 ImageMagick');
  }

  if (platform !== 'darwin') {
    log('\n注意事项:', 'yellow');
    log('  - macOS .icns 文件需要在 macOS 上生成');
  }

  log('\n提示: 运行 npm run build 来验证图标是否正确打包\n');
}

main().catch((e) => {
  error(`脚本执行失败: ${e.message}`);
  process.exit(1);
});

