"""
查询执行器
"""

import time
import logging
import oracledb
from typing import Optional

from .connection import get_connection
from . import queries

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
RETRY_DELAY = 5  # 秒


class QueryExecutor:
    """数据库查询执行器"""

    def execute(self, sql: str, params: dict,
                max_retries: int = MAX_RETRIES) -> Optional[list[dict]]:
        """
        执行查询
        """
        last_error = None

        for attempt in range(1, max_retries + 1):
            conn = None
            try:
                conn = get_connection()
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    columns = [col[0].lower() for col in cur.description]
                    rows = [dict(zip(columns, row)) for row in cur.fetchall()]
                return rows

            except oracledb.DatabaseError as e:
                last_error = e
                error_obj = e.args[0] if e.args else type(e).__name__
                logger.warning(
                    f"数据库查询失败 (尝试 {attempt}/{max_retries}): {error_obj}"
                )
                if attempt < max_retries:
                    time.sleep(RETRY_DELAY)

            except Exception as e:
                last_error = e
                logger.warning(f"查询异常 (尝试 {attempt}/{max_retries}): {e}")
                if attempt < max_retries:
                    time.sleep(RETRY_DELAY)

            finally:
                if conn:
                    try:
                        conn.close()
                    except Exception:
                        pass

        # 所有重试耗尽
        logger.error(f"数据库查询失败，已达最大重试次数 {max_retries}: {last_error}")
        return None

    # ========== 业务方法 ==========

    def get_ym_stats(self, day_start, period_start, period_end) -> Optional[list[dict]]:
        """获取堆场设备作业统计"""
        return self.execute(queries.YM_STATS, {
            'day_start': day_start,
            'period_start': period_start,
            'period_end': period_end,
        })
    
    def get_qc_stats(self, day_start, period_start, period_end) -> Optional[list[dict]]:
        """获取岸桥作业统计"""
        return self.execute(queries.QC_STATS, {
            'day_start': day_start,
            'period_start': period_start,
            'period_end': period_end,
        })
    
    def get_ym_info(self) -> Optional[list[dict]]:
        """获取堆场设备信息"""
        return self.execute(queries.YM_INFO, {})

    def get_qc_info(self) -> Optional[list[dict]]:
        """获取岸桥设备信息"""
        return self.execute(queries.QC_INFO, {})
    
    def get_ship_info(self) -> Optional[list[dict]]:
        """获取船舶信息"""
        return self.execute(queries.SHIP_INFO, {})

    def get_ship_progress(self, voyage_nos: list) -> Optional[list[dict]]:
        """获取船舶作业进度"""
        if not voyage_nos:
            return []
        voyages = ', '.join(f':v{i}' for i in range(len(voyage_nos)))
        params = {f'v{i}': v for i, v in enumerate(voyage_nos)}
        return self.execute(queries.SHIP_PROGRESS.format(voyages=voyages), params)
