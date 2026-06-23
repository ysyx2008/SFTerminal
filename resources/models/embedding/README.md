# Embedding 模型

此目录存放知识库功能使用的 Embedding 模型。

## 轻量模型（随软件打包）

本地目录名仍为 `bge-small-zh-v1.5`（兼容旧路径）；模型来源为
[onnx-community/bge-small-zh-v1.5-ONNX](https://huggingface.co/onnx-community/bge-small-zh-v1.5-ONNX)（Transformers.js v4 / GPU 优化导出）。

下载脚本（构建前 / 开发机）：

```bash
node scripts/download-embedding-model.js
# 或
npm run download:models
```

### 手动下载

1. 访问 https://huggingface.co/onnx-community/bge-small-zh-v1.5-ONNX/tree/main
2. 下载以下文件到 `bge-small-zh-v1.5` 目录：
   - `config.json`
   - `tokenizer.json`
   - `tokenizer_config.json`
   - `onnx/model_quantized.onnx`
   - `onnx/model_quantized.onnx_data`（外部权重，必需）

### 目录结构

```
bge-small-zh-v1.5/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    ├── model_quantized.onnx
    └── model_quantized.onnx_data
```

## 其他模型

标准 / 高精模型使用 `onnx-community/bge-*-zh-v1.5-ONNX`，由用户按需下载到用户数据目录。
