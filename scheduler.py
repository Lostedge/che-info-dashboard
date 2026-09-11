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

        # 船舶作业进度历史
        self.retention_hours = config.get('ship_history', {}).get('retention_hours', 24)
        self._ship_history: dict[str, list[dict]] = {}      # {voyage_id: [{'t': epoch_ms, 'i_done': n, 'e_done': n}]}

        # 统计模式
        self.stats_mode = config.get('stats_mode', 'shift')
        self._cache['stats_mode'] = {'mode': self.stats_mode}
        shift_cfg = config.get('shift', {})
        self.shift_comp: dict = {'ym': {}, 'qc': {}}        # {kind: {id: {'c20': n, 'c40': n}}}
        # 换班检测点处理
        self.shift_check_time = None
        raw = shift_cfg.get('check_times') or shift_cfg.get('check_time', '07:30')
        if isinstance(raw, str):
            raw = [raw]
        self.shift_times = [tuple(map(int, s.split(':'))) for s in raw] 
        self.shift_window_minutes = shift_cfg.get('window_minutes', 30)

        # 测试模式
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
            for h, m in self.shift_times:
                hh, mm = divmod(h * 60 + m + 1, 60)
                self._scheduler.add_job(
                    self._refresh_shift_comp,
                    CronTrigger(hour=hh, minute=mm),
                    id=f'refresh_shift_{h:02d}{m:02d}',
                    name=f'刷新换班补偿（{h:02d}:{m:02d}）',
                )
        self._scheduler.start()

        self.logger.info(f"✅ 定时调度器已启动: {self.intervals['info']}/{self.intervals['stats']}+{self.delay}min")

    def _nearest_shift_time(self, now):
        """最近一次已发生的班起点"""
        today = [now.replace(hour=h, minute=m, second=0, microsecond=0)
                 for h, m in self.shift_times]
        past = [p for p in today if p <= now]
        return max(past) if past else max(today) - timedelta(days=1)

    def _refresh_shift_comp(self):
        """按最近一次已发生的班起点刷新补偿"""
        now = self.test_datetime or datetime.now()
        check_time = self._nearest_shift_time(now)
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
                f"换班补偿已刷新: {check_time:%H:%M} {total} 台设备"
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
        ]:
            data = self._try_query(label, fetcher)
            if data is not None:
                self._push(label, push_type, data)
        
        self._fetch_ship(executor)

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
            data = self._try_query(label, fetcher)
            if data is not None:
                self._push(label, push_type, data)

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

    def _fetch_ship(self, executor):
        """获取并推送船舶信息与作业进度"""
        now = datetime.now()
        self._prune_ship_history(now)
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
        processed = self._guard_progress(prog)
        ts_ms = int(now.timestamp() * 1000)  
        self._record_ship_history(ts_ms, processed)
        self._push('PROG', 'ship_progress', processed, ts=ts_ms)

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

    def _push(self, label, push_type, data, **extra):
        """推送 + 缓存 + 日志"""
        self.sse_server.push({'type': push_type, 'data': data, **extra})
        self._cache[push_type] = data
        self.logger.info(f"{label}: {len(data)}")

    def _guard_progress(self, data: list):
        """作业完成后视图移除行导致归零，补回前次缓存的值"""
        old = {p['id']: p for p in self._cache.get('ship_progress', [])}
        for p in data:
            o = old.get(p['id'])
            if not o:
                continue
            for f in ('i_plan_num', 'i_done_num', 'e_plan_num', 'e_done_num'):
                if not p.get(f):
                    p[f] = o.get(f, 0)
        return data

    def _record_ship_history(self, ts_ms: int, rows: list):
        """记录船舶作业进度历史"""
        for r in rows:
            vid = r.get('id')
            if not vid:
                continue
            pts = self._ship_history.setdefault(vid, [])
            if pts and pts[-1]['t'] == ts_ms:
                continue
            pts.append({
                't': ts_ms,
                'i_done': int(r.get('i_done_num') or 0),
                'e_done': int(r.get('e_done_num') or 0),
            })

    def _prune_ship_history(self, now: datetime):
        """清理过期的船舶作业进度历史（以离港时间为基准）"""
        if not self._ship_history:
            return
        cutoff_ms = (now - timedelta(hours=self.retention_hours)).timestamp() * 1000
        dead = [vid for vid, pts in self._ship_history.items()
                if not pts or pts[-1]['t'] < cutoff_ms]
        for vid in dead:
            del self._ship_history[vid]
        if dead:
            self.logger.info(f"船舶历史清理: {len(dead)} 艘")

    def get_ship_history(self, voyage_id: str) -> dict:
        """返回指定船舶的作业进度历史"""
        vid = str(voyage_id)
        return {'id': vid, 'points': list(self._ship_history.get(vid, []))}

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
