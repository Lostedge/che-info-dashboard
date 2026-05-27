import time
from datetime import datetime
from typing import Optional

class TimeUtils:
    """时间处理工具"""
    
    @staticmethod
    def current_timestamp_ms() -> float:
        """当前时间戳（毫秒）"""
        return time.time() * 1000
    
    @staticmethod
    def is_expired(timestamp: float, expire_seconds: int) -> bool:
        """判断消息是否过期"""
        current = TimeUtils.current_timestamp_ms()
        return (current - timestamp) > (expire_seconds * 1000)
    
    @staticmethod
    def format_time(timestamp: float, format_str: str = '%H:%M:%S') -> str:
        """格式化时间戳"""
        return datetime.fromtimestamp(timestamp / 1000).strftime(format_str)
    
    @staticmethod
    def now_str(format_str: str = '%H:%M:%S') -> str:
        """当前时间字符串"""
        return datetime.now().strftime(format_str)