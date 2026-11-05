#!/usr/bin/env bash
# Fresh dev env: add both relay channels, sync, enable models, bind. No generation (free).
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
j $A -X PATCH $B/api/admin/models/$GM -d '{"enabled":true,"caps":{"ratios":["1:1","3:4","4:3","9:16","16:9"],"hd":true,"max_refs":3,"edit":true,"transparent":false,"mask":false,"n_max":4},"costStandardFen":4,"costHdFen":8}' >/dev/null
j $A -X PATCH $B/api/admin/models/$PM -d '{"enabled":true,"caps":{"ratios":["1:1","3:4","4:3","9:16","16:9"],"hd":false,"max_refs":4,"edit":true,"transparent":true,"mask":false,"n_max":3},"costStandardFen":8,"costHdFen":8}' >/dev/null
j $A -X POST $B/api/admin/bindings -d "{\"platformModelKey\":\"grok\",\"realModelId\":\"$GM\"}" >/dev/null
j $A -X POST $B/api/admin/bindings -d "{\"platformModelKey\":\"gpt\",\"realModelId\":\"$PM\"}" >/dev/null
echo "setup done"
