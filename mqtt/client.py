import paho.mqtt.client as mqtt
import logging

class MQTTClient:
    """MQTT客户端"""
    
    def __init__(self, config: dict, message_handler):
        self.config = config
        self.message_handler = message_handler
        self.logger = logging.getLogger(__name__)
        self.client = None
        self.connected = False
    
    def connect(self):
        """连接MQTT服务器"""
        client_id = self.config.get('client_id')
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id
        )
        
        # 设置回调
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect
        
        # 用户名密码
        username = self.config.get('username')
        password = self.config.get('password')
        if username:
            self.client.username_pw_set(username, password)
        
        # TLS配置
        if self.config.get('tls', False):
            self.client.tls_set()
        
        # 连接
        host = self.config.get('host')
        port = self.config.get('port', 1883)
        keepalive = self.config.get('keepalive', 60)
        
        self.logger.info(f"正在连接MQTT服务器...")
        try:
            self.client.connect(host, port, keepalive)
            self.client.loop_start()
        except Exception as e:
            self.connected = False
            self.logger.error(f"MQTT连接失败: {e}")
            raise
    
    def _on_connect(self, client, userdata, flags, rc, *args, **kwargs):
        """连接成功回调"""
        if rc == 0:
            self.connected = True
            topic = self.config.get('topic')
            qos = self.config.get('qos', 1)
            
            self.client.subscribe(topic, qos)
            self.logger.info(f"MQTT连接成功，已订阅: {topic}，Client ID: {self.config.get('client_id')}")
        else:
            self.connected = False
            error_msg = f"MQTT连接失败，错误码: {rc}"
            self.logger.error(error_msg)
            print(error_msg)
    
    def _on_message(self, client, userdata, msg):
        """收到消息回调"""
        try:
            self.message_handler.handle(msg.payload, msg.topic)
        except Exception as e:
            self.logger.error(f"消息回调处理失败: {e}")
    
    def _on_disconnect(self, client, userdata, rc, *args, **kwargs):
        """断开连接回调"""
        self.connected = False

        if rc == 0 or (hasattr(rc, 'value') and rc.value == 0):
            self.logger.info("MQTT已断开")
        else:
            if hasattr(rc, 'value'):
                code = rc.value
            else:
                code = rc
            self.logger.warning(f"MQTT连接断开: {code}")

    def disconnect(self):
        """断开连接"""
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()
            self.logger.info("MQTT已断开")
    
    def publish(self, topic: str, payload: str, qos: int = 1):
        """发布消息"""
        if self.client and self.connected:
            self.client.publish(topic, payload, qos)
