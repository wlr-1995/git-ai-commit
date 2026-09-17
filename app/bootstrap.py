"""Windows 运行环境修正：在导入 PySide6 之前修正 DLL 搜索路径。

conda 基础环境自带的 ``Library\\bin\\icuuc.dll``（ICU 78，只导出带版本号的
符号，如 ``ucnv_open_78``）会遮蔽 Windows 系统自带的 ``icuuc.dll``（导出
不带版本号的 ``ucnv_open`` 等）。PySide6 的 ``Qt6Core.dll`` 硬依赖后者不带
版本号的符号，于是导入时抛出 ``ImportError: DLL load failed ... (0xc0000139)``。

把 ``System32`` 注册为 DLL 搜索目录即可让系统 ICU 优先命中。该修正既适用于
测试，也适用于产品入口（``app/main.py``），因此集中在 ``app`` 包内，任何
``import app...`` 都会先行生效。
"""

import os
import sys

_dll_handles = []


def ensure_windows_dll_dirs() -> None:
    """在 Windows 上把系统目录注册为 DLL 搜索目录（幂等，非 Windows 为空操作）。

    目录句柄保存在模块级 ``_dll_handles``，以免被垃圾回收导致注册失效。
    """
    if sys.platform != "win32" or _dll_handles:
        return
    system32 = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    if os.path.isdir(system32):
        _dll_handles.append(os.add_dll_directory(system32))
