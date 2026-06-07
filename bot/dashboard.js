// bot/dashboard.js
// Express + Socket.IO 기반 실시간 웹 대시보드
// 브라우저에서 봇 상태를 모니터링합니다.

const http = require('http');

const PORT = 3000;

function createDashboard(bot, navigator, mobRadar, combatManager, gridMap) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHTML());
  });

  // SSE (Server-Sent Events) 로 실시간 업데이트
  const clients = new Set();

  const sseServer = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHTML());
  });

  // 매 500ms마다 클라이언트에 상태 전송
  setInterval(() => {
    const pos = bot.entity ? bot.entity.position : { x: 0, y: 0, z: 0 };
    const data = JSON.stringify({
      position: {
        x: Math.round(pos.x),
        y: Math.round(pos.y),
        z: Math.round(pos.z),
      },
      health: bot.health || 0,
      food: bot.food || 0,
      navStatus: navigator.getStatus(),
      combatStatus: combatManager.getStatus(),
      radarStatus: mobRadar.getStatus(),
      threats: mobRadar.getThreats().slice(0, 5).map(t => ({
        name: t.displayName,
        distance: t.distance,
        threatLevel: t.threatLevel,
      })),
      gridMap: gridMap ? gridMap.toJSON() : null,
      time: new Date().toLocaleTimeString('ko-KR'),
    });

    for (const client of clients) {
      client.write(`data: ${data}\n\n`);
    }
  }, 500);

  sseServer.listen(PORT, () => {
    console.log(`[Dashboard] 🌐 웹 대시보드: http://localhost:${PORT}`);
  });

  return sseServer;
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>ADAS Bot Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #0d1117;
      color: #e6edf3;
      padding: 24px;
    }
    h1 {
      font-size: 28px;
      margin-bottom: 20px;
      background: linear-gradient(90deg, #58a6ff, #bc8cff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 20px;
    }
    .card h2 {
      font-size: 14px;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 12px;
    }
    .card .value {
      font-size: 22px;
      font-weight: 600;
    }
    .threats-list {
      list-style: none;
    }
    .threats-list li {
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
      display: flex;
      justify-content: space-between;
    }
    .grid-container {
      display: flex;
      align-items: flex-start;
      gap: 16px;
    }
    #gridCanvas {
      border: 1px solid #30363d;
      border-radius: 8px;
      image-rendering: pixelated;
    }
    .grid-legend {
      font-size: 13px;
      line-height: 1.8;
    }
    .grid-legend span {
      display: inline-block;
      width: 14px; height: 14px;
      border-radius: 3px;
      vertical-align: middle;
      margin-right: 6px;
    }
    .dir-indicator {
      font-size: 15px;
      font-weight: 600;
      margin-top: 8px;
    }
    .dir-safe { color: #3fb950; }
    .dir-danger { color: #f85149; }
    .threat-high { color: #f85149; }
    .threat-mid  { color: #d29922; }
    .threat-low  { color: #3fb950; }
    .hp-bar {
      width: 100%;
      height: 20px;
      background: #21262d;
      border-radius: 10px;
      overflow: hidden;
      margin-top: 8px;
    }
    .hp-bar-fill {
      height: 100%;
      border-radius: 10px;
      transition: width 0.3s, background-color 0.3s;
    }
    #status-dot {
      display: inline-block;
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #3fb950;
      margin-right: 8px;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  </style>
</head>
<body>
  <h1><span id="status-dot"></span>ADAS Minecraft Bot Dashboard</h1>
  <div class="grid">
    <div class="card">
      <h2>📍 위치</h2>
      <div class="value" id="position">로딩 중...</div>
    </div>
    <div class="card">
      <h2>❤️ 체력</h2>
      <div class="value" id="health">—</div>
      <div class="hp-bar"><div class="hp-bar-fill" id="hp-fill"></div></div>
    </div>
    <div class="card">
      <h2>🚀 이동 상태</h2>
      <div class="value" id="nav">—</div>
    </div>
    <div class="card">
      <h2>🛡 전투 상태</h2>
      <div class="value" id="combat">—</div>
    </div>
    <div class="card" style="grid-column: 1 / -1;">
      <h2>🗺️ Local Grid Map (5블록 반경)</h2>
      <div class="grid-container">
        <canvas id="gridCanvas" width="220" height="220"></canvas>
        <div>
          <div class="grid-legend">
            <div><span style="background:#2d4a2d"></span> 안전 (SAFE)</div>
            <div><span style="background:#6b5030"></span> 장애물 (BLOCKED)</div>
            <div><span style="background:#cc3333"></span> 위험 지형</div>
            <div><span style="background:#ff2222"></span> 적대 몹</div>
            <div><span style="background:#1a1a1a"></span> 미확인</div>
          </div>
          <div class="dir-indicator" id="dirSafety">—</div>
          <div style="margin-top:8px;color:#8b949e;font-size:12px;" id="gridStats">—</div>
        </div>
      </div>
    </div>
    <div class="card" style="grid-column: 1 / -1;">
      <h2>📡 위협 레이더</h2>
      <div id="radar-status" style="margin-bottom:8px;">—</div>
      <ul class="threats-list" id="threats"></ul>
    </div>
  </div>
  <script>
    // 그리드 맵 셀 색상
    const CELL_COLORS = ['#2d4a2d', '#6b5030', '#cc3333', '#ff2222', '#1a1a1a'];
    const gridCanvas = document.getElementById('gridCanvas');
    const gridCtx = gridCanvas.getContext('2d');

    function renderGridMap(gm) {
      if (!gm || !gm.grid) {
        gridCtx.fillStyle = '#0d1117';
        gridCtx.fillRect(0, 0, 220, 220);
        gridCtx.fillStyle = '#8b949e';
        gridCtx.font = '14px Segoe UI';
        gridCtx.fillText('GridMap 대기 중...', 40, 110);
        return;
      }

      const size = gm.gridSize || 11;
      const cellPx = Math.floor(220 / size);
      const center = Math.floor(size / 2);

      // 셀 렌더링
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const val = gm.grid[r] ? gm.grid[r][c] : 4;
          gridCtx.fillStyle = CELL_COLORS[val] || '#1a1a1a';
          gridCtx.fillRect(c * cellPx, r * cellPx, cellPx - 1, cellPx - 1);
        }
      }

      // 봇 위치 (중앙, 시안 삼각형)
      const botPx = center * cellPx + cellPx / 2;
      const botPy = center * cellPx + cellPx / 2;
      const yaw = gm.botYaw || 0;
      const arrowLen = cellPx * 0.9;

      gridCtx.fillStyle = '#32d2fa';
      gridCtx.beginPath();
      gridCtx.moveTo(
        botPx - Math.sin(yaw) * arrowLen,
        botPy - Math.cos(yaw) * arrowLen
      );
      gridCtx.lineTo(
        botPx - Math.sin(yaw + 2.4) * (arrowLen * 0.5),
        botPy - Math.cos(yaw + 2.4) * (arrowLen * 0.5)
      );
      gridCtx.lineTo(
        botPx - Math.sin(yaw - 2.4) * (arrowLen * 0.5),
        botPy - Math.cos(yaw - 2.4) * (arrowLen * 0.5)
      );
      gridCtx.closePath();
      gridCtx.fill();
      
      // 경로 렌더링 (진행 예정인 노드)
      if (gm.pathCells) {
        gridCtx.fillStyle = 'rgba(255, 215, 0, 0.6)';
        for (const p of gm.pathCells) {
          gridCtx.fillRect(p.col * cellPx, p.row * cellPx, cellPx - 1, cellPx - 1);
        }
      }
      // 몹 위치에 X 마커
      gridCtx.strokeStyle = '#ff4444';
      gridCtx.lineWidth = 2;
      if (gm.mobCells) {
        for (const mob of gm.mobCells) {
          const mx = mob.col * cellPx + cellPx / 2;
          const my = mob.row * cellPx + cellPx / 2;
          gridCtx.beginPath();
          gridCtx.moveTo(mx - 5, my - 5); gridCtx.lineTo(mx + 5, my + 5);
          gridCtx.moveTo(mx + 5, my - 5); gridCtx.lineTo(mx - 5, my + 5);
          gridCtx.stroke();
        }
      }

      // 방향 안전성 표시
      const ds = gm.directionSafety || {};
      const dirNames = {forward: '전방', left: '좌', right: '우', back: '후방'};
      let dirHtml = '';
      for (const [key, label] of Object.entries(dirNames)) {
        const safe = (ds[key] || 0) <= 0;
        dirHtml += '<span class="' + (safe ? 'dir-safe' : 'dir-danger') + '">';
        dirHtml += label + ':' + (safe ? 'SAFE' : 'DANGER') + '</span>  ';
      }
      document.getElementById('dirSafety').innerHTML = dirHtml;

      // 통계
      const dc = gm.dangerCount || {};
      document.getElementById('gridStats').textContent =
        'Terrain:' + (dc.terrain||0) + ' Mob:' + (dc.mob||0) + ' Block:' + (dc.blocked||0) + ' Total:' + (dc.total||0);
    }

    const es = new EventSource('/events');
    es.onmessage = (e) => {
      const d = JSON.parse(e.data);
      document.getElementById('position').textContent =
        'X: ' + d.position.x + '  Y: ' + d.position.y + '  Z: ' + d.position.z;
      document.getElementById('health').textContent = d.health + ' / 20';
      const hpPct = (d.health / 20 * 100);
      const fill = document.getElementById('hp-fill');
      fill.style.width = hpPct + '%';
      fill.style.backgroundColor = hpPct > 60 ? '#3fb950' : hpPct > 30 ? '#d29922' : '#f85149';
      document.getElementById('nav').textContent = d.navStatus;
      document.getElementById('combat').textContent = d.combatStatus;
      document.getElementById('radar-status').textContent = d.radarStatus;

      // 그리드 맵 렌더링
      renderGridMap(d.gridMap);

      const list = document.getElementById('threats');
      if (d.threats.length === 0) {
        list.innerHTML = '<li style="color:#8b949e">근처에 적대적 몹 없음</li>';
      } else {
        list.innerHTML = d.threats.map(t => {
          const cls = t.threatLevel > 3 ? 'threat-high' : t.threatLevel > 1 ? 'threat-mid' : 'threat-low';
          return '<li class="' + cls + '"><span>' + t.name + ' (' + t.distance + 'm)</span><span>위협: ' + t.threatLevel + '</span></li>';
        }).join('');
      }
    };
  </script>
</body>
</html>`;
}

module.exports = { createDashboard };
