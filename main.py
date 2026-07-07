"""
程序入口
"""

import os
import sys
import time
import yaml
from dotenv import load_dotenv

load_dotenv()

from utils.logger import setup_logging
from utils.time_utils import TimeUtils
from core.detector import StateDetector
from mqtt.client import MQTTClient
from web.sse_server import SSEServer, SSEHandler
from scheduler import Scheduler


def get_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def load_config(base_dir: str) -> dict:
    config_path = os.path.join(base_dir, 'config.yaml')
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)

        mqtt_config = config.get('mqtt', {})
        oracle_config = config.get('oracle', {})
        _resolve_env_vars(mqtt_config, ('username', 'password'))
        _resolve_env_vars(oracle_config, ('user', 'password', 'lib_dir'))

        return config

    except FileNotFoundError:
        print(f"错误: 配置文件 {config_path} 不存在")
        sys.exit(1)
    except yaml.YAMLError as e:
        print(f"错误: 配置文件格式错误 {e}")
        sys.exit(1)

  
def _resolve_env_vars(section: dict, keys: tuple):
    for key in keys:
        val = section.get(key, '')
        if isinstance(val, str) and val.startswith('${'):
            section[key] = os.getenv(val[2:-1], '')


def main():
    base_dir = get_base_dir()
    config = load_config(base_dir)
    logger = setup_logging(config.get('logging', {}), base_dir)

    # 1. 状态检测器
    detector = StateDetector(config.get('detector', {}))

    # 2. SSE 服务器
    sse_cfg = config.get('sse', {})
    sse_server = SSEServer(
        host=sse_cfg.get('host', '0.0.0.0'),
        port=sse_cfg.get('port', 8765)
    )

    # 设置客户端连接回调（推送当前所有设备状态）
    def on_connect():
        all_states = detector.get_all_states()
        devices = [
            {
                'id': state.display_id,
                'area': state.area,
                'bay': state.bay
            }
            for state in all_states.values()
        ]
        sse_server.push({'type': 'init', 'devices': devices})

    SSEHandler.on_client_connect = on_connect
    sse_server.start()

    # 3. 消息处理器（MQTT 消息 → 检测变化 → SSE 推送）
    def handle_mqtt_message(raw_payload: bytes, topic: str = None):
        import json
        try:
            data = json.loads(raw_payload.decode())
            physical_id = data.get('cardAddr')
            if not physical_id:
                return

            entity_name = data.get('entityName', '')
            display_id = entity_name[-3:] if entity_name else physical_id

            timestamp = data.get('timestamp')
            if not timestamp:
                return

            # 过期检查
            if TimeUtils.is_expired(timestamp, config.get('message', {}).get('expire_interval', 30)):
                return

            area = data.get('areaCode', '')
            bay = data.get('bayNo', '')

            # 检测状态变化
            change_info = detector.update(display_id, area, bay, timestamp)

            # 变化则推送 SSE
            if change_info.get('changed'):
                sse_server.push({
                    'type': 'rtg_location',
                    'device': {
                        'id': display_id,
                        'area': area,
                        'bay': bay,
                        'timestamp': timestamp,
                    },
                    'change_type': change_info.get('change_type', 'normal'),
                })

        except json.JSONDecodeError as e:
            logger.error(f"JSON解析失败: {e}")
        except Exception as e:
            logger.error(f"消息处理失败: {e}", exc_info=True)

    # 4. MQTT 客户端
    class MqttHandler:
        def handle(self, raw_payload: bytes, topic: str = None):
            handle_mqtt_message(raw_payload, topic)

    mqtt_client = MQTTClient(
        config=config['mqtt'],
        message_handler=MqttHandler()
    )

    # 5. Oracle 连接池初始化
    db = None
    try:
        from db import DBConnection
        db = DBConnection(config['oracle'])
    except Exception as e:
        logger.warning(f"Oracle 连接失败，程序将继续运行但不查询数据库: {e}")

    # 6. 定时调度器（暂为骨架）
    scheduler = Scheduler(
        sse_server=sse_server, 
        config=config.get('scheduler', {})
    )
    scheduler.start()

    # 7. 启动
    try:
        try:
            mqtt_client.connect()
        except Exception as e:
            logger.error(f"MQTT未连接，程序将继续运行但不接收MQTT消息")

        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n用户中断，正在退出...")
    except Exception as e:
        logger.error(f"运行错误: {e}", exc_info=True)
    finally:
        mqtt_client.disconnect()
        scheduler.stop()
        sse_server.stop()
        if db:
            db.close()
        logger.info("系统已退出")


if __name__ == "__main__":
    main()
