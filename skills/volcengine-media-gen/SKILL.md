---
name: 火山引擎多媒体生成
description: 通过火山引擎（方舟）API 调用 Seedream（文生图）和 Seedance（视频生成）模型，支持图片生成、视频生成及任务状态查询。图片生成后自动下载到本地。
version: "1.3.0"
enabled: true
metadata:
  {
    "openclaw": {
      "requires": {
        "env": ["VOLC_API_KEY"],
        "bins": ["python3", "pip3"]
      },
      "install": [
        {
          "id": "pip-deps",
          "kind": "python",
          "package": "httpx",
          "label": "Install Python dependencies"
        }
      ]
    }
  }
---

# 火山引擎多媒体生成技能

通过火山引擎（方舟）API 调用豆包系列多媒体生成模型。

## 环境变量

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `VOLC_API_KEY` | 是 | 火山引擎方舟 API Key |

## 模型列表

| 模型 | 能力 | 模型 ID |
|------|------|---------|
| Seedream 5.0 | 文生图 | `doubao-seedream-5-0-260128` |
| Seedance 2.0 | 文生视频 / 图生视频 | `doubao-seedance-2-0-260128` |
| Seedance 2.0 Fast | 快速视频生成 | `doubao-seedance-2-0-fast-260128` |
| Hyper3D Gen2 | 3D 模型生成 | `hyper3d-gen2-260112` |
| HiTemp3D 2.0 | 3D 内容生成 | `hitem3d-2-0-251223` |

## API 基础信息

- **Base URL**: `https://ark.cn-beijing.volces.com/api/v3`
- **鉴权**: Header `Authorization: Bearer <VOLC_API_KEY>`

---

## 一、图片生成（Seedream）

使用 OpenAI 标准的 `/v1/images/generations` 端点。

### Endpoint

```
POST https://ark.cn-beijing.volces.com/api/v3/images/generations
```

### 请求体

```json
{
  "model": "doubao-seedream-5-0-260128",
  "prompt": "赛博朋克城市夜景，霓虹灯，雨夜，电影感",
  "n": 1
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 模型 ID |
| prompt | string | 是 | 图片描述 |
| n | int | 否 | 生成数量，默认 1 |
| size | string | 否 | 分辨率，如 `1440x2560`。不传则默认 1:1。**最小面积 3,686,400 像素**（例如 1440×2560 是满足 9:16 的最小尺寸） |

### 响应

```json
{
  "created": 1234567890,
  "data": [
    {
      "revised_prompt": "...",
      "url": "https://...png"
    }
  ]
}
```

---

## 二、视频生成（Seedance）

异步任务模式：创建任务 → 轮询查询结果。

### 2.1 创建视频生成任务

```
POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
```

#### 文生视频

```json
{
  "model": "doubao-seedance-2-0-260128",
  "content": [
    {
      "type": "text",
      "text": "电影镜头，夕阳下的海滩，海浪轻轻拍打沙滩，温暖的光线，慢动作"
    }
  ],
  "parameters": {
    "duration": 5,
    "resolution": "720P"
  }
}
```

#### 图生视频

```json
{
  "model": "doubao-seedance-2-0-260128",
  "content": [
    {
      "type": "text",
      "text": "镜头缓慢推进，风吹动头发，电影感"
    },
    {
      "type": "image_url",
      "image_url": {
        "url": "https://example.com/input.jpg"
      }
    }
  ],
  "parameters": {
    "duration": 5,
    "resolution": "720P"
  }
}
```

#### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 模型 ID |
| content | array | 是 | 输入内容，支持 text / image_url 类型 |
| parameters.duration | int | 否 | 视频时长（秒），默认 5，最长 15 |
| parameters.resolution | string | 否 | 分辨率，可选 `720P`、`1080P` |

#### 响应

```json
{
  "id": "cgt-xxxxxxxxxxxxx",
  "status": "running",
  "created_at": 1234567890
}
```

### 2.2 查询任务状态

```
GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{task_id}
```

#### 响应（运行中）

```json
{
  "id": "cgt-xxxxxxxxxxxxx",
  "model": "doubao-seedance-2-0-260128",
  "status": "running",
  "created_at": 1234567890,
  "updated_at": 1234567890,
  "service_tier": "default",
  "generate_audio": true,
  "draft": false,
  "priority": 0
}
```

#### 响应（已完成）

```json
{
  "id": "cgt-xxxxxxxxxxxxx",
  "model": "doubao-seedance-2-0-260128",
  "status": "succeeded",
  "output": {
    "results": [
      {
        "video_url": "https://...mp4",
        "duration": 5.0
      }
    ]
  },
  "created_at": 1234567890,
  "updated_at": 1234567890,
  "finished_at": 1234567890
}
```

状态值：`running` → `succeeded` / `failed`

---

## 三、实战技巧（Seedream 文生图）

### 3.1 分辨率选择

`size` 参数有**最小面积限制**：宽 × 高 ≥ 3,686,400 像素。

| 比例 | 推荐尺寸 | 面积 | 适用场景 |
|------|----------|------|----------|
| 1:1 | 1920×1920 | 3,686,400 | 默认/头像/封面 |
| 9:16 | 1440×2560 | 3,686,400 | 竖屏手机海报/朋友圈 |
| 16:9 | 2560×1440 | 3,686,400 | 横屏Banner/PPT |

⚠️ `1080x1920`（207万像素）面积不足，会直接报错。

### 3.2 在图中生成清晰中文文字

Seedream 5.0 支持中文，但**效果不稳定**，遵循以下技巧可大幅提升成功率：

**prompt 写法**
- 明确约束文字区域：`solid dark navy blue banner strip across the bottom`
- 强调可读性：`clean white Chinese text "...", text must be sharp and clearly readable`
- 精简 prompt 中文字总量，避免与要渲染的文字互相干扰
- 英文 prompt 比纯中文 prompt 对文字控制力更强

**示例（企业节气海报）**
```
Top: large golden calligraphy text "芒种" against soft morning sky.
Middle: golden wheat ears, green rice paddies, distant misty mountains.
Bottom: solid dark navy blue banner strip across full width,
clean white Chinese text "国元证券 金融科技部", text sharp and readable.
```

**效果预期**
- 4-6 个汉字的短句成功率较高（如落款、标题）
- 长句、复杂排版容易乱码，建议控制字数
- 如果一次不满意，可换 prompt 措辞重试 1-2 次

---

## 四、Python 调用示例

```python
import requests
import time
import os

BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
API_KEY = os.environ["VOLC_API_KEY"]
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

# --- 图片生成 ---
def generate_image(prompt: str, model: str = "doubao-seedream-5-0-260128") -> str:
    """生成图片，返回图片 URL（临时链接，24h 有效）"""
    resp = requests.post(
        f"{BASE_URL}/images/generations",
        headers=HEADERS,
        json={
            "model": model,
            "prompt": prompt,
            "n": 1
        }
    )
    return resp.json()["data"][0]["url"]

def generate_image_to_local(prompt: str, filename: str = None,
                            model: str = "doubao-seedream-5-0-260128",
                            save_dir: str = None) -> str:
    """生成图片并自动下载到本地，返回本地文件绝对路径。
    
    Args:
        prompt: 图片描述
        filename: 保存文件名（不含扩展名），默认用时间戳
        model: 模型 ID
        save_dir: 保存目录，默认 agent-workspace
    """
    import uuid
    from pathlib import Path

    # 获取图片 URL
    url = generate_image(prompt, model)

    # 确定保存路径
    if save_dir is None:
        save_dir = os.path.expanduser(
            "~/Library/Application Support/SFTerm/agent-workspace"
        )
    Path(save_dir).mkdir(parents=True, exist_ok=True)

    if filename is None:
        filename = f"seedream_{uuid.uuid4().hex[:8]}"
    save_path = Path(save_dir) / f"{filename}.png"

    # 下载图片
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    save_path.write_bytes(r.content)

    return str(save_path.resolve())

# 使用示例：
# url  = generate_image("赛博朋克城市夜景")
# path = generate_image_to_local("赛博朋克城市夜景", filename="cyberpunk")
# 生成后通过 read_file(path) 直接展示给用户

# --- 视频生成 ---
def create_video_task(prompt: str, image_url: str = None,
                      model: str = "doubao-seedance-2-0-260128",
                      duration: int = 5) -> str:
    """创建视频生成任务，返回 task_id"""
    content = [{"type": "text", "text": prompt}]
    if image_url:
        content.append({"type": "image_url", "image_url": {"url": image_url}})

    resp = requests.post(
        f"{BASE_URL}/contents/generations/tasks",
        headers=HEADERS,
        json={
            "model": model,
            "content": content,
            "parameters": {
                "duration": duration,
                "resolution": "720P"
            }
        }
    )
    return resp.json()["id"]

def query_task(task_id: str) -> dict:
    """查询任务状态"""
    resp = requests.get(
        f"{BASE_URL}/contents/generations/tasks/{task_id}",
        headers=HEADERS
    )
    return resp.json()

def wait_for_video(task_id: str, poll_interval: int = 10, timeout: int = 600) -> str:
    """轮询等待视频生成完成，返回视频 URL"""
    start = time.time()
    while time.time() - start < timeout:
        result = query_task(task_id)
        status = result.get("status")
        if status == "succeeded":
            return result.get("output", {}).get("results", [{}])[0].get("video_url")
        elif status == "failed":
            raise Exception(f"视频生成失败: {result}")
        print(f"  ⏳ 正在生成... ({int(time.time() - start)}s)")
        time.sleep(poll_interval)
    raise TimeoutError("视频生成超时")
```

## 五、curl 快速测试

```bash
# 图片生成
curl -X POST "https://ark.cn-beijing.volces.com/api/v3/images/generations" \
  -H "Authorization: Bearer $VOLC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "doubao-seedream-5-0-260128",
    "prompt": "一只可爱的熊猫，高清，电影感"
  }'

# 创建视频任务
curl -X POST "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" \
  -H "Authorization: Bearer $VOLC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "doubao-seedance-2-0-260128",
    "content": [{"type":"text","text":"夕阳海滩，海浪轻拍，慢动作"}],
    "parameters": {"duration":5, "resolution":"720P"}
  }'

# 查询视频任务
curl "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{task_id}" \
  -H "Authorization: Bearer $VOLC_API_KEY"
```