"""OpenAI 兼容的提交信息生成客户端。"""

import re

import requests

_THINK_RE = re.compile(r"<think>.*?</think>", re.S)


class AIError(RuntimeError):
    """AI 调用失败。"""


def strip_think(text: str) -> str:
    """移除思考模型的 <think>...</think> 段落。"""
    return _THINK_RE.sub("", text).strip()


def build_prompt(cfg: dict) -> str:
    """自定义提示词优先，否则按语言生成默认提示词。"""
    custom = (cfg.get("prompt") or "").strip()
    if custom:
        return custom
    language = cfg.get("language") or "中文"
    return (
        "你是一个专业程序员。请根据提供的 git diff 生成一条简洁、准确的提交信息，"
        f"使用{language}，只输出提交信息本身，不要输出解释、引号或 markdown 标记。"
    )


def generate_commit_message(diff_text: str, cfg: dict, session=None) -> str:
    """调用 {url}/chat/completions 生成提交信息。"""
    url = (cfg.get("url") or "").strip().rstrip("/")
    if not url:
        raise AIError("未配置 api.url，请先填写配置文件")

    payload: dict = {
        "model": cfg.get("model") or "",
        "messages": [
            {"role": "system", "content": build_prompt(cfg)},
            {"role": "user", "content": diff_text},
        ],
        "stream": False,
    }
    max_tokens = cfg.get("max_tokens") or 0
    if max_tokens > 0:
        payload["max_tokens"] = max_tokens

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg.get('api_key') or ''}",
    }
    http = session or requests
    try:
        response = http.post(
            f"{url}/chat/completions",
            json=payload,
            headers=headers,
            timeout=cfg.get("timeout", 60),
        )
    except requests.RequestException as exc:
        raise AIError(f"AI 请求失败：{exc}") from exc

    if response.status_code != 200:
        raise AIError(f"AI 返回 {response.status_code}：{response.text[:500]}")

    try:
        data = response.json()
    except ValueError as exc:
        raise AIError("AI 返回的不是合法 JSON") from exc

    choices = data.get("choices") or []
    if not choices:
        raise AIError("AI 返回缺少 choices")

    content = strip_think((choices[0].get("message") or {}).get("content") or "")
    if not content:
        raise AIError("AI 未返回有效内容")
    return content
