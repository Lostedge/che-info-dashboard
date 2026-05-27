"""
简化版日志配置
仅保留按大小滚动 + 控制台输出，去掉双切割模式
"""

import os
import sys
import logging
from logging.handlers import RotatingFileHandler


def setup_logging(config: dict, base_dir: str) -> logging.Logger:
    """配置日志系统"""
    log_level = getattr(logging, config.get('level', 'INFO').upper())
    log_file = config.get('file', 'logs/app.log')

    if not os.path.isabs(log_file):
        log_file = os.path.join(base_dir, log_file)

    log_dir = os.path.dirname(log_file)
    if log_dir and not os.path.exists(log_dir):
        os.makedirs(log_dir, exist_ok=True)

    cfg = config.get('rotation', {})
    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=cfg.get('max_bytes', 5 * 1024 * 1024),  # 默认5MB
        backupCount=cfg.get('backup_count', 30),
        encoding='utf-8'
    )

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(log_level)

    file_formatter = logging.Formatter(
        '%(asctime)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    console_formatter = logging.Formatter('%(message)s')

    file_handler.setFormatter(file_formatter)
    console_handler.setFormatter(console_formatter)

    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers.clear()
    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)

    logger = logging.getLogger(__name__)
    from datetime import datetime
    logger.info("=" * 60)
    logger.info(f"启动时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    logger.info(f"日志文件: {log_file}")
    logger.info("=" * 60)

    return logger
