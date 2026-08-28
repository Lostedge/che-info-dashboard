"""
定时调度器 - 定时获取设备信息和作业统计，并通过 SSE 推送给前端
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
        self._cache: dict[str, list] = {}

        test_cfg = config.get('test', {})
        self.test_datetime = None
        if test_cfg.get('enabled') and test_cfg.get('test_datetime'):
            self.test_datetime = datetime.strptime(test_cfg['test_datetime'], '%Y-%m-%d %H:%M:%S')

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
        """获取并推送设备信息"""
        self.logger.info("获取设备信息...")
        executor = QueryExecutor()

        for label, fetcher, push_type in [
            ('YM', executor.get_ym_info, 'ym_info'),
            ('QC', executor.get_qc_info, 'qc_info'),
        ]:
            data = self._try_query(label, fetcher)
            if data is not None:
                self._push(label, push_type, data)
        
        self._fetch_ship(executor)

    def _fetch_stats(self):
        """获取并推送作业统计"""
        now = self.test_datetime or datetime.now()
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        period_start, period_end = self._get_period_bounds(self.intervals['stats'], now)
        self.logger.info(f"获取作业统计... [{period_start:%H:%M} - {period_end:%H:%M}]")
        executor = QueryExecutor()

        for label, fetcher, push_type in [
            ('YM', executor.get_ym_stats, 'ym_stats'),
            ('QC', executor.get_qc_stats, 'qc_stats'),
        ]:
            data = self._try_query(label, fetcher, day_start, period_start, period_end)
            if data is not None:
                self._push(label, push_type, data)

    def _fetch_ship(self, executor):
        """获取并推送船舶信息与作业进度"""
        ships = self._try_query('SHIP', executor.get_ship_info)
        if ships is None:
            return
        self._push('SHIP', 'ship_info', ships)

        working_voyages = [s['id'] for s in ships if s.get('beg_work_tim') is not None]
        if not working_voyages:
            return
        prog = self._try_query('PROG', executor.get_ship_progress, working_voyages)
        if prog is None:
            return
        self._push('PROG', 'ship_progress', self._merge_progress(prog))

    def _try_query(self, label, fetcher, *args):
        """执行查询，失败返回 None"""
        try:
            data = fetcher(*args)
            if data is not None:
                return data
            self.logger.error(f"{label} 获取失败")
        except Exception as e:
            self.logger.error(f"{label} 获取异常: {e}")
        return None

    def _push(self, label, push_type, data):
        """推送 + 缓存 + 日志"""
        self.sse_server.push({'type': push_type, 'data': data})
        self._cache[push_type] = data
        self.logger.info(f"{label}: {len(data)}")

    def _merge_progress(self, data: list):
        """作业完成后视图移除行导致归零，用历史缓存兜底（只增不减）"""
        old = {p['id']: p for p in self._cache.get('ship_progress', [])}
        for p in data:
            o = old.get(p['id'])
            if o:
                for f in ('i_plan_num', 'i_done_num', 'e_plan_num', 'e_done_num'):
                    p[f] = max(p.get(f, 0), o.get(f, 0))
        return data

    def _get_period_bounds(self, interval_minutes: int, now: datetime) -> tuple:
        """返回对齐到 interval 边界的时间窗口"""
        aligned = (now.minute // interval_minutes) * interval_minutes
        period_end = now.replace(minute=aligned, second=0, microsecond=0)
        period_start = period_end - timedelta(minutes=interval_minutes)
        return period_start, period_end

    def get_cached_data(self) -> dict:
        """返回所有缓存数据，供新客户端连接时推送"""
        return dict(self._cache)

    def stop(self):
        self._scheduler.shutdown(wait=False)
        self.logger.info("定时调度器已停止")
