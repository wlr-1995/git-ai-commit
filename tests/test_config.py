import json
from pathlib import Path

from app.core.config import DEFAULT_CONFIG, deep_merge, load_config, save_config


def test_deep_merge_keeps_defaults_for_missing_keys():
    base = {"a": {"x": 1, "y": 2}, "b": 3}
    merged = deep_merge(base, {"a": {"y": 9}})
    assert merged == {"a": {"x": 1, "y": 9}, "b": 3}


def test_load_config_creates_file_with_defaults(tmp_path: Path):
    cfg_file = tmp_path / "sub" / "config.json"
    cfg = load_config(cfg_file)
    assert cfg["selection"]["checked_by_default"] == "tracked"
    assert cfg_file.exists()


def test_load_config_merges_partial_file(tmp_path: Path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({"api": {"model": "custom"}}), encoding="utf-8")
    cfg = load_config(cfg_file)
    assert cfg["api"]["model"] == "custom"
    assert cfg["api"]["url"] == DEFAULT_CONFIG["api"]["url"]


def test_load_config_survives_broken_json(tmp_path: Path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text("{ this is not json", encoding="utf-8")
    cfg = load_config(cfg_file)
    assert cfg["git"]["max_diff_lines"] == 200


def test_load_config_survives_non_utf8_file(tmp_path: Path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_bytes(b"\xff\xfe{ this is not utf-8")
    cfg = load_config(cfg_file)
    assert cfg["git"]["max_diff_lines"] == 200
    assert cfg["api"]["model"] == DEFAULT_CONFIG["api"]["model"]


def test_save_config_roundtrip_unicode(tmp_path: Path):
    cfg_file = tmp_path / "config.json"
    cfg = load_config(cfg_file)
    cfg["api"]["language"] = "中文"
    save_config(cfg, cfg_file)
    raw = cfg_file.read_text(encoding="utf-8")
    assert "中文" in raw
    assert load_config(cfg_file)["api"]["language"] == "中文"
