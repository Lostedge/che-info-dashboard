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
        """等待 delay 秒后执行"""
        if self.delay:
            time.sleep(self.delay * 60)
        self._sync_and_push()

    def _sync_and_push(self):
        """同步数据并推送"""
        from db import QueryExecutor

        period_start, period_end = self._get_period_bounds()
        executor = QueryExecutor()

        try:
            stats = executor.get_cy_command_stats(period_start, period_end)
            if stats is not None:
                self.sse_server.push({
                    'type': 'cy_command_stats',
                    'period_start': period_start.isoformat(),
                    'period_end': period_end.isoformat(),
                    'data': stats,
                })
                self.logger.info(
                    f"定时同步完成: {period_start:%H:%M} – {period_end:%H:%M}, "
                    f"设备数: {len(stats)}"
                )
                print(stats)
            else:
                self.logger.error("定时同步失败，本轮跳过")
        except Exception as e:
            self.logger.error(f"定时同步异常: {e}", exc_info=True)

    def _get_period_bounds(self) -> tuple:
        """返回当前对齐到 interval 边界的时间窗口"""
        from datetime import datetime, timedelta
        now = datetime.now()
        aligned = (now.minute // self.interval) * self.interval
        period_end = now.replace(minute=aligned, second=0, microsecond=0)
        period_start = period_end - timedelta(minutes=self.interval)
        return period_start, period_end

    def stop(self):
        self._scheduler.shutdown(wait=False)
        self.logger.info("定时调度器已停止")
