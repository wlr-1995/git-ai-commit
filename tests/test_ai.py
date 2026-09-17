import pytest

from app.core.ai import AIError, build_prompt, generate_commit_message, strip_think


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeSession:
    def __init__(self, response):
        self._response = response
        self.calls = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        return self._response


CFG = {
    "url": "http://localhost:11434/v1",
    "api_key": "ollama",
    "model": "qwen2.5-coder:7b",
    "prompt": "",
    "max_tokens": 8192,
    "language": "中文",
    "timeout": 60,
}


def test_strip_think_removes_reasoning_block():
    assert strip_think("a<think>secret\nlines</think>b") == "ab"


def test_build_prompt_uses_custom_prompt():
    cfg = dict(CFG, prompt="只输出一句话")
    assert build_prompt(cfg) == "只输出一句话"


def test_build_prompt_defaults_to_language():
    assert "中文" in build_prompt(CFG)


def test_generate_commit_message_posts_to_chat_completions():
    response = FakeResponse(payload={"choices": [{"message": {"content": " 修复登录bug "}}]})
    session = FakeSession(response)
    result = generate_commit_message("diff text", CFG, session=session)
    assert result == "修复登录bug"
    call = session.calls[0]
    assert call["url"] == "http://localhost:11434/v1/chat/completions"
    assert call["headers"]["Authorization"] == "Bearer ollama"
    assert call["json"]["model"] == "qwen2.5-coder:7b"
    assert call["json"]["stream"] is False
    assert call["json"]["max_tokens"] == 8192


def test_generate_commit_message_strips_think_in_response():
    response = FakeResponse(payload={"choices": [{"message": {"content": "<think>x</think>真正内容"}}]})
    assert generate_commit_message("d", CFG, session=FakeSession(response)) == "真正内容"


def test_generate_commit_message_raises_on_http_error():
    response = FakeResponse(status_code=500, text="boom")
    with pytest.raises(AIError) as exc:
        generate_commit_message("d", CFG, session=FakeSession(response))
    assert "500" in str(exc.value)


def test_generate_commit_message_raises_on_empty_choices():
    response = FakeResponse(payload={"choices": []})
    with pytest.raises(AIError):
        generate_commit_message("d", CFG, session=FakeSession(response))


def test_generate_commit_message_raises_without_url():
    with pytest.raises(AIError):
        generate_commit_message("d", dict(CFG, url=""))
