import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录 package.json 的版本号，供 GitHub API 失败时的展示与下载链接回退 */
export function readRootPackageVersion(): string {
  try {
    const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
    const pkgPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    const v = pkg.version?.trim();
    return v && /^\d+\.\d+\.\d+/.test(v) ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
