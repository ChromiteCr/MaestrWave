"""
手机遥控指挥的 WebSocket 中转（M4）。

架构说明——后端在这里只做**纯转发**，不解析手势、不落盘、不碰 project：

    手机（遥控端 remote）  --原始传感器采样-->  后端 room  -->  电脑（舞台端 stage）
                          <--连接状态/心跳---

手势解析（打拍检测、density 方差、角色激活度）放在**舞台端**而不是手机端，
原因是那套算法依赖 60 帧历史窗口和项目的 baseBpm，而项目数据在舞台端。
手机保持"哑终端"，以后调算法不用改手机侧代码。

房间状态全部在内存里，进程重启即失效——这是有意的，指挥连接本来就是
临时的，没有持久化的必要。
"""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import WebSocket

logger = logging.getLogger(__name__)

# 一个房间里最多允许几个遥控端。允许 >1 是为了将来多人协作指挥，
# 目前 UI 只会连一个。
MAX_REMOTES_PER_ROOM = 4


@dataclass
class ConductRoom:
    room_id: str
    stage: Optional[WebSocket] = None
    remotes: Dict[str, WebSocket] = field(default_factory=dict)

    def is_empty(self) -> bool:
        return self.stage is None and not self.remotes


class ConductHub:
    def __init__(self) -> None:
        self._rooms: Dict[str, ConductRoom] = {}
        self._lock = asyncio.Lock()

    # ---------- 连接管理 ----------

    async def join(self, room_id: str, role: str, ws: WebSocket) -> str:
        """接受连接并登记。返回该连接的 peer_id。"""
        await ws.accept()
        async with self._lock:
            room = self._rooms.setdefault(room_id, ConductRoom(room_id=room_id))

            if role == "stage":
                # 同一个房间只允许一个舞台端；新的顶掉旧的（比如电脑刷新了页面）。
                old = room.stage
                room.stage = ws
                peer_id = "stage"
                if old is not None:
                    await _safe_send(old, {"t": "replaced"})
                    await _safe_close(old)
            else:
                if len(room.remotes) >= MAX_REMOTES_PER_ROOM:
                    await _safe_send(ws, {"t": "error", "message": "房间遥控端已满"})
                    await _safe_close(ws)
                    raise RuntimeError("room full")
                peer_id = uuid.uuid4().hex[:8]
                room.remotes[peer_id] = ws

            snapshot = (room.stage, dict(room.remotes))

        stage_ws, remotes = snapshot
        if role == "stage":
            # 舞台端上线，告诉已经在等的手机可以开始了。
            for rid, rws in remotes.items():
                await _safe_send(rws, {"t": "stage_ready"})
            await _safe_send(ws, {"t": "joined", "role": "stage", "remotes": len(remotes)})
        else:
            await _safe_send(ws, {"t": "joined", "role": "remote", "peer": peer_id})
            # 手机先到、电脑还没开的情况要明确告诉手机，否则它会一直"连着但没反应"。
            await _safe_send(ws, {"t": "stage_ready" if stage_ws else "no_stage"})
            if stage_ws is not None:
                await _safe_send(stage_ws, {"t": "remote_joined", "peer": peer_id})

        logger.info("conduct: %s joined room=%s peer=%s", role, room_id, peer_id)
        return peer_id

    async def leave(self, room_id: str, role: str, peer_id: str) -> None:
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                return
            if role == "stage":
                room.stage = None
            else:
                room.remotes.pop(peer_id, None)
            stage_ws = room.stage
            remotes = dict(room.remotes)
            if room.is_empty():
                self._rooms.pop(room_id, None)

        if role == "stage":
            # 舞台端断了，手机继续挥也没意义，明确告知。
            for rws in remotes.values():
                await _safe_send(rws, {"t": "stage_gone"})
        elif stage_ws is not None:
            await _safe_send(stage_ws, {"t": "remote_left", "peer": peer_id})

        logger.info("conduct: %s left room=%s peer=%s", role, room_id, peer_id)

    # ---------- 消息转发 ----------

    async def relay_from_remote(self, room_id: str, peer_id: str, payload: dict) -> None:
        """手机 → 舞台端。舞台端不在就直接丢弃（不排队，实时数据过期即无用）。"""
        async with self._lock:
            room = self._rooms.get(room_id)
            stage_ws = room.stage if room else None
        if stage_ws is not None:
            payload["peer"] = peer_id
            await _safe_send(stage_ws, payload)

    async def relay_from_stage(self, room_id: str, payload: dict) -> None:
        """舞台端 → 所有手机（状态回传，比如"已开始播放"）。"""
        async with self._lock:
            room = self._rooms.get(room_id)
            remotes = dict(room.remotes) if room else {}
        for rws in remotes.values():
            await _safe_send(rws, payload)

    def room_stats(self) -> dict:
        return {
            rid: {"stage": room.stage is not None, "remotes": len(room.remotes)}
            for rid, room in self._rooms.items()
        }


async def _safe_send(ws: WebSocket, payload: dict) -> None:
    try:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))
    except Exception:
        # 对端可能已经断开，转发失败不该影响其它连接。
        pass


async def _safe_close(ws: WebSocket) -> None:
    try:
        await ws.close()
    except Exception:
        pass


hub = ConductHub()
