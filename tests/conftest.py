"""测试环境修正：在 Windows 上优先使用系统 ICU。

修正逻辑集中在 ``app.bootstrap``（产品与测试共用）；导入 ``app`` 即会生效，
避免在测试层重复实现。
"""

import app  # noqa: F401  (side effect: ensure_windows_dll_dirs)
