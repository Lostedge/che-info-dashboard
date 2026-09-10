"""
SSE 推送服务器
"""

import os
import sys
import json
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from typing import Optional
from datetime import datetime, date
import logging
import base64, hmac
from urllib.parse import urlparse, parse_qs

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class SSEHandler(BaseHTTPRequestHandler):
    """SSE 请求处理器"""

    clients: list['SSEHandler'] = []
    lock = threading.Lock()
    logger = logging.getLogger(__name__)
    on_client_connect = None
    ship_history_getter = None
    max_clients: int = 20
    auth: dict = {}

    MIME_TYPES = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
    }

    def setup(self):
        super().setup()
        self.write_lock = threading.Lock()

    def handle(self):
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def do_GET(self):
        if not self._authenticated():
            self.logger.warning(f"认证失败: {self.client_address[0]} {self.path}")
            self._send_unauthorized()
            return
        try:
            path = urlparse(self.path).path
            if path == '/events':
                self._handle_sse()
            elif path == '/api/ship_history':
                self._handle_api_history()
            elif path.startswith('/'):
                self._handle_static()
            else:
                self.send_response(404)
                self.end_headers()
        except Exception as e:
            self.logger.error(f"处理请求时发生错误: {e}")

    def _authenticated(self):
        """Basic Auth 校验"""
        cfg = self.__class__.auth or {}
        if not cfg.get('enabled'):
            return True
        expect_user = cfg.get('username', '')
        expect_pass = cfg.get('password', '')
        if not expect_pass:
            return False
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Basic '):
            return False
        try:
            raw = base64.b64decode(auth[6:]).decode('utf-8')
            user, _, pwd = raw.partition(':')
        except Exception:
            return False
        return (hmac.compare_digest(user, expect_user)
                and hmac.compare_digest(pwd, expect_pass))

    def _send_unauthorized(self):
        """发送 401 未授权响应"""
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Dashboard"')
        self.send_header('Content-Length', '0')
        self.end_headers()
    
    def _handle_sse(self):
        if not self._register_client():
            self._send_bytes(503, 'text/plain; charset=utf-8', b'Too many SSE connections')
            return

        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self._send_security_headers()
            self.end_headers()

            if self.__class__.on_client_connect:
                self.__class__.on_client_connect(self)

            while True:
                with self.write_lock:
                    self.wfile.write(b': heartbeat\n\n')
                    self.wfile.flush()
                time.sleep(15)

        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with self.lock:
                if self in self.__class__.clients:
                    self.__class__.clients.remove(self)
                    self.logger.info(f"SSE 客户端断开: {self.client_ip}，当前连接数: {len(self.clients)}")

    def _register_client(self):
        """尝试注册 SSE 客户端，成功返回 True，满员返回 False"""
        with self.lock:
            if len(self.__class__.clients) >= self.__class__.max_clients:
                return False

            self.__class__.clients.append(self)
            self.client_ip = self.client_address[0]
            self.logger.info(
                f"SSE 客户端连接: {self.client_ip}，当前连接数: {len(self.clients)}"
            )
            return True

    def _handle_static(self):
        static_dir = self._get_static_dir()
        rel_path = self.path.split('?', 1)[0].lstrip('/')

        if not rel_path:
            rel_path = 'index.html'

        file_path = os.path.realpath(os.path.join(static_dir, rel_path))
        try:
            inside = os.path.commonpath([file_path, static_dir]) == static_dir
        except ValueError:
            inside = False
        if not inside or os.path.isdir(file_path):
            self.send_error(403)
            return

        ext = os.path.splitext(file_path)[1].lower()
        content_type = self.MIME_TYPES.get(ext, 'application/octet-stream')
        try:
            with open(file_path, 'rb') as f:
                content = f.read()
            self._send_bytes(200, content_type, content)
        except OSError:
            self.send_error(404)

    def _handle_api_history(self):
        """GET /api/ship_history?voyage=xxx → {"id":..., "points":[{t,i_done,e_done},...]}"""
        voyage = (parse_qs(urlparse(self.path).query).get('voyage') or [''])[0]
        getter = self.__class__.ship_history_getter

        if not getter:
            status, body = 503, b'{"error": "history unavailable"}'
        elif not voyage:
            status, body = 400, b'{"error": "missing voyage"}'
        else:
            try:
                data = getter(voyage)
            except Exception as e:
                self.logger.error(f"船舶历史读取失败: {e}", exc_info=True)
                data = {'id': voyage, 'points': []}
            status, body = 200, json.dumps(data, ensure_ascii=False).encode('utf-8')

        self._send_bytes(status, 'application/json; charset=utf-8', body)

    def _get_static_dir(self):
        if getattr(sys, 'frozen', False):
            base_dir = os.path.dirname(sys.executable)
        else:
            current_dir = os.path.dirname(os.path.abspath(__file__))
            base_dir = os.path.dirname(current_dir)
        return os.path.realpath(os.path.join(base_dir, 'web', 'static'))

    def _send_bytes(self, status: int, content_type: str, body: bytes):
        """写回响应：状态 + 类型 + 长度 + 安全头"""
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_security_headers(self):
        self.send_header('Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'")
        self.send_header('X-Content-Type-Options', 'nosniff')

    def log_message(self, format, *args):
        pass

    def send_to(self, data: dict):
        """向当前客户端发送 SSE 消息"""
        try:
            with self.write_lock:
                self.wfile.write(_encode_sse(data))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    @classmethod
    def broadcast(cls, data: dict):
        with cls.lock:
            if not cls.clients:
                return
            clients = list(cls.clients)
        message = _encode_sse(data)
        dead_clients = []
        for client in clients:
            try:
                with client.write_lock:
                    client.wfile.write(message)
                    client.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                dead_clients.append(client)
        if dead_clients:
            with cls.lock:
                for c in dead_clients:
                    if c in cls.clients:
                        cls.clients.remove(c)


class SSEServer:
    """SSE 服务器"""

    def __init__(self, host: str, port: int, max_clients: int = 20, auth: Optional[dict] = None):
        self.host = host
        self.port = port
        self.max_clients = max_clients
        self.auth = auth or {}
        self.server: Optional[ThreadingHTTPServer] = None
        self.thread: Optional[threading.Thread] = None
        self.logger = logging.getLogger(__name__)
        self.running = False

    def start(self):
        SSEHandler.max_clients = self.max_clients
        SSEHandler.auth = self.auth

        self.server = ThreadingHTTPServer((self.host, self.port), SSEHandler)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.running = True
        self.thread.start()
        self.logger.info(f"✅ SSE 服务器已启动: http://{self.host}:{self.port}")

    def _run(self):
        try:
            self.server.serve_forever()
        except Exception:
            pass

    def push(self, data: dict):
        if not self.running:
            return
        SSEHandler.broadcast(data)

    def stop(self):
        self.running = False
        if self.server:
            self.server.shutdown()
            self.logger.info("SSE 服务器已停止")

def _encode_sse(data: dict) -> bytes:
    """将数据编码为 SSE 帧：data: {...}\n\n"""
    json_data = json.dumps(data, ensure_ascii=False, default=_json_serial)
    return f"data: {json_data}\n\n".encode('utf-8')

def _json_serial(obj):
    """JSON 序列化：datetime → ISO 字符串"""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    raise TypeError(f"类型 {type(obj).__name__} 无法序列化为JSON格式")
