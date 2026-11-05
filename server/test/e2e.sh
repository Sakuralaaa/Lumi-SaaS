#!/usr/bin/env bash
# Dev smoke test against a running API (assumes .env). Usage: bash test/e2e.sh
set -euo pipefail
B=http://localhost:8787; O=http://localhost:5173
H=(-H "Origin: $O" -H "X-Requested-With: lumi" -H "Content-Type: application/json")
source <(grep -E '^ADMIN_(EMAIL|PASSWORD)=' .env)
A=/tmp/admin.jar; U=/tmp/user.jar; rm -f $A $U
j(){ curl -s -b $1 -c $1 "${H[@]}" "${@:2}"; }
echo "login admin:"; j $A -X POST $B/api/auth/login -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"; echo
GROK=$(j $A -X POST $B/api/admin/channels -d '{"name":"Grok 中转","vendor":"grok2api","baseUrl":"https://grok-relay.example.com/v1","apiKey":"proxy-injected"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
GPT=$(j $A -X POST $B/api/admin/channels -d '{"name":"GPT 中转","vendor":"gptchat2api","baseUrl":"https://gpt-relay.example.com/v1","apiKey":"proxy-injected"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "sync:"; j $A -X POST $B/api/admin/channels/$GROK/sync -d "{}"; echo; j $A -X POST $B/api/admin/channels/$GPT/sync -d "{}"; echo
MODELS=$(j $A $B/api/admin/models)
mid(){ echo "$MODELS" | python3 -c "import sys,json;print([m['id'] for m in json.load(sys.stdin) if m['model_id']=='$1'][0])"; }
GM=$(mid grok-imagine-image-2.0); PM=$(mid gpt-image-2.5)
j $A -X PATCH $B/api/admin/models/$GM -d '{"enabled":true,"caps":{"ratios":["1:1","3:4","4:3","9:16","16:9"],"hd":true,"max_refs":3,"edit":true},"costStandardFen":4,"costHdFen":8}' >/dev/null
j $A -X PATCH $B/api/admin/models/$PM -d '{"enabled":true,"caps":{"ratios":["1:1","3:4","4:3","9:16","16:9"],"hd":false,"max_refs":4,"edit":true},"costStandardFen":8,"costHdFen":8}' >/dev/null
j $A -X POST $B/api/admin/bindings -d "{\"platformModelKey\":\"grok\",\"realModelId\":\"$GM\"}" >/dev/null
j $A -X POST $B/api/admin/bindings -d "{\"platformModelKey\":\"gpt\",\"realModelId\":\"$PM\"}" >/dev/null
CODE=$(j $A -X POST $B/api/admin/invites -d '{"count":1,"credits":200,"batch":"e2e"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["codes"][0])')
echo "invite $CODE"
EM="u$RANDOM@test.local"
echo "register:"; j $U -X POST $B/api/auth/register -d "{\"email\":\"$EM\",\"password\":\"test-pass-123\",\"inviteCode\":\"$CODE\"}"; echo
echo "reuse code (should fail):"; curl -s "${H[@]}" -X POST $B/api/auth/register -d "{\"email\":\"x$EM\",\"password\":\"test-pass-123\",\"inviteCode\":\"$CODE\"}"; echo
j $U $B/api/me; echo
P=$(j $U -X POST $B/api/projects -d '{"name":"精华液","mode":"simple"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
UP=$(curl -s -b $U -H "Origin: $O" -H "X-Requested-With: lumi" -F "file=@../../prototype/assets/product.jpg" $B/api/uploads)
echo "upload: ${UP:0:120}"
AID=$(echo "$UP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
JOB=$(j $U -X POST $B/api/jobs -d "{\"projectId\":\"$P\",\"prompt\":\"放在米色石台上，清晨暖光\",\"tags\":[\"scene\"],\"quality\":\"standard\",\"ratios\":[\"1:1\"],\"perRatio\":2,\"inputs\":[{\"assetId\":\"$AID\",\"role\":\"product\"}]}")
echo "job: $JOB"
JID=$(echo "$JOB" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
for i in $(seq 1 40); do
  S=$(j $U $B/api/jobs/$JID); ST=$(echo "$S" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
  echo "[$i] $ST"; [[ "$ST" == done || "$ST" == failed || "$ST" == partial ]] && break; sleep 5
done
echo "$S" | python3 -m json.tool | head -40
echo "P=$P JID=$JID" > /tmp/e2e.vars
