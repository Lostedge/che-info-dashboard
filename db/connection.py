"""
Oracle 连接池管理
"""

import logging
import oracledb
from typing import Optional

logger = logging.getLogger(__name__)

_pool: Optional[oracledb.ConnectionPool] = None


class DBConnection:
    """Oracle 数据库连接"""

    def __init__(self, config: dict):
        global _pool

        oracledb.init_oracle_client(lib_dir=config.get('lib_dir'))
        logger.info("Thick 模式已初始化")

        user = config['user']
        password = config['password']
        host = config['host']
        port = config.get('port', 1521)
        service_name = config['service_name']
        dsn = f"{host}:{port}/{service_name}"

        _pool = oracledb.create_pool(
            user=user, password=password, dsn=dsn,
            min=1, max=3, increment=1,
        )
        logger.info(f"✅ Oracle 连接池已创建: {dsn}")

    def close(self):
        global _pool
        if _pool:
            _pool.close()
            _pool = None
            logger.info("Oracle 连接池已关闭")


def get_connection() -> oracledb.Connection:
    """获取连接"""
    if _pool is None:
        raise RuntimeError("连接池未初始化")
    return _pool.acquire()
