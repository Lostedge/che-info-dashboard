"""
定时调度器
"""

import time
import logging
from datetime import datetime, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from db import QueryExecutor


class Scheduler:
    """定时调度器"""

    def __init__(self, sse_server, config: dict):
        self.sse_server = sse_server
        self.delay = config.get('delay', 2)
        self.intervals = config.get('intervals', {
            'info': 10,
            'stats': 30,
        })
        self.logger = logging.getLogger(__name__)
        self._scheduler = BackgroundScheduler()

    def start(self):
        self._fetch_info()
        self._fetch_stats()

        self._scheduler.add_job(
            self._fetch_info,
            CronTrigger(minute=f'*/{self.intervals["info"]}'),
            id='fetch_info',
            name=f'设备信息（每{self.intervals["info"]}分钟）',
        )
        self._scheduler.add_job(
            self._fetch_stats_delayed,
            CronTrigger(minute=f'*/{self.intervals["stats"]}'),
            id='fetch_stats',
            name=f'作业统计（每{self.intervals["stats"]}分钟）',
        )
        self._scheduler.start()

        self.logger.info(f"✅ 定时调度器已启动: {self.intervals['info']}/{self.intervals['stats']}+{self.delay}min")

    def _fetch_stats_delayed(self):
        """延迟 self.delay 分钟获取作业统计"""
        time.sleep(self.delay * 60)
        self._fetch_stats()


    def _fetch_info(self):
        """获取设备信息"""
        executor = QueryExecutor()

        device_counts = []
        for label, fetcher, push_type in [
            ('RTG', executor.get_rtg_info, 'rtg_info'),
            ('QC',  executor.get_qc_info,  'qc_info'),
            ('SHIP', executor.get_ship_info, 'ship_info'),
        ]:
            try:
                data = fetcher()
                if data is not None:
                    self.sse_server.push({'type': push_type, 'data': data})
                    device_counts.append(f"{label}: {len(data)}")
                else:
                    self.logger.error(f"{label} 信息获取失败")
            except Exception as e:
                self.logger.error(f"{label} 信息获取异常: {e}")

        summary = ', '.join(device_counts) if device_counts else '无数据'
        self.logger.info(f"设备信息获取完成: {summary}")

    def _fetch_stats(self):
        """获取作业统计"""
        period_start, period_end = self._get_period_bounds(self.intervals['stats'])
        executor = QueryExecutor()

        device_counts = []
        for label, fetcher, push_type in [
            ('RTG', executor.get_rtg_stats, 'rtg_stats'),
            ('QC', executor.get_qc_stats, 'qc_stats'),
        ]:
            try:
                data = fetcher(period_start, period_end)
                if data is not None:
                    self.sse_server.push({'type': push_type, 'data': data})
                    device_counts.append(f"{label}: {len(data)}")
                else:
                    self.logger.error(f"{label} 统计失败")
            except Exception as e:
                self.logger.error(f"{label} 统计异常: {e}")

        summary = ', '.join(device_counts) if device_counts else '无数据'
        self.logger.info(f"作业统计: {period_start:%H:%M} - {period_end:%H:%M}, {summary}")


    def _get_period_bounds(self, interval_minutes: int) -> tuple:
        """返回对齐到 interval 边界的时间窗口"""
        now = datetime.now()
        aligned = (now.minute // interval_minutes) * interval_minutes
        period_end = now.replace(minute=aligned, second=0, microsecond=0)
        period_start = period_end - timedelta(minutes=interval_minutes)
        return period_start, period_end

    def stop(self):
        self._scheduler.shutdown(wait=False)
        self.logger.info("定时调度器已停止")
