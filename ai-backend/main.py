import os
from typing import Optional, List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from openai import OpenAI  # type: ignore
except Exception:  # 如果本地还没装 openai，避免导入阶段直接崩溃
    OpenAI = None  # type: ignore


# ========== 数据模型 ==========


class TextToDiagramRequest(BaseModel):
    prompt: str
    language: Optional[str] = "zh-CN"
    format: Optional[str] = "mermaid"


class MindmapRequest(BaseModel):
    prompt: str
    language: Optional[str] = "zh-CN"
    format: Optional[str] = "mermaid_mindmap"


class DiagramToCodeRequest(BaseModel):
    texts: Optional[List[str]] = None
    image: Optional[str] = None  # dataURL base64
    theme: Optional[str] = None


# ========== 应用初始化 ==========


app = FastAPI(title="Excalidraw AI Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========== OpenAI 兼容客户端封装 ==========


def _get_openai_client():
    if OpenAI is None:
        raise RuntimeError("OpenAI SDK 未安装，请先安装 `openai` 包")

    base_url = os.getenv("AI_UPSTREAM_BASE_URL")
    api_key = os.getenv("AI_UPSTREAM_API_KEY")
    if not base_url or not api_key:
        raise RuntimeError(
            "AI_UPSTREAM_BASE_URL / AI_UPSTREAM_API_KEY 未配置，请在环境变量中设置",
        )

    return OpenAI(base_url=base_url, api_key=api_key)  # type: ignore


def _build_system_prompt(mode: str) -> str:
    if mode == "mindmap":
        return (
            "你是一名专业的思维导图助手，使用 Mermaid 的 mindmap 语法生成结构清晰的『分支型思维导图』。\n"
            "严格要求：\n"
            "1. 只输出 Mermaid mindmap 代码，不要任何解释文字。\n"
            "2. 第一行必须是 mindmap。\n"
            "3. 第二行是根节点，使用用户需求概括为一个简短主题，例如 `  主题((产品设计))`。\n"
            "4. 为根节点生成 3~6 个一级分支，每个一级分支下有 2~4 个子节点，必要时可以增加第三层。\n"
            "5. 所有节点文本使用短词或短句（3~10 个字），不要长段落或多句句子。\n"
            "6. 只输出一个 ```mermaid 代码块，代码块内部只包含 mindmap 定义，不要 markdown 标题、列表或额外说明。\n"
        )

    # 默认 text-to-diagram 场景
    return (
        "# 角色\n"
        "你是一位精通 Mermaid 语法的图表生成专家。\n\n"
        "# 工作流程\n"
        "1. **分析需求**：深入理解我提供的文本描述，识别出核心的实体、关系和流程。\n"
        "2. **选择图表类型**：根据我的需求，智能选择最合适的图表类型，如流程图 (`flowchart`)、时序图 (`sequenceDiagram`)、类图 (`classDiagram`)、状态图 (`stateDiagramV2`) 或实体关系图 (`erDiagram`) 等。如果需求不明确，优先选择流程图 (`flowchart`)。\n"
        "3. **构建图表**：\n"
        "    *   使用简洁明确的文字来命名节点。\n"
        "    *   确保实体间的连接关系和流向准确无误。\n"
        "    *   如果内容复杂，使用 `subgraph` 来组织和划分模块，使结构更清晰。\n"
        "4. **美化与增强**：\n"
        "    *   默认使用从上到下 (`TD`) 的布局。\n"
        "    *   根据节点的重要性或类型，使用不同的形状（例如，用 `([体育场形])` 表示开始/结束，用 `{菱形}` 表示判断，用 `[(数据库)]` 表示数据存储）。\n"
        "    *   使用 `classDef` 定义至少两种样式（例如，`primary` 用于核心节点，`secondary` 用于辅助节点），并用 `class` 将样式应用到节点上，以增强视觉区分度。\n\n"
        "# 输出要求\n"
        "*   **只输出**一个 ```mermaid 代码块。\n"
        "*   **不要**包含任何解释、介绍、总结或任何非 Mermaid 语法的文本。\n"
        "*   代码必须是完整且语法正确的。\n"
    )


def _build_mindmap_tree_system_prompt() -> str:
    """构造用于生成 XMind 风格树形 JSON 的 system prompt。"""

    return (
        "你是一名专业的思维导图助手，负责根据用户的需求生成 XMind 风格的思维导图数据。\n"
        "现在不再需要 Mermaid 代码，你必须只输出严格的 JSON。\n"
        "JSON 结构要求如下（字段名固定为英文）：\n"
        "{\n"
        "  \"topic\": \"中心主题\",\n"
        "  \"children\": [\n"
        "    {\n"
        "      \"topic\": \"分支主题 1\",\n"
        "      \"children\": [\n"
        "        { \"topic\": \"子主题 1-1\" },\n"
        "        { \"topic\": \"子主题 1-2\" }\n"
        "      ]\n"
        "    },\n"
        "    {\n"
        "      \"topic\": \"分支主题 2\"\n"
        "    }\n"
        "  ]\n"
        "}\n"
        "具体生成规则：\n"
        "1. 整体必须是一个 JSON 对象，根节点包含 topic 和可选 children 字段。\n"
        "2. 根节点 topic 使用用户需求概括为一个简短主题（3~10 个汉字）。\n"
        "3. 为根节点生成 3~6 个一级分支（children 数组中的元素），每个一级分支包含 2~4 个子主题。\n"
        "4. 在必要时可以为部分子主题再增加一层 children，但整个树的最大深度不超过 3 层。\n"
        "5. 所有 topic 文本必须是 3~10 个字的短语，不要长段落或多个句子。\n"
        "6. 不要在 JSON 外围添加任何说明文字、注释或 Markdown，只能返回一段合法 JSON。\n"
    )


def _extract_mermaid(content: str) -> str:
    """从大模型返回的文本中提取 ```mermaid 代码块，如果不存在则返回全文。"""

    content = content or ""
    if "```" not in content:
        return content.strip()

    lines: List[str] = []
    in_block = False
    for line in content.splitlines():
        striped = line.strip()
        if striped.startswith("```"):
            # 第一次遇到 ```mermaid，进入代码块；第二次遇到 ```，结束
            if not in_block:
                in_block = True
                continue
            else:
                break
        if in_block:
            lines.append(line)
    if lines:
        return "\n".join(lines).strip()
    return content.strip()


def _extract_json(content: str) -> str:
    """从大模型返回的文本中提取 JSON 字符串。

    为了兼容模型偶尔在前后添加说明文字的情况，这里会尝试从第一个
    "{" 到最后一个 "}" 之间截取子串。如果找不到成对的大括号，则
    直接返回原始内容的去首尾空白版本。
    """

    content = content or ""
    start = content.find("{")
    end = content.rfind("}")
    if start != -1 and end != -1 and end > start:
        return content[start : end + 1].strip()
    return content.strip()


def _generate_mermaid(prompt: str, *, mode: str) -> str:
    client = _get_openai_client()
    model = os.getenv("AI_UPSTREAM_MODEL", "gpt-4.1")

    try:
        resp = client.chat.completions.create(  # type: ignore
            model=model,
            messages=[
                {"role": "system", "content": _build_system_prompt(mode)},

                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"上游 AI 调用失败: {e}")

    content = resp.choices[0].message.content or ""
    mermaid_code = _extract_mermaid(content)
    if not mermaid_code:
        raise HTTPException(status_code=500, detail="生成结果为空")
    return mermaid_code


def _generate_mindmap_tree(prompt: str) -> str:
    """调用上游大模型，生成 XMind 风格的思维导图 JSON 字符串。"""

    client = _get_openai_client()
    model = os.getenv("AI_UPSTREAM_MODEL", "gpt-4.1")

    try:
        resp = client.chat.completions.create(  # type: ignore
            model=model,
            messages=[
                {"role": "system", "content": _build_mindmap_tree_system_prompt()},
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"上游 AI 调用失败: {e}")

    content = resp.choices[0].message.content or ""
    json_str = _extract_json(content)
    if not json_str:
        raise HTTPException(status_code=500, detail="生成结果为空")
    return json_str


# ========== 路由 ==========


@app.get("/health")
async def health_check():
    return {"status": "ok"}


@app.post("/v1/ai/text-to-diagram/generate")
async def text_to_diagram(body: TextToDiagramRequest):
    if not body.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt 不能为空")

    mermaid_code = _generate_mermaid(body.prompt, mode="diagram")

    # 与前端 Excalidraw 约定的返回结构保持一致
    return {
        "generatedResponse": mermaid_code,
        "rateLimit": None,
        "rateLimitRemaining": None,
    }


@app.post("/v1/ai/mindmap/generate")
async def mindmap_generate(body: MindmapRequest):
    if not body.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt 不能为空")

    # 为 XMind 风格思维导图生成树形 JSON 数据，完全不再生成 Mermaid
    mindmap_tree_json = _generate_mindmap_tree(body.prompt)

    return {
        "generatedResponse": mindmap_tree_json,
        "rateLimit": None,
        "rateLimitRemaining": None,
    }


@app.post("/v1/ai/diagram-to-code/generate")
async def diagram_to_code(_: DiagramToCodeRequest):
    """Diagram -> Code 功能的占位实现。

    目前只返回一段简单 HTML，保证前端调用不报错。后续如果你需要真正实现
    图转代码，可以在这里对接硅基流动模型，按照 Excalidraw 官方的返回规范
    返回 {"html": "..."} 即可。
    """

    html = """<!DOCTYPE html>
<html>
  <body>
    <div style='font-family: sans-serif; padding: 16px;'>
      <h2>Diagram to Code - Placeholder</h2>
      <p>后端尚未实现 diagram-to-code 逻辑。</p>
    </div>
  </body>
</html>"""

    return {"html": html}
