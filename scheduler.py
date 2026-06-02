"""
定时调度器
"""

import time
import logging
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

class Scheduler:
    """定时调度器"""

    def __init__(self, sse_server, config: dict):
        self.sse_server = sse_server
        self.interval = config.get('interval', 30)
        self.delay = config.get('delay', 2)
        self.logger = logging.getLogger(__name__)
        self._scheduler = BackgroundScheduler()

    def start(self):
        self._sync_and_push()

        trigger = CronTrigger(minute=f'*/{self.interval}')
        self._scheduler.add_job(
            self._sync_and_push_delayed,
            trigger=trigger,
            id='sync_data',
            name=f'每{self.interval}分钟同步',
        )
        self._scheduler.start()

        self.logger.info(f"✅ 定时调度器已启动，间隔: {self.interval} 分钟，延迟: {self.delay} 分钟")

    def _sync_and_push_delayed(self):
        """等待 delay 分钟后执行"""
        if self.delay:
            time.sleep(self.delay * 60)
        self._sync_and_push()

    def _sync_and_push(self):
        """同步数据并推送（暂为空实现，后续添加）"""
        # TODO: 查询 Oracle 设备信息
        # TODO: 查询 Oracle 作业记录
        # TODO: 统计计算
        # TODO: SSE 推送
        self.logger.debug("定时任务执行完成")

    def stop(self):
        self._scheduler.shutdown(wait=False)
        self.logger.info("定时调度器已停止")
