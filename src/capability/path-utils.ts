import fs from 'node:fs';
import path from 'node:path';

/**
 * 规范化真实路径（处理软链接、.. 与大小写）
 * 若路径不存在，回溯寻找最近存在的祖先目录 realpath 后拼接剩余段
 */
export function resolveRealPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parts: string[] = [];
    let cur = resolved;
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      parts.unshift(path.basename(cur));
      cur = parent;
    }
    let realBase = cur;
    try {
      realBase = fs.realpathSync(cur);
    } catch {
      realBase = cur;
    }
    return parts.length > 0 ? path.join(realBase, ...parts) : realBase;
  }
}

/**
 * 路径包含判定：按路径段严格比对（/a/b 不包含 /a/bc）
 * 双方均做 realpath，杜绝符号链接逃逸与 .. 越界
 */
export function isPathContained(parentPath: string, childPath: string): boolean {
  const realParent = resolveRealPath(parentPath);
  const realChild = resolveRealPath(childPath);

  if (realParent === realChild) return true;
  if (realParent === path.sep) return true;

  const parentWithSep = realParent.endsWith(path.sep) ? realParent : realParent + path.sep;
  return realChild.startsWith(parentWithSep);
}
