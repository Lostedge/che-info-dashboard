"""
状态变化检测器
- DeviceState: 设备状态数据模型
- StateDetector: 状态变化检测、过期丢弃、转场判断
"""

from dataclasses import dataclass
import time
import threading
from typing import Optional


@dataclass
class DeviceState:
    """设备状态"""
    display_id: str      # 设备编号
    area: str            # 堆场
    bay: str             # 贝位
    last_update: int     # 定位时间戳（毫秒）
    last_seen: int = 0   # 最近心跳（秒），离线检测用

    @property
    def location(self) -> str:
        return f"{self.area}-{self.bay}"


class StateDetector:
    """状态变化检测器"""

    def __init__(self, config: dict):
        self.device_states: dict[str, DeviceState] = {}
        self.transfer_threshold = config.get('transfer_threshold', 10000)
        self.move_threshold = config.get('move_threshold', 2500)
        self.transfer_bays = set(config.get('transfer_bays', ['001', '071', '069']))
        self.offline_threshold = config.get('offline_threshold', 5)
        self.offline_callback = None

        # 启动离线检测线程
        threading.Thread(target=self._offline_monitor, daemon=True).start()

    def update(self, display_id: str, area: str, bay: str, timestamp: int) -> dict:
        """
        更新状态并检测变化

        参数:
            display_id: 设备编号
            area: 堆场
            bay: 贝位
            timestamp: 时间戳（毫秒）

        返回:
            {
                'changed': bool,            # 是否有变化
                'old_state': DeviceState,   # 仅 changed=True 时有值
                'change_type': str,         # 'new', 'normal', 'transfer', 'abnormal'
            }
        """
        current_time = int(time.time())

        # 新设备
        if display_id not in self.device_states:
            self.device_states[display_id] = DeviceState(
                display_id=display_id,
                area=area,
                bay=bay,
                last_update=timestamp,
                last_seen=current_time,
            )
            return {'changed': True, 'old_state': None, 'change_type': 'new'}

        old_state = self.device_states[display_id]
        old_state.last_seen = current_time

        area_changed = area != old_state.area
        bay_changed = bay != old_state.bay

        if not (area_changed or bay_changed):
            return {'changed': False, 'old_state': None, 'change_type': 'normal'}

        # 判断变化类型
        change_type = self._detect_change_type(
            old_state, area, bay, timestamp, area_changed, bay_changed
        )

        # 更新状态
        self.device_states[display_id] = DeviceState(
            display_id=display_id,
            area=area,
            bay=bay,
            last_update=timestamp,
            last_seen=current_time,
        )

        return {'changed': True, 'old_state': old_state, 'change_type': change_type}

    def _detect_change_type(self, old_state: DeviceState, area: str, bay: str,
                            timestamp: int, area_changed: bool, bay_changed: bool) -> str:
        """判断变化类型"""
        time_diff = timestamp - old_state.last_update

        if area_changed:
            is_transfer_bay = old_state.bay in self.transfer_bays or bay in self.transfer_bays
            if is_transfer_bay and time_diff >= self.transfer_threshold:
                return 'transfer'
            else:
                return 'abnormal'

        if bay_changed:
            if time_diff >= self.move_threshold:
                return 'normal'
            else:
                return 'abnormal'

        return 'normal'

    def _offline_monitor(self):
        """离线检测线程"""
        while True:
            time.sleep(5)
            current_time = int(time.time())
            for pid, state in list(self.device_states.items()):
                if (current_time - state.last_seen) >= self.offline_threshold:
                    del self.device_states[pid]
                    if self.offline_callback:
                        self.offline_callback(pid, state)

    def get_state(self, display_id: str) -> Optional[DeviceState]:
        return self.device_states.get(display_id)

    def get_all_states(self) -> dict[str, DeviceState]:
        return self.device_states.copy()
