# File Search Service SPEC

> Last verified: 2026-05-07

## 职责

跨平台文件搜索调度。根据操作系统自动选择最优搜索引擎（macOS Spotlight / Windows Everything / Linux locate / fd 降级），提供统一搜索接口。核心价值是屏蔽底层差异，让调用方只需传入关键词即可获得结果。

## 文件 / 规模

单文件：`electron/services/file-search.service.ts`（~898 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `async search(options: FileSearchOptions): Promise<FileSearchResult[]>` | 执行文件搜索（自动选择最优后端） | `agent/tools/file.ts` |
| `buildSpotlightArgs(query, searchPath?, type?): {args[], hasWildcard, typeFilter}` | 构建 macOS Spotlight 搜索参数 | 单元测试 |
| `async getBackendInfo(): Promise<{platform, backend, available}>` | 返回当前平台和搜索引擎信息 | 调试 UI |
| `cleanup(): void` | 清理外部进程（Windows Everything） | 应用退出 |

## 核心类型 / 接口

### FileSearchOptions（查询参数）
```ts
interface FileSearchOptions {
  query: string                    // 搜索关键词（支持空格 AND 逻辑）
  searchPath?: string              // 限制搜索目录
  type?: "file" | "dir" | "all"   // 文件类型过滤
  limit?: number                   // 返回数量上限
  caseSensitive?: boolean          // 是否区分大小写
}
```

### FileSearchResult
```ts
interface FileSearchResult {
  path: string, name: string
  isDirectory: boolean
  size?: number, modifiedTime?: number
  createdTime?: number
}
```

### SearchBackend
```ts
type SearchBackend = "spotlight" | "everything" | "locate" | "fd" | "native"
```

## 依赖（跨 service）

无跨 service 依赖。仅依赖系统搜索引擎（Spotlight / Everything / locate / fd）。

## 关键行为 / 数据流

**后端选择策略**：
1. macOS → Spotlight（通过 `mdfind`）
2. Windows → Everything SDK（通过 CLI，需确保后台运行）
3. Linux → `plocate` / `locate`（检测可用性降级）
4. 通用降级 → `fd`（需已安装）
5. 最终兜底 → Node.js 原生递归遍历（`searchNative`）

**搜索优化**：
- Spotlight：关键词自动转义特殊字符
- Everything：连接外部进程，通过 IPC 查询
- 全局：结果在应用层做文件名二次匹配（关键词 AND 逻辑）

## 关键约束

- **不得暴露底层搜索引擎差异给调用方**——所有后端统一返回 `FileSearchResult[]`
- **Spotlight 查询中的特殊字符必须转义**（`escapeSpotlightQuery`）
- **Everything 进程用完后必须通过 `cleanup()` 关闭**，严禁泄漏
- **兜底搜索（`searchNative`）仅在无其他可用后端时使用**——性能极差，仅保底
