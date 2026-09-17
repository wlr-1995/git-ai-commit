"""配置读写：JSON 文件 + 默认值深合并。"""

import copy
import json
from pathlib import Path

DEFAULT_CONFIG: dict = {
    "api": {
        "url": "http://localhost:11434/v1",
        "api_key": "ollama",
        "model": "qwen2.5-coder:7b",
        "prompt": "",
        "max_tokens": 8192,
        "language": "中文",
        "timeout": 60,
    },
    "git": {"max_diff_lines": 200},
    "ui": {"window_width": 720, "window_height": 520},
    "selection": {"checked_by_default": "tracked"},
}

CONFIG_FILE: Path = Path.home() / ".git_ai_commit" / "config.json"


def deep_merge(base: dict, override: dict) -> dict:
    """递归合并 override 到 base 的副本上。"""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def load_config(path: Path | None = None) -> dict:
    """读取配置；文件不存在则写出默认配置。坏文件回退默认值。"""
    path = Path(path) if path else CONFIG_FILE
    if not path.exists():
        config = copy.deepcopy(DEFAULT_CONFIG)
        save_config(config, path)
        return config
    try:
        with path.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return copy.deepcopy(DEFAULT_CONFIG)
    if not isinstance(loaded, dict):
        return copy.deepcopy(DEFAULT_CONFIG)
    return deep_merge(DEFAULT_CONFIG, loaded)


def save_config(config: dict, path: Path | None = None) -> None:
    """写出配置（UTF-8，保留中文）。"""
    path = Path(path) if path else CONFIG_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2, ensure_ascii=False)
