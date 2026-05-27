"""
SSE 推送服务器
复用原项目核心逻辑，精简掉不必要的功能
"""

import os
import sys
import json
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from typing import Optional
import logging


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class SSEHandler(BaseHTTPRequestHandler):
    """SSE 请求处理器"""

    clients: list['SSEHandler'] = []
    lock = threading.Lock()
    logger = logging.getLogger(__name__)
    on_client_connect = None

    STATIC_FILES = {
        '/': ('index.html', 'text/html'),
        '/index.html': ('index.html', 'text/html'),
        '/style.css': ('style.css', 'text/css'),
        '/script.js': ('script.js', 'application/javascript'),
    }

    def _get_static_dir(self):
        if getattr(sys, 'frozen', False):
            base_dir = os.path.dirname(sys.executable)
        else:
            current_dir = os.path.dirname(os.path.abspath(__file__))
            base_dir = os.path.dirname(current_dir)
        return os.path.join(base_dir, 'web', 'static')

    def handle(self):
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def do_GET(self):
        try:
            if self.path == '/events':
                self._handle_sse()
            elif self.path in self.STATIC_FILES:
                self._handle_static()
            else:
                self.send_response(404)
                self.end_headers()
        except Exception:
            pass

    def _handle_sse(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        with self.lock:
            self.__class__.clients.append(self)
            self.logger.info(f"SSE 客户端连接，当前连接数: {len(self.clients)}")

        if self.__class__.on_client_connect:
            self.__class__.on_client_connect()

        try:
            while True:
                self.wfile.write(b': heartbeat\n\n')
                self.wfile.flush()
                time.sleep(15)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            with self.lock:
                if self in self.__class__.clients:
                    self.__class__.clients.remove(self)
                    self.logger.info(f"SSE 客户端断开，当前连接数: {len(self.clients)}")

    def _handle_static(self):
        filename, content_type = self.STATIC_FILES[self.path]
        static_dir = self._get_static_dir()
        file_path = os.path.join(static_dir, filename)
        try:
            with open(file_path, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            try:
                self.send_response(404)
                self.end_headers()
            except Exception:
                pass
        except Exception:
            pass

    def log_message(self, format, *args):
        pass

    @classmethod
    def broadcast(cls, data: dict):
        with cls.lock:
            if not cls.clients:
                return
            json_data = json.dumps(data, ensure_ascii=False)
            message = f"data: {json_data}\n\n".encode('utf-8')
            dead_clients = []
            for client in cls.clients:
                try:
                    client.wfile.write(message)
                    client.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    dead_clients.append(client)
            for client in dead_clients:
                cls.clients.remove(client)


class SSEServer:
    """SSE 服务器"""

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.server: Optional[ThreadingHTTPServer] = None
        self.thread: Optional[threading.Thread] = None
        self.logger = logging.getLogger(__name__)
        self.running = False

    def start(self):
        self.server = ThreadingHTTPServer((self.host, self.port), SSEHandler)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.running = True
        self.thread.start()
        self.logger.info(f"✅ SSE 服务器启动: http://{self.host}:{self.port}")

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
