#!/bin/bash
MCP_URL="http://127.0.0.1:3001/sse"
BASE="${MCP_URL%/sse}"
SSE_FILE=$(mktemp)
curl -sN --no-buffer "$MCP_URL" > "$SSE_FILE" &
CPID=$!
# 等 endpoint 事件 (最多6秒)
ep=""; d=$((SECONDS+6))
while [ $SECONDS -lt $d ]; do
  ep=$(grep -m1 '^data: ' "$SSE_FILE" 2>/dev/null | sed 's/^data: //')
  [ -n "$ep" ] && break; sleep 0.1
done
echo "ENDPOINT: $ep"
[ -z "$ep" ] && { echo "SSE TIMEOUT"; kill $CPID 2>/dev/null; exit 1; }
# initialize
ID1=$((RANDOM*1000+1))
INIT='{"jsonrpc":"2.0","id":'$ID1',"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bash","version":"1.0"}}}'
curl -s -m 5 -X POST "$BASE$ep" -H 'Content-Type: application/json' -d "$INIT" -o /dev/null
# 等 initialize 响应
got=""; d=$((SECONDS+6))
while [ $SECONDS -lt $d ]; do
  got=$(grep '"id":'$ID1 $SSE_FILE 2>/dev/null | head -1)
  [ -n "$got" ] && break; sleep 0.1
done
echo "INIT RESP: $(echo "$got" | head -c 120)"
# tools/call
ID2=$((ID1+1))
BODY='{"jsonrpc":"2.0","id":'$ID2',"method":"tools/call","params":{"name":"shell","arguments":{"command":"echo mcp_bash_works"}}}'
curl -s -m 30 -X POST "$BASE$ep" -H 'Content-Type: application/json' -d "$BODY" -o /dev/null
got=""; d=$((SECONDS+10))
while [ $SECONDS -lt $d ]; do
  got=$(grep '"id":'$ID2 $SSE_FILE 2>/dev/null | head -1)
  [ -n "$got" ] && break; sleep 0.1
done
echo "TOOL RESP: $(echo "$got" | head -c 300)"
kill $CPID 2>/dev/null; rm -f "$SSE_FILE"
