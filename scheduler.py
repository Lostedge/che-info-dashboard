"""
定时调度器 - 定时获取设备信息和作业统计，并通过 SSE 推送给前端
"""

import time
import logging
import threading
from datetime import datetime, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from db import QueryExecutor

PORT_CNTR_TTL = 24 * 3600           # 在场箱缓存保留时长（秒）
PORT_CNTR_MIN_INTERVAL = 30         # 同一航次两次真查询的最小间隔（秒）


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

        # 是否合并外贸船数据
        self.merge_foreign_ships = config.get('ship', {}).get('merge_foreign_ships', True)
        self._ship_aliases: dict = {}      # 外贸船航次 → 主船航次，含刚离港但主船仍在的旧映射

        # 岸桥 move 数
        qc_move_cfg = config.get('qc_move', {})
        self.qc_move_hours = qc_move_cfg.get('hours', 24)
        self._qc_move: dict[str, dict[tuple, int]] = {}   # {qc_id: {(bucket, voyage): moves}}

        # 在场箱分布
        self._port_cntr: dict[str, list[dict]] = {}     # {voyage: rows}
        self._port_cntr_at: dict[str, float] = {}       # {voyage: 上次查询时刻(epoch s)}
        self._port_cntr_lock = threading.Lock()

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
        self._fetch_qc_move(self.qc_move_hours)

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
        self._scheduler.add_job(
            self._fetch_qc_move,
            CronTrigger(minute=3),
            id='fetch_qc_move',
            name='岸桥 move 数（每小时:03）',
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
            if data is None:
                continue
            self._merge_device_ship(data)
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

        aliases = self._refresh_ship_aliases(ships)                    # 构建外贸船→主船映射，关闭时 aliases 为空，下面过滤/合并自动退化
        main_ships = [s for s in ships if s['id'] not in aliases] 
        self._push('SHIP', 'ship_info', main_ships)

        working_voyages = [s['id'] for s in ships if s.get('beg_work_tim') is not None]
        if not working_voyages:
            return
        prog = self._try_query('PROG', executor.get_ship_progress, working_voyages)
        if prog is None:
            return

        ts_ms = int(now.timestamp() * 1000)
        merged = self._merge_foreign_progress(aliases, prog)    # 合并外贸船作业进度
        processed = self._guard_progress(merged)                # 防止进度归零
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

    def get_ship_history(self, voyage_id: str | None = None) -> dict:
        """voyage_id 有值→单船；为空→全部船舶 {ships: {id: [points]}}"""
        if voyage_id:
            vid = str(voyage_id)
            return {'id': vid, 'points': list(self._ship_history.get(vid, []))}
        return {'ships': {vid: list(pts) for vid, pts in self._ship_history.items()}}

    def _fetch_qc_move(self, span: int = 1):
        """岸桥 move 数：抓已关闭的整点小时桶；span=1 只抓刚结束的小时，预热时传 hours"""
        now   = self.test_datetime or datetime.now()
        hour0 = now.replace(minute=0, second=0, microsecond=0)

        executor = QueryExecutor()
        rows = self._try_query('QCMOVE', executor.get_qc_move,
                               hour0 - timedelta(hours=span), hour0)
        if rows is None:
            return

        merged = self._merge_qc_move(self._ship_aliases, rows)   # 外贸船航次归并 + 同键累加
        self._record_qc_move(merged)
        self._prune_qc_move(now)

        pushed = [{'id': qc, 'hour': self._hour_key(bucket), 'voyage': voyage, 'moves': moves}
                  for (qc, bucket, voyage), moves in merged.items()]
        if pushed:
            self._push('QCMOVE', 'qc_move', pushed)

    def _record_qc_move(self, merged: dict):
        """写入内存：{qc_id: {(bucket, voyage): moves}}"""
        for (qc, bucket, voyage), moves in merged.items():
            self._qc_move.setdefault(qc, {})[(bucket, voyage)] = moves

    def _prune_qc_move(self, now: datetime):
        """只保留最近 qc_move_hours 个已关闭整点桶"""
        hour0 = now.replace(minute=0, second=0, microsecond=0)
        keep = {(hour0 - timedelta(hours=i)).strftime('%Y-%m-%d %H:00')
                for i in range(1, self.qc_move_hours + 1)}
        for buckets in self._qc_move.values():
            for k in [k for k in buckets if k[0] not in keep]:
                del buckets[k]

    def get_qc_move(self) -> list[dict]:
        """返回 [{id, hour, voyage, moves}]，供 SSE / GET 使用"""
        out = []
        for qc, buckets in self._qc_move.items():
            for (bucket, voyage), moves in sorted(buckets.items()):
                out.append({'id': qc, 'hour': self._hour_key(bucket),
                            'voyage': voyage, 'moves': moves})
        return out

    def get_ship_cntr(self, voyage: str) -> dict:
        """船舶在场箱分布：尽量返回最新（min_interval 内的重复请求命中缓存）
        返回 {'voyage', 'ts', 'cached', 'rows'}
        """
        v = str(voyage)
        now = time.time()

        def cached(cached_flag=True):
            return {'voyage': v, 'ts': int(self._port_cntr_at.get(v, 0) * 1000),
                    'cached': cached_flag, 'rows': self._port_cntr.get(v, [])}

        if now - self._port_cntr_at.get(v, 0) < PORT_CNTR_MIN_INTERVAL:
            return cached()

        with self._port_cntr_lock:                  # 同时只允许一个真查询
            if time.time() - self._port_cntr_at.get(v, 0) < PORT_CNTR_MIN_INTERVAL:
                return cached()                     # 等锁期间别人已刷过
            voyages = [v] + [a for a, m in self._ship_aliases.items() if m == v]
            executor = QueryExecutor()
            rows = self._try_query('PORT', executor.get_ship_cntr, voyages)
            if rows is None:
                return cached()                     # 失败退回旧缓存
            self._port_cntr[v] = rows
            self._port_cntr_at[v] = time.time()
            self._prune_ship_cntr() 
            return {'voyage': v, 'ts': int(self._port_cntr_at[v] * 1000),
                    'cached': False, 'rows': rows}

    def _prune_ship_cntr(self):
        """清理 24h 未被查看的航次缓存"""
        cutoff = time.time() - PORT_CNTR_TTL
        dead = [k for k, t in self._port_cntr_at.items() if t < cutoff]
        for k in dead:
            self._port_cntr_at.pop(k, None)
            self._port_cntr.pop(k, None)
        if dead:
            self.logger.info(f"在场箱缓存清理: {len(dead)} 个航次")

    def _get_period_bounds(self, interval_minutes: int, now: datetime) -> tuple:
        """返回对齐到 interval 边界的时间窗口"""
        aligned = (now.minute // interval_minutes) * interval_minutes
        period_end = now.replace(minute=aligned, second=0, microsecond=0)
        period_start = period_end - timedelta(minutes=interval_minutes)
        return period_start, period_end

    def get_cached_data(self) -> dict:
        """返回所有缓存数据，供新客户端连接时推送"""
        return dict(self._cache)

    @staticmethod
    def _is_forecast(s) -> bool:
        """是否为预报船舶（未开工且未靠泊）"""
        return not s.get('beg_work_tim') and not s.get('rtb')

    @staticmethod
    def _foreign_base(name: str):
        """外贸船名去掉末尾的“外”后缀"""
        return name[:-1] if name.endswith('外') else None

    def _merge_device_ship(self, rows: list):
        """设备归属：voyage 归并到主船航次（外贸船），无作业船时置空串
        ship_name 保持原始值，尾缀“外”由展示层处理"""
        aliases = self._ship_aliases if self.merge_foreign_ships else {}
        for r in rows:
            v = str(r.get('voyage') or '')
            r['voyage'] = aliases.get(v, v) if v else ''

    def _build_aliases(self, ships: list) -> dict:
        """外贸船 id -> 主船 id；不合并时返回 {}"""
        if not self.merge_foreign_ships:
            return {}
        by_name = {}
        for s in ships:
            n = (s.get('ship_name') or '').strip()
            if not n:
                continue
            cur = by_name.get(n)
            if cur is None or (self._is_forecast(cur) and not self._is_forecast(s)):
                by_name[n] = s
        aliases = {}
        for s in ships:
            base = self._foreign_base((s.get('ship_name') or '').strip())
            if base and base in by_name:
                aliases[s['id']] = by_name[base]['id']
        return aliases

    @staticmethod
    def _merge_foreign_progress(aliases: dict, rows: list) -> list:
        """外贸船作业进度并入主船，返回仅含主船的行"""
        by_id = {p['id']: p for p in rows}
        fields = ('i_plan_num', 'i_done_num', 'i_queue_num',
                  'e_plan_num', 'e_done_num', 'e_queue_num')
        keep = []
        for p in rows:
            target = by_id.get(aliases.get(p['id']))
            if target is not None:
                for f in fields:
                    target[f] = (target.get(f) or 0) + (p.get(f) or 0)
                continue
            keep.append(p)
        return keep

    @staticmethod
    def _merge_qc_move(aliases: dict, rows: list) -> dict:
        """外贸船航次并入主船，按 (岸桥, 小时, 航次) 累加
        返回 {(id, bucket, voyage): moves}；bucket 为 'YYYY-MM-DD HH24:MI'"""
        merged = {}
        for r in rows:
            v = str(r.get('voyage') or '')             # 无航次保留为 ''，供前端汇总
            v = str(aliases.get(v, v))
            k = (r['id'], r['bucket'], v)
            merged[k] = merged.get(k, 0) + int(r['moves'])
        return merged

    @staticmethod
    def _hour_key(bucket: str) -> str:
        """'YYYY-MM-DD HH:MI' → 'ddHH'（前端匹配键）"""
        return bucket[8:10] + bucket[11:13]

    def _refresh_ship_aliases(self, ships: list) -> dict:
        """刷新外贸船别名映射：旧映射中主船仍在列表的予以保留
        （外贸船先离港时，其 move 仍能归属到主船）"""
        if not self.merge_foreign_ships:
            self._ship_aliases = {}
            return {}
        ids = {s['id'] for s in ships}
        keep = {k: v for k, v in self._ship_aliases.items() if v in ids}
        keep.update(self._build_aliases(ships))
        self._ship_aliases = keep
        return keep

    def stop(self):
        self._scheduler.shutdown(wait=False)
        self.logger.info("定时调度器已停止")
