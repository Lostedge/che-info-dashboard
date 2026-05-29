"""
定时调度器
暂为骨架，后续实现具体查询和统计逻辑
"""

import time
import threading
import logging


class Scheduler:
    """定时调度器"""

    def __init__(self, sse_server):
        self.sse_server = sse_server
        self.logger = logging.getLogger(__name__)
        self._running = False

    def start(self):
        self._running = True
        thread = threading.Thread(target=self._run, daemon=True)
        thread.start()
        self.logger.info("✅ 定时调度器已启动 (间隔: 10分钟)")

    def _run(self):
        while self._running:
            try:
                self._sync_and_push()
            except Exception as e:
                self.logger.error(f"定时任务执行失败: {e}", exc_info=True)
            time.sleep(600)  # 10分钟

    def _sync_and_push(self):
        """同步数据并推送（暂为空实现，后续添加）"""
        # TODO: 查询 Oracle 设备信息
        # TODO: 查询 Oracle 作业记录
        # TODO: 统计计算
        # TODO: SSE 推送
        self.logger.debug("定时任务执行完成")

    def stop(self):
        self._running = False
        self.logger.info("定时调度器已停止")
