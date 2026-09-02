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

        # 统计模式
        self.stats_mode = config.get('stats_mode', 'shift')
        shift_cfg = config.get('shift', {})
        self.shift_comp: dict = {'ym': {}, 'qc': {}}   # {kind: {id: {'c20': n, 'c40': n}}}
        self.shift_check_time = None
        self.shift_check_time_str = shift_cfg.get('check_time', '07:30')
        self.shift_window_minutes = shift_cfg.get('window_minutes', 30)

        test_cfg = config.get('test', {})
        self.test_datetime = None
        if test_cfg.get('enabled') and test_cfg.get('test_datetime'):
            self.test_datetime = datetime.strptime(test_cfg['test_datetime'], '%Y-%m-%d %H:%M:%S')

    def start(self):
        if self.stats_mode == 'shift':
            self._refresh_shift_comp()
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
        if self.stats_mode == 'shift':
            ch, cm = map(int, self.shift_check_time_str.split(':'))
            job_hh, job_mm = divmod(ch * 60 + cm + self.delay, 60)
            self._scheduler.add_job(
                self._refresh_shift_comp,
                CronTrigger(hour=job_hh, minute=job_mm),
                id='refresh_shift',
                name='刷新换班补偿',
            )
        self._scheduler.start()

        self.logger.info(f"✅ 定时调度器已启动: {self.intervals['info']}/{self.intervals['stats']}+{self.delay}min")

    def _refresh_shift_comp(self):
        """每日换班检测：缓存换司机设备在 [换班点, 检测点) 的作业补偿量"""
        now = self.test_datetime or datetime.now()
        hh, mm = map(int, self.shift_check_time_str.split(':'))
        check_time = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if now < check_time:
            check_time -= timedelta(days=1)      # 指向最近一次已发生的检测点
        lookback = check_time - timedelta(minutes=self.shift_window_minutes)

        try:
            executor = QueryExecutor()
            comp = {'ym': {}, 'qc': {}}
            for kind, store in (('cy', 'ym'), ('qc', 'qc')):
                for r in executor.get_shift_map(check_time, lookback, kind) or []:
                    comp[store][r['id']] = {
                        'c20': int(r['comp_20'] or 0),
                        'c40': int(r['comp_40'] or 0),
                    }
            self.shift_comp = comp
            self.shift_check_time = check_time
            total = sum(len(v) for v in comp.values())
            self.logger.info(
                f"✅ 换班补偿已刷新: {total} 台设备，"
                f"检测点 {check_time:%Y-%m-%d %H:%M:%S}"
            )
        except Exception as e:
            self.logger.error(f"换班补偿刷新失败: {e}")

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
            ('SHIP', executor.get_ship_info, 'ship_info'),
        ]:
            self._fetch_and_push(label, fetcher, push_type)

    def _fetch_stats(self):
        """获取并推送作业统计"""
        now = self.test_datetime or datetime.now()
        period_start, period_end = self._get_period_bounds(self.intervals['stats'], now)
        executor = QueryExecutor()

        if self.stats_mode == 'shift':
            mode_label = '当班'
            day_start = self.shift_check_time or now
            comp_ym = self.shift_comp.get('ym', {})
            comp_qc = self.shift_comp.get('qc', {})
            stats = [
                ('YM', lambda: self._shift_stats(executor, 'ym', day_start, period_start, period_end, comp_ym), 'ym_stats'),
                ('QC', lambda: self._shift_stats(executor, 'qc', day_start, period_start, period_end, comp_qc), 'qc_stats'),
            ]
        else:
            mode_label = '当日'
            day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            stats = [
                ('YM', lambda: executor.get_ym_stats(day_start, period_start, period_end), 'ym_stats'),
                ('QC', lambda: executor.get_qc_stats(day_start, period_start, period_end), 'qc_stats'),
            ]

        self.logger.info(f"获取{mode_label}作业统计... [{period_start:%H:%M} - {period_end:%H:%M}]")
        for label, fetcher, push_type in stats:
            self._fetch_and_push(label, fetcher, push_type)

    def _shift_stats(self, executor, kind, day_start, period_start, period_end, comp):
        """当班统计：查 [检测点, now) 后叠加换班点~检测点的补偿量"""
        fetch = executor.get_ym_stats if kind == 'ym' else executor.get_qc_stats
        rows = fetch(day_start, period_start, period_end)
        if rows is None or not comp:
            return rows
        for r in rows:
            c = comp.get(r['id'])
            if c:
                r['day_20'] = (r.get('day_20') or 0) + c['c20']
                r['day_40'] = (r.get('day_40') or 0) + c['c40']
        return rows

    def _fetch_and_push(self, label, fetcher, push_type, *args):
        """获取数据并推送、缓存，记录日志"""
        try:
            data = fetcher(*args)
            if data is not None:
                self.sse_server.push({'type': push_type, 'data': data})
                self._cache[push_type] = data
                self.logger.info(f"{label}: {len(data)}")
            else:
                self.logger.error(f"{label} 获取失败")
        except Exception as e:
            self.logger.error(f"{label} 获取异常: {e}")

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
