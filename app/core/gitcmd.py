"""git.exe 子进程封装：统一编码、超时与错误信息。"""

import os
import subprocess
from pathlib import Path

_GIT_PREFIX = ["git", "-c", "core.quotepath=false"]


def _git_env() -> dict:
    """git 运行环境：把 pathspec 当作字面量，文件名中的 ``* ? [`` 不再被当作通配。"""
    env = os.environ.copy()
    env["GIT_LITERAL_PATHSPECS"] = "1"
    return env


class GitError(RuntimeError):
    """git 命令失败。"""


def run_git(
    args: list[str],
    cwd,
    timeout: int = 60,
    check: bool = True,
) -> tuple[int, str, str]:
    """执行 git 命令，返回 (returncode, stdout, stderr)。

    check=True 时非零退出码抛 GitError。
    """
    command = [*_GIT_PREFIX, *args]
    try:
        proc = subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            timeout=timeout,
            env=_git_env(),
        )
    except NotADirectoryError as exc:
        raise GitError(f"工作目录无效（不存在或不是目录）: {cwd}") from exc
    except FileNotFoundError as exc:
        raise GitError("找不到 git 命令，请确认已安装 Git 并加入 PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git 命令超时: {' '.join(args)}") from exc
    except OSError as exc:
        raise GitError(f"git 命令无法执行: {exc}") from exc

    stdout = proc.stdout.decode("utf-8", errors="replace")
    stderr = proc.stderr.decode("utf-8", errors="replace")
    if check and proc.returncode != 0:
        raise GitError(stderr.strip() or f"git 退出码 {proc.returncode}: {' '.join(args)}")
    return proc.returncode, stdout, stderr


def ensure_dir(path) -> Path:
    """规范化目录路径。"""
    return Path(path).resolve()
