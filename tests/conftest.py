"""测试环境修正：在 Windows 上优先使用系统 ICU。

conda 基础环境自带的 ``Library\\bin\\icuuc.dll``（ICU 78，只导出带版本号的
符号，如 ``ucnv_open_78``）会遮蔽 Windows 系统自带的 ``icuuc.dll``（导出
不带版本号的 ``ucnv_open`` 等）。PySide6 的 ``Qt6Core.dll`` 依赖后者，于是
导入时抛出 ``ImportError: DLL load failed ... (0xc0000139)``。

把 ``System32`` 注册为 DLL 搜索目录即可让系统 ICU 优先命中。
"""

import os
import sys

_dll_handles = []

if sys.platform == "win32":
    _system32 = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    if os.path.isdir(_system32):
        _dll_handles.append(os.add_dll_directory(_system32))
