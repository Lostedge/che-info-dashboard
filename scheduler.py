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

        self.logger.info(f"✅ 定时调度器已启动: {self.intervals["info"]}/{self.intervals["stats"]}+{self.delay}min")

    def _fetch_stats_delayed(self):
        time.sleep(self.delay * 60)
        self._fetch_stats()

    def _fetch_info(self):
        """获取设备信息"""
        executor = QueryExecutor()

        try:
            info = executor.get_mach_info()
            if info is not None:
                self.sse_server.push({
                    'type': 'mach_info',
                    'data': info,
                })
                self.logger.info(f"设备信息获取完成，设备数: {len(info)}")
            else:
                self.logger.error("设备信息获取失败，本轮跳过")
        except Exception as e:
            self.logger.error(f"设备信息获取异常: {e}", exc_info=True)

    def _fetch_stats(self):
        """获取作业统计"""
        period_start, period_end = self._get_period_bounds(self.intervals['stats'])
        executor = QueryExecutor()

        # 场桥
        try:
            rtg_stats = executor.get_rtg_stats(period_start, period_end)
            if rtg_stats is not None:
                self.sse_server.push({
                    'type': 'rtg_stats',
                    'period_start': period_start.isoformat(),
                    'period_end': period_end.isoformat(),
                    'data': rtg_stats,
                })
                self.logger.info(
                    f"作业统计获取完成: {period_start:%H:%M} – {period_end:%H:%M}, "
                    f"设备数: {len(rtg_stats)}"
                )
            else:
                self.logger.error("作业统计获取失败，本轮跳过")
        except Exception as e:
            self.logger.error(f"作业统计获取异常: {e}", exc_info=True)

        # 岸桥
        try:
            qc_stats = executor.get_qc_stats(period_start, period_end)
            if qc_stats is not None:
                self.sse_server.push({
                    'type': 'qc_stats',
                    'period_start': period_start.isoformat(),
                    'period_end': period_end.isoformat(),
                    'data': qc_stats,
                })
                self.logger.info(f"岸桥统计完成，设备数: {len(qc_stats)}")
            else:
                self.logger.error("岸桥统计失败，本轮跳过")
        except Exception as e:
            self.logger.error(f"岸桥统计异常: {e}", exc_info=True)

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
